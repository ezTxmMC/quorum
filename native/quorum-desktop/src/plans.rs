use crate::{
    editor::{CodeEditor, EditorEvent},
    input::TextInput,
    theme::*,
};
use gpui::{prelude::*, *};
use quorum_core::{
    jobs::Runtime,
    plan::{Plan, PlanStore, Summary},
};
use std::{
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

pub struct NativePlans {
    data: PathBuf,
    root: String,
    provider: String,
    model: Entity<TextInput>,
    objective: Entity<CodeEditor>,
    task_title: Entity<TextInput>,
    task_description: Entity<CodeEditor>,
    editing: Option<usize>,
    plans: Vec<Summary>,
    selected: Option<Plan>,
    runtime: Option<Arc<Mutex<Runtime>>>,
    busy: bool,
    generating: bool,
    error: String,
    task: Option<Task<()>>,
    generation: Option<Task<()>>,
    _objective_event: Subscription,
}
impl NativePlans {
    pub fn new(data: PathBuf, cx: &mut Context<Self>) -> Self {
        let objective = cx.new(CodeEditor::composer);
        let model = cx.new(|cx| TextInput::new("Modell-ID", cx));
        model.update(cx, |input, cx| {
            input.set_value("claude-fable-5-2".into(), cx)
        });
        let task_title = cx.new(|cx| TextInput::new("Aufgabentitel", cx));
        let task_description = cx.new(|cx| CodeEditor::new(String::new(), cx));
        let event = cx.subscribe(&objective, |view, _, event: &EditorEvent, cx| {
            if matches!(event, EditorEvent::Submitted) {
                view.generate(cx);
            }
        });
        let mut view = Self {
            data,
            root: String::new(),
            provider: "claude".into(),
            model,
            objective,
            task_title,
            task_description,
            editing: None,
            plans: Vec::new(),
            selected: None,
            runtime: None,
            busy: false,
            generating: false,
            error: String::new(),
            task: None,
            generation: None,
            _objective_event: event,
        };
        view.refresh(None, cx);
        view
    }
    pub fn connect(&mut self, runtime: Arc<Mutex<Runtime>>) {
        self.runtime = Some(runtime);
    }
    pub fn context(
        &mut self,
        root: String,
        provider: String,
        model: String,
        cx: &mut Context<Self>,
    ) {
        self.root = root;
        self.provider = provider;
        self.model
            .update(cx, |input, cx| input.set_value(model, cx));
        cx.notify();
    }
    pub fn is_dirty(&self, cx: &App) -> bool {
        let (Some(plan), Some(index)) = (&self.selected, self.editing) else {
            return false;
        };
        self.task_title.read(cx).value()
            != plan.definition["tasks"][index]["title"]
                .as_str()
                .unwrap_or("")
            || self.task_description.read(cx).text()
                != plan.definition["tasks"][index]["description"]
                    .as_str()
                    .unwrap_or("")
    }
    fn refresh(&mut self, id: Option<String>, cx: &mut Context<Self>) {
        if self.is_dirty(cx) {
            self.error = "Änderungen zuerst speichern oder verwerfen.".into();
            cx.notify();
            return;
        }
        if self.busy {
            return;
        }
        let path = self.data.join("plans.sqlite");
        self.busy = true;
        let task = cx.background_executor().spawn(async move {
            let store = PlanStore::open(&path)?;
            Ok::<_, io::Error>((store.list()?, id.map(|id| store.get(&id)).transpose()?))
        });
        self.task = Some(cx.spawn(async move |view, cx| {
            let result = task.await;
            let _ = view.update(cx, |view, cx| {
                view.busy = false;
                match result {
                    Ok((plans, selected)) => {
                        view.plans = plans;
                        if let Some(plan) = selected {
                            view.root = plan.summary.root.clone();
                            view.selected = Some(plan);
                            view.editing = None;
                        }
                        view.error.clear();
                    }
                    Err(error) => view.error = error.to_string(),
                }
                cx.notify();
            });
        }));
    }
    fn generate(&mut self, cx: &mut Context<Self>) {
        if self.generating || self.busy {
            return;
        }
        let Some(runtime) = self.runtime.clone() else {
            return;
        };
        let root = PathBuf::from(&self.root);
        let provider = self.provider.clone();
        let model = self.model.read(cx).value();
        let objective = self.objective.read(cx).value();
        if self.root.is_empty() || objective.trim().is_empty() {
            self.error = "Projektordner wählen und das Ziel des Plans beschreiben.".into();
            cx.notify();
            return;
        }
        let host = crate::workbench::host_path();
        let worker = match std::env::current_exe() {
            Ok(path) => path,
            Err(error) => {
                self.error = error.to_string();
                return;
            }
        };
        self.generating = true;
        self.error.clear();
        let launch = cx.background_executor().spawn({
            let runtime = runtime.clone();
            async move {
                runtime
                    .lock()
                    .map_err(|_| io::Error::other("Runtime lock poisoned"))?
                    .start_plan(&root, &provider, &model, &objective, &host, &worker)
            }
        });
        let database = self.data.join("plans.sqlite");
        self.generation = Some(cx.spawn(async move |view, cx| {
            let chat = match launch.await {
                Ok(chat) => chat,
                Err(error) => {
                    let _ = view.update(cx, |view, cx| {
                        view.generating = false;
                        view.error = error.to_string();
                        cx.notify();
                    });
                    return;
                }
            };
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(500))
                    .await;
                let runtime = runtime.clone();
                let chat = chat.clone();
                let database = database.clone();
                let result = cx
                    .background_executor()
                    .spawn(async move {
                        let mut runtime = runtime
                            .lock()
                            .map_err(|_| io::Error::other("Runtime lock poisoned"))?;
                        runtime.tick()?;
                        let metadata = runtime.plan_generation(&chat)?;
                        if metadata["finished"] != true {
                            return Ok(None);
                        }
                        if let Some(error) = metadata["error"].as_str() {
                            return Err(io::Error::other(error));
                        }
                        let id = metadata["result"]
                            .as_str()
                            .ok_or_else(|| io::Error::other("Planergebnis fehlt"))?;
                        let store = PlanStore::open(&database)?;
                        Ok::<_, io::Error>(Some((store.list()?, store.get(id)?)))
                    })
                    .await;
                match result {
                    Ok(None) => {}
                    Ok(Some((plans, plan))) => {
                        let _ = view.update(cx, |view, cx| {
                            view.generating = false;
                            view.plans = plans;
                            view.selected = Some(plan);
                            view.editing = None;
                            cx.notify();
                        });
                        return;
                    }
                    Err(error) => {
                        let _ = view.update(cx, |view, cx| {
                            view.generating = false;
                            view.error = error.to_string();
                            cx.notify();
                        });
                        return;
                    }
                }
            }
        }));
        cx.notify();
    }
    fn edit(&mut self, index: usize, cx: &mut Context<Self>) {
        if self.is_dirty(cx) {
            self.error = "Änderungen zuerst speichern oder verwerfen.".into();
            cx.notify();
            return;
        }
        let Some(task) = self
            .selected
            .as_ref()
            .and_then(|plan| plan.definition["tasks"].as_array())
            .and_then(|tasks| tasks.get(index))
        else {
            return;
        };
        self.task_title.update(cx, |input, cx| {
            input.set_value(task["title"].as_str().unwrap_or("").into(), cx)
        });
        self.task_description.update(cx, |input, cx| {
            input.set_value(task["description"].as_str().unwrap_or("").into(), cx)
        });
        self.editing = Some(index);
        cx.notify();
    }
    fn save_task(&mut self, cx: &mut Context<Self>) {
        let (Some(mut plan), Some(index)) = (self.selected.clone(), self.editing) else {
            return;
        };
        plan.definition["tasks"][index]["title"] = self.task_title.read(cx).value().into();
        plan.definition["tasks"][index]["description"] =
            self.task_description.read(cx).value().into();
        self.mutate(
            move |store| {
                store.save(
                    Some(&plan.summary.id),
                    Some(&plan.revision_id),
                    Path::new(&plan.summary.root),
                    &plan.summary.title,
                    &plan.definition,
                )
            },
            cx,
        );
    }
    fn approve(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.editing.is_some() {
            return;
        }
        let Some(plan) = self.selected.clone() else {
            return;
        };
        let answer=window.prompt(PromptLevel::Info,"Aktuelle Planrevision freigeben?",Some("Die Freigabe gilt für genau diese Revision und erlaubt ausschließlich lesenden Zugriff. Sie startet keine Ausführung und erteilt keine Schreib- oder Shellrechte."),&["Abbrechen","Revision freigeben"],cx);
        self.busy = true;
        self.task = Some(cx.spawn(async move |view, cx| {
            let approved = answer.await.unwrap_or(0) == 1;
            let _ = view.update(cx, |view, cx| {
                view.busy = false;
                if approved {
                    view.mutate(
                        move |store| store.approve(&plan.summary.id, &plan.revision_id),
                        cx,
                    );
                }
                cx.notify();
            });
        }));
    }
    fn mutate(
        &mut self,
        operation: impl FnOnce(&mut PlanStore) -> io::Result<Plan> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        if self.busy {
            return;
        }
        self.busy = true;
        let path = self.data.join("plans.sqlite");
        let task = cx.background_executor().spawn(async move {
            let mut store = PlanStore::open(&path)?;
            let plan = operation(&mut store)?;
            Ok::<_, io::Error>((store.list()?, plan))
        });
        self.task = Some(cx.spawn(async move |view, cx| {
            let result = task.await;
            let _ = view.update(cx, |view, cx| {
                view.busy = false;
                match result {
                    Ok((plans, plan)) => {
                        view.plans = plans;
                        view.selected = Some(plan);
                        view.editing = None;
                        view.error.clear();
                    }
                    Err(error) => view.error = error.to_string(),
                }
                cx.notify();
            });
        }));
        cx.notify();
    }
}
impl Render for NativePlans {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let view = cx.entity();
        let plans = self.plans.clone();
        div().size_full().flex().flex_col().bg(rgb(BG))
            .child(div().h(px(42.)).px_3().flex_shrink_0().flex().items_center().gap_2().border_b_1().border_color(rgb(EDGE))
                .child(icon("files",16.)).child("Plan & IDE").child(div().flex_1())
                .child(button("refresh-plans","Aktualisieren","chevron-down").on_click(cx.listener(|view,_,_,cx|view.refresh(view.selected.as_ref().map(|plan|plan.summary.id.clone()),cx))))
                .child(button("new-plan","Neuer Plan","plus").on_click(cx.listener(|view,_,_,cx|{if view.is_dirty(cx){view.error="Änderungen zuerst speichern oder verwerfen.".into();cx.notify();return;}view.selected=None;view.editing=None;cx.notify();}))))
            .child(div().flex_1().min_h_0().flex()
                .child(div().w(px(210.)).flex_shrink_0().border_r_1().border_color(rgb(EDGE)).bg(rgb(SURFACE))
                    .child(uniform_list("plans",plans.len(),move|range,_,_|range.map(|index|{
                        let plan=plans[index].clone();let view=view.clone();
                        div().id(index).h(px(56.)).p_3().flex().flex_col().gap_1().cursor_pointer().hover(|s|s.bg(rgb(HOVER)))
                            .on_click(move|_,_,cx|view.update(cx,|view,cx|view.refresh(Some(plan.id.clone()),cx)))
                            .child(div().text_size(px(12.)).text_ellipsis().child(plans[index].title.clone()))
                            .child(div().text_size(px(10.)).text_color(rgb(SUBTLE)).child(plans[index].status.clone()))
                    }).collect()).size_full()))
                .child(div().id("plan-body").flex_1().min_w_0().overflow_y_scroll().p_4().flex().flex_col().gap_3()
                    .child(if let Some(plan)=self.selected.clone(){
                        let tasks=plan.definition["tasks"].as_array().cloned().unwrap_or_default();
                        div().flex().flex_col().gap_3()
                            .child(div().text_size(px(20.)).font_weight(FontWeight::SEMIBOLD).child(plan.summary.title))
                            .child(div().text_color(rgb(MUTED)).child(format!("Revision {} · {} · {}",plan.revision,plan.summary.status,plan.summary.root)))
                            .child(plan.definition["objective"].as_str().unwrap_or("").to_owned())
                            .child(button("approve-plan","Revision freigeben","check").on_click(cx.listener(|view,_,window,cx|view.approve(window,cx))))
                            .children(tasks.into_iter().enumerate().map(|(index,task)|{
                                div().id(index).p_3().border_1().border_color(rgb(EDGE)).rounded(px(10.)).flex().flex_col().gap_2()
                                    .child(div().font_weight(FontWeight::SEMIBOLD).child(format!("{}. {}",index+1,task["title"].as_str().unwrap_or(""))))
                                    .child(div().text_color(rgb(MUTED)).child(task["description"].as_str().unwrap_or("").to_owned()))
                                    .children(task["acceptanceCriteria"].as_array().into_iter().flatten().map(|criterion|div().text_size(px(12.)).text_color(rgb(SUBTLE)).child(format!("□ {}",criterion["description"].as_str().unwrap_or("")))))
                                    .child(button("edit-task","Bearbeiten","code-2").on_click(cx.listener(move|view,_,_,cx|view.edit(index,cx))))
                            })).into_any_element()
                    }else{
                        div().flex().flex_col().gap_3()
                            .child(div().text_size(px(22.)).font_weight(FontWeight::SEMIBOLD).child("Mit KI einen Plan erstellen"))
                            .child(div().text_color(rgb(MUTED)).child("Ziel beschreiben → Modell wählen → Plan prüfen → Revision freigeben"))
                            .child(div().text_size(px(12.)).text_color(rgb(SUBTLE)).child(format!("Projekt: {}",self.root)))
                            .child(self.objective.clone())
                            .child(button("plan-provider","Anbieter wechseln","chevron-down").child(self.provider.clone()).on_click(cx.listener(|view,_,_,cx|{
                                view.provider=if view.provider=="claude"{"codex"}else{"claude"}.into();
                                view.model.update(cx,|input,cx|input.set_value(if view.provider=="claude"{"claude-fable-5-2"}else{""}.into(),cx));cx.notify();
                            })))
                            .child(self.model.clone())
                            .child(button("generate-plan",if self.generating{"Plan wird erstellt …"}else{"Mit KI planen"},"arrow-up").bg(rgb(ACTIVE)).on_click(cx.listener(|view,_,_,cx|view.generate(cx))))
                            .into_any_element()
                    })
                    .when(self.editing.is_some(),|d|d.child(div().flex().flex_col().gap_2().p_3().border_1().border_color(rgb(ACCENT)).rounded(px(8.))
                        .child(self.task_title.clone()).child(div().h(px(180.)).child(self.task_description.clone()))
                        .child(button("discard-task","Änderungen verwerfen","x").on_click(cx.listener(|view,_,_,cx|{view.editing=None;view.error.clear();cx.notify();})))
                        .child(button("save-task","Neue Revision speichern","check").on_click(cx.listener(|view,_,_,cx|view.save_task(cx))))))
                    .when(!self.error.is_empty(),|d|d.child(div().p_3().text_color(rgb(0xf87171)).child(self.error.clone())))))
    }
}
