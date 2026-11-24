use super::*;
use crate::theme::*;
use gpui::*;
impl Workbench {
    pub(super) fn start_team(&mut self, cx: &mut Context<Self>) {
        let objective = self.team_prompt.read(cx).value();
        if objective.trim().is_empty() {
            self.status = "Beschreibe die Aufgabe für das Agententeam.".into();
            cx.notify();
            return;
        }
        let root = PathBuf::from(self.workspace.read(cx).value());
        let claude = self.team_claude.read(cx).value();
        let codex = self.team_codex.read(cx).value();
        let worker = match std::env::current_exe() {
            Ok(path) => path,
            Err(error) => {
                self.status = error.to_string().into();
                return;
            }
        };
        let host = host_path();
        self.operate(
            move |runtime| {
                runtime.start_team(&root, &objective, &claude, &codex, &host, &worker)?;
                Ok(None)
            },
            None,
            cx,
        );
    }
    pub(super) fn agents_view(&self, cx: &mut Context<Self>) -> AnyElement {
        let sessions = self
            .archive
            .sessions
            .iter()
            .enumerate()
            .filter(|(_, session)| {
                self.active.contains(&session.id) || session.native_group.is_object()
            })
            .collect::<Vec<_>>();
        div().id("agent-workspace").flex_1().min_w_0().h_full().overflow_y_scroll().p_4().flex().flex_col().gap_3()
            .child(div().text_size(px(20.)).font_weight(FontWeight::SEMIBOLD).child("Agenten & Prozesse"))
            .child(div().text_color(rgb(MUTED)).child(format!("{} aktive Chats · jeder Chat mit eigenem Rust-Prozess",self.active.len())))
            .child(div().p_3().border_1().border_color(rgb(EDGE)).rounded(px(10.)).flex().flex_col().gap_2()
                .child(div().font_weight(FontWeight::MEDIUM).child("Zwei Modelle parallel analysieren lassen"))
                .child(div().text_size(px(12.)).text_color(rgb(SUBTLE)).child("Claude untersucht die Umsetzung, Codex prüft Risiken und Tests. Beide arbeiten nur lesend im gewählten Projekt."))
                .child(self.team_prompt.clone())
                .child(div().flex().gap_2().child(div().flex_1().child(self.team_claude.clone())).child(div().flex_1().child(self.team_codex.clone())))
                .child(button("start-analysis-team","Analyse-Team starten","network").bg(rgb(ACTIVE)).on_click(cx.listener(|view,_,_,cx|view.start_team(cx)))))
            .child(button("stop-all-processes","Alle aktiven Chats stoppen","square").on_click(cx.listener(|view,_,_,cx|view.operate(|runtime|{runtime.stop_all()?;Ok(None)},None,cx))))
            .children(sessions.into_iter().map(|(index,session)|{
                let active=self.active.contains(&session.id);let stop_id=session.id.clone();
                let process=self.processes.iter().find(|process|process.chat_id==session.id);
                let tools=session.messages.iter().flat_map(|message|message.blocks.iter()).filter(|block|block.kind=="tool"&&matches!(block.name.as_deref(),Some("Task"|"Agent"))).collect::<Vec<_>>();
                div().border_l_2().border_color(rgb(if active{ACCENT}else{EDGE})).pl_4().py_2().flex().flex_col().gap_2()
                    .child(div().p_3().rounded(px(10.)).border_1().border_color(rgb(EDGE)).bg(rgb(SURFACE)).flex().flex_col().gap_2()
                        .child(div().flex().items_center().gap_2()
                            .child(div().size(px(7.)).rounded_full().bg(rgb(if active{0x4ade80}else{SUBTLE})))
                            .child(div().flex_1().min_w_0().text_ellipsis().child(session.title.clone()))
                            .child(button("inspect-agent","Chat öffnen","external-link").on_click(cx.listener(move|view,_,_,cx|{view.select(index,cx);view.agents_open=false;view.ide_open=false;view.plans_open=false;cx.notify();})))
                            .when(active,|d|d.child(button("stop-agent","Stopp","square").on_click(cx.listener(move|view,_,_,cx|{let id=stop_id.clone();view.operate(move|runtime|{runtime.stop(&id)?;Ok(None)},None,cx);})))) )
                        .child(div().text_size(px(11.)).text_color(rgb(MUTED)).child(format!("{} · {}",session.provider,session.options["model"].as_str().unwrap_or("Standardmodell"))))
                        .when_some(process,|d,process|d.child(div().text_size(px(11.)).text_color(rgb(SUBTLE)).child(format!("{} · Supervisor {} · Worker {} · {} s",process.status,process.pid.map_or("—".into(),|pid|pid.to_string()),process.worker_pid.map_or("—".into(),|pid|pid.to_string()),process.age_ms/1000)))))
                    .children(tools.into_iter().map(|tool|div().ml_4().p_2().border_1().border_color(rgb(EDGE)).rounded(px(6.)).text_size(px(12.)).text_color(rgb(MUTED)).child(tool.input["description"].as_str().or_else(||tool.input["prompt"].as_str()).unwrap_or("Unteragent").chars().take(180).collect::<String>())))
            })).into_any_element()
    }
}
