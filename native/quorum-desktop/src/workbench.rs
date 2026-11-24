mod agents;
mod attachments;
mod message;
mod shell;
use crate::editor::{CodeEditor, EditorEvent};
use crate::ide::{InsertPath, NativeIde};
use crate::input::TextInput;
use gpui::{Context, Entity, Render, SharedString, Subscription, Task, Window, prelude::*};
use quorum_core::{
    archive::Archive,
    jobs::{Runtime, Snapshot},
};
use std::collections::{HashMap, HashSet};
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

type NativeRuntime = Arc<Mutex<Runtime>>;

enum PollUpdate {
    Snapshot(Snapshot, Option<String>),
    Processes(Vec<quorum_core::jobs::ProcessInfo>),
}

pub struct Workbench {
    directory: PathBuf,
    archive: Arc<Archive>,
    runtime: Option<NativeRuntime>,
    selected: Option<usize>,
    status: SharedString,
    active: Vec<String>,
    processes: Vec<quorum_core::jobs::ProcessInfo>,
    agents_open: bool,
    team_prompt: Entity<CodeEditor>,
    team_claude: Entity<TextInput>,
    team_codex: Entity<TextInput>,
    _team_event: Subscription,
    revision: u64,
    generation: u64,
    busy: bool,
    closing: bool,
    provider: String,
    scroll: gpui::ListState,
    follow: bool,
    drafts: HashMap<String, String>,
    file_drafts: HashMap<String, Vec<quorum_core::workspace::attachments::ChatFile>>,
    files: Vec<quorum_core::workspace::attachments::ChatFile>,
    file_task: Option<Task<()>>,
    loading_files: bool,
    preview: Option<attachments::Preview>,
    ide: Entity<NativeIde>,
    plans: Entity<crate::plans::NativePlans>,
    plans_open: bool,
    ide_open: bool,
    sidebar_open: bool,
    collapsed_projects: HashSet<String>,
    options_open: bool,
    search: Entity<TextInput>,
    picker: Option<Task<()>>,
    _ide_event: Subscription,
    composer: Entity<CodeEditor>,
    workspace: Entity<TextInput>,
    model: Entity<TextInput>,
    claude_binary: Entity<TextInput>,
    codex_binary: Entity<TextInput>,
    title_input: Entity<TextInput>,
    read_only: bool,
    confirmation: Option<Task<()>>,
    _submitted: Subscription,
    _search_event: Subscription,
    task: Option<Task<()>>,
    polling: Option<Task<()>>,
    selection: Option<Task<()>>,
}

impl Workbench {
    pub fn new(directory: PathBuf, cx: &mut Context<Self>) -> Self {
        let team_prompt = cx.new(CodeEditor::composer);
        let team_claude = cx.new(|cx| TextInput::new("Claude-Modell", cx));
        team_claude.update(cx, |input, cx| {
            input.set_value("claude-fable-5-2".into(), cx)
        });
        let team_codex = cx.new(|cx| TextInput::new("Codex-Modell (leer: CLI-Standard)", cx));
        let team_event = cx.subscribe(&team_prompt, |view, _, event: &EditorEvent, cx| {
            if matches!(event, EditorEvent::Submitted) {
                view.start_team(cx);
            }
        });
        let search = cx.new(|cx| TextInput::new("Chats durchsuchen …", cx));
        let composer = cx.new(CodeEditor::composer);
        let workspace = cx.new(|cx| TextInput::new("Projektordner für neuen Chat", cx));
        let claude_binary = cx.new(|cx| TextInput::new("claude oder vollständiger Pfad", cx));
        let codex_binary = cx.new(|cx| TextInput::new("codex oder vollständiger Pfad", cx));
        let title_input = cx.new(|cx| TextInput::new("Chat-Titel", cx));
        let model = cx.new(|cx| TextInput::new("Modell-ID", cx));
        model.update(cx, |input, cx| {
            input.set_value("claude-fable-5-2".into(), cx)
        });
        let search_event = cx.observe(&search, |_, _, cx| cx.notify());
        let submitted = cx.subscribe(&composer, |view, _, event: &EditorEvent, cx| {
            if matches!(event, EditorEvent::Submitted) {
                view.send(cx);
            }
        });
        let plans = cx.new(|cx| crate::plans::NativePlans::new(directory.clone(), cx));
        let ide = cx.new(NativeIde::new);
        let ide_event = cx.subscribe(&ide, |view, _, event: &InsertPath, cx| {
            let mut draft = view.composer.read(cx).value();
            if !draft.is_empty() {
                draft.push(' ');
            }
            draft.push_str(&format!("@{} ", event.0));
            view.composer
                .update(cx, |input, cx| input.set_value(draft, cx));
            view.ide_open = false;
            cx.notify();
        });
        let scroll = gpui::ListState::new(0, gpui::ListAlignment::Bottom, gpui::px(500.));
        let weak = cx.entity().downgrade();
        scroll.set_scroll_handler(move |event, _, cx| {
            let _ = weak.update(cx, |view, cx| {
                view.follow = !event.is_scrolled;
                cx.notify();
            });
        });
        let mut view = Self {
            directory,
            archive: Arc::new(Archive::default()),
            runtime: None,
            selected: None,
            status: "Profil wird geladen …".into(),
            active: Vec::new(),
            processes: Vec::new(),
            agents_open: false,
            team_prompt,
            team_claude,
            team_codex,
            _team_event: team_event,
            revision: 0,
            generation: 0,
            busy: false,
            closing: false,
            provider: "claude".into(),
            scroll,
            follow: true,
            drafts: HashMap::new(),
            file_drafts: HashMap::new(),
            files: Vec::new(),
            file_task: None,
            loading_files: false,
            preview: None,
            ide,
            plans,
            plans_open: false,
            ide_open: false,
            sidebar_open: true,
            collapsed_projects: HashSet::new(),
            options_open: false,
            search,
            picker: None,
            _ide_event: ide_event,
            composer,
            workspace,
            model,
            claude_binary,
            codex_binary,
            title_input,
            read_only: false,
            confirmation: None,
            _submitted: submitted,
            _search_event: search_event,
            task: None,
            polling: None,
            selection: None,
        };
        view.load(cx);
        view
    }

    fn selected_id(&self) -> Option<String> {
        self.selected
            .and_then(|index| self.archive.sessions.get(index))
            .map(|session| session.id.clone())
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        let root = self.directory.clone();
        let load = cx.background_executor().spawn(async move {
            let runtime = Runtime::open(&root)?;
            let snapshot = runtime.snapshot()?;
            let settings = runtime.settings();
            Ok::<_, io::Error>((Arc::new(Mutex::new(runtime)), snapshot, settings))
        });
        self.task = Some(cx.spawn(async move |view, cx| {
            let result = load.await;
            let _ = view.update(cx, |view, cx| {
                match result {
                    Ok((runtime, snapshot, settings)) => {
                        view.claude_binary.update(cx, |input, cx| {
                            input.set_value(
                                settings["binaries"]["claude"]
                                    .as_str()
                                    .unwrap_or("claude")
                                    .into(),
                                cx,
                            )
                        });
                        view.codex_binary.update(cx, |input, cx| {
                            input.set_value(
                                settings["binaries"]["codex"]
                                    .as_str()
                                    .unwrap_or("codex")
                                    .into(),
                                cx,
                            )
                        });
                        view.plans
                            .update(cx, |plans, _| plans.connect(runtime.clone()));
                        view.runtime = Some(runtime);
                        view.accept(snapshot);
                        view.status = "Bereit · CLI-Anmeldung erforderlich".into();
                        if !view.archive.sessions.is_empty() {
                            view.select(0, cx);
                        }
                        view.start_polling(cx);
                    }
                    Err(error) => view.status = error.to_string().into(),
                }
                cx.notify();
            });
        }));
    }

    fn accept(&mut self, snapshot: Snapshot) {
        if snapshot.revision < self.revision {
            return;
        }
        let selected = self.selected_id();
        self.revision = snapshot.revision;
        self.archive = snapshot.archive;
        self.active = snapshot.active;
        self.processes = snapshot.processes;
        self.selected = selected.and_then(|id| {
            self.archive
                .sessions
                .iter()
                .position(|session| session.id == id)
        });
    }

    fn select(&mut self, index: usize, cx: &mut Context<Self>) {
        let Some(session) = self.archive.sessions.get(index) else {
            return;
        };
        if let Some(previous) = self.selected_id() {
            self.file_drafts
                .insert(previous.clone(), self.files.clone());
            self.drafts.insert(previous, self.composer.read(cx).value());
        }
        self.files = self
            .file_drafts
            .get(&session.id)
            .cloned()
            .unwrap_or_default();
        self.read_only =
            session.options["permission"] == "plan" || session.options["sandbox"] == "read-only";
        self.title_input
            .update(cx, |input, cx| input.set_value(session.title.clone(), cx));
        self.provider = session.provider.clone();
        let model = session.options["model"].as_str().unwrap_or("").to_owned();
        self.model
            .update(cx, |input, cx| input.set_value(model, cx));
        let draft = self.drafts.get(&session.id).cloned().unwrap_or_default();
        self.composer
            .update(cx, |input, cx| input.set_value(draft, cx));
        self.workspace
            .update(cx, |input, cx| input.set_value(session.cwd.clone(), cx));
        let root = session.cwd.clone();
        self.ide.update(cx, |ide, cx| ide.set_root(root, cx));
        self.generation += 1;
        let generation = self.generation;
        self.selected = Some(index);
        self.follow = true;
        self.scroll.reset(0);
        let archive = self.archive.clone();
        let history = cx.background_executor().spawn(async move {
            let session = &archive.sessions[index];
            session
                .messages
                .iter()
                .filter(|message| message.role == "user")
                .map(|message| {
                    SharedString::new(
                        message
                            .blocks
                            .iter()
                            .filter_map(|block| block.text.as_deref())
                            .collect::<Vec<_>>()
                            .join("\n"),
                    )
                })
                .collect::<Vec<_>>()
        });
        self.selection = Some(cx.spawn(async move |view, cx| {
            let history = history.await;
            let _ = view.update(cx, |view, cx| {
                if view.generation == generation {
                    view.composer.update(cx, |input, _| input.history(history));
                    view.follow_end();
                    cx.notify();
                }
            });
        }));
        cx.notify();
    }

    fn start_polling(&mut self, cx: &mut Context<Self>) {
        let Some(runtime) = self.runtime.clone() else {
            return;
        };
        self.polling = Some(cx.spawn(async move |view, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(250))
                    .await;
                let Ok((selected, inspect_processes)) =
                    view.read_with(cx, |view, _| (view.selected_id(), view.agents_open))
                else {
                    break;
                };
                let runtime = runtime.clone();
                let operation = cx.background_executor().spawn(async move {
                    let mut runtime = runtime
                        .lock()
                        .map_err(|_| io::Error::other("Native runtime lock poisoned"))?;
                    if !runtime.tick()? {
                        return if inspect_processes {
                            Ok(Some(PollUpdate::Processes(runtime.processes()?)))
                        } else {
                            Ok(None)
                        };
                    }
                    let snapshot = runtime.snapshot()?;
                    Ok::<_, io::Error>(Some(PollUpdate::Snapshot(snapshot, selected)))
                });
                let result = operation.await;
                if view
                    .update(cx, |view, cx| {
                        match result {
                            Ok(Some(PollUpdate::Processes(processes))) => {
                                view.processes = processes;
                                if view.agents_open {
                                    cx.notify();
                                }
                                return;
                            }
                            Ok(Some(PollUpdate::Snapshot(snapshot, selected))) => {
                                let revision = snapshot.revision;
                                view.accept(snapshot);
                                if view.revision == revision
                                    && let Some(id) = selected
                                    && view.selected_id().as_deref() == Some(&id)
                                {
                                    view.follow_end();
                                }
                            }
                            Ok(None) => return,
                            Err(error) => {
                                view.status = error.to_string().into();
                            }
                        }
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        }));
    }

    fn operate(
        &mut self,
        operation: impl FnOnce(&mut Runtime) -> io::Result<Option<String>> + Send + 'static,
        sent: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if self.busy || self.closing {
            return;
        }
        let Some(runtime) = self.runtime.clone() else {
            return;
        };
        self.busy = true;
        let generation = self.generation;
        let selected = self.selected_id();
        let task = cx.background_executor().spawn(async move {
            let mut runtime = runtime
                .lock()
                .map_err(|_| io::Error::other("Native runtime lock poisoned"))?;
            let selected = operation(&mut runtime)?.or(selected);
            let snapshot = runtime.snapshot()?;
            Ok::<_, io::Error>((snapshot, selected))
        });
        self.task = Some(cx.spawn(async move |view, cx| {
            let result = task.await;
            let _ = view.update(cx, |view, cx| {
                view.busy = false;
                match result {
                    Ok((snapshot, selected)) => {
                        view.accept(snapshot);
                        if view.generation == generation {
                            view.selected = selected.and_then(|id| {
                                view.archive
                                    .sessions
                                    .iter()
                                    .position(|session| session.id == id)
                            });
                            view.follow_end();
                        }
                        if let Some(sent) = sent
                            && view.generation == generation
                            && view.composer.read(cx).value() == sent
                        {
                            view.composer.update(cx, |input, cx| input.sent(cx));
                            view.files.clear();
                        }
                        view.status = format!("{} aktive Chats", view.active.len()).into();
                    }
                    Err(error) => view.status = error.to_string().into(),
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn follow_end(&self) {
        let count = self
            .selected
            .and_then(|i| self.archive.sessions.get(i))
            .map_or(0, |session| session.messages.len());
        let previous = self.scroll.item_count();
        let start = previous.saturating_sub(1).min(count);
        self.scroll.splice(start..previous, count - start);
        if self.follow {
            self.scroll.scroll_to(gpui::ListOffset {
                item_ix: count,
                offset_in_item: gpui::px(0.),
            });
        }
    }

    fn send(&mut self, cx: &mut Context<Self>) {
        if self.loading_files {
            self.status = "Anhänge werden noch eingelesen …".into();
            cx.notify();
            return;
        }
        let files = self.files.clone();
        let read_only = self.read_only;
        let selected = self.selected_id();
        let provider = self.provider.clone();
        let cwd = PathBuf::from(self.workspace.read(cx).value());
        let model = self.model.read(cx).value();
        if cwd.as_os_str().is_empty() {
            self.status = "Wähle einen Projektordner, bevor du den Chat startest.".into();
            cx.notify();
            return;
        }
        let text = self.composer.read(cx).value();
        if text.trim().is_empty() && files.is_empty() {
            return;
        }
        let worker = match std::env::current_exe() {
            Ok(path) => path,
            Err(error) => {
                self.status = error.to_string().into();
                return;
            }
        };
        let host = host_path();
        self.follow = true;
        let prompt = text.clone();
        self.operate(
            move |runtime| {
                let id = match selected {
                    Some(id) => {
                        runtime.configure_chat(&id, &provider, &cwd, &model)?;
                        id
                    }
                    None => runtime.create_chat(&provider, &cwd, &model)?,
                };
                runtime.set_access(&id, read_only)?;
                runtime.send_files(&id, &prompt, &files, &host, &worker)?;
                Ok(Some(id))
            },
            Some(text),
            cx,
        );
    }

    fn new_chat(&mut self, cx: &mut Context<Self>) {
        if let Some(id) = self.selected_id() {
            self.file_drafts.insert(id.clone(), self.files.clone());
            self.drafts.insert(id, self.composer.read(cx).value());
        }
        self.files.clear();
        self.generation += 1;
        self.selection = None;
        self.selected = None;
        self.scroll.reset(0);
        self.ide_open = false;
        self.composer
            .update(cx, |input, cx| input.set_value(String::new(), cx));
        cx.notify();
    }

    fn pick_folder(&mut self, cx: &mut Context<Self>) {
        let generation = self.generation;
        let answer = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Projektordner wählen".into()),
        });
        self.picker = Some(cx.spawn(async move |view, cx| {
            let result = answer.await;
            let _ = view.update(cx, |view, cx| {
                if view.generation != generation {
                    return;
                }
                match result {
                    Ok(Ok(Some(paths))) => {
                        if let Some(path) = paths.first() {
                            let root = path.to_string_lossy().into_owned();
                            view.workspace
                                .update(cx, |input, cx| input.set_value(root.clone(), cx));
                            view.ide.update(cx, |ide, cx| ide.set_root(root, cx));
                        }
                    }
                    Ok(Err(error)) => view.status = error.to_string().into(),
                    Err(error) => view.status = error.to_string().into(),
                    _ => {}
                }
                cx.notify();
            });
        }));
    }

    fn save_binaries(&mut self, cx: &mut Context<Self>) {
        let claude = self.claude_binary.read(cx).value();
        let codex = self.codex_binary.read(cx).value();
        self.operate(
            move |runtime| {
                runtime.set_binaries(&claude, &codex)?;
                Ok(None)
            },
            None,
            cx,
        );
    }
    fn rename_chat(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.selected_id() else {
            return;
        };
        let title = self.title_input.read(cx).value();
        self.operate(
            move |runtime| {
                runtime.rename_chat(&id, &title)?;
                Ok(None)
            },
            None,
            cx,
        );
    }
    fn delete_chat(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let Some(id) = self.selected_id() else {
            return;
        };
        let answer=window.prompt(gpui::PromptLevel::Warning,"Chat dauerhaft löschen?",Some("Laufende Prozesse dieses Chats werden gestoppt. Der Verlauf wird gelöscht; eine Wiederherstellung beim nächsten Start wird verhindert."),&["Abbrechen","Chat löschen"],cx);
        self.confirmation = Some(cx.spawn(async move |view, cx| {
            if answer.await.unwrap_or(0) != 1 {
                return;
            }
            let _ = view.update(cx, |view, cx| {
                if view.selected_id().as_deref() == Some(&id) {
                    view.new_chat(cx);
                }
                view.drafts.remove(&id);
                view.file_drafts.remove(&id);
                view.operate(
                    move |runtime| {
                        runtime.delete_chat(&id)?;
                        Ok(None)
                    },
                    None,
                    cx,
                );
            });
        }));
    }

    fn stop(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.selected_id() else {
            return;
        };
        self.operate(
            move |runtime| {
                runtime.stop(&id)?;
                Ok(None)
            },
            None,
            cx,
        );
    }

    pub fn should_close(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.closing || self.busy || self.ide.read(cx).is_prompting() {
            return false;
        }
        let Some(runtime) = self.runtime.clone() else {
            return true;
        };
        self.closing = true;
        let dirty = self.ide.read(cx).is_dirty(cx) || self.plans.read(cx).is_dirty(cx);
        let answer = if self.active.is_empty() {
            dirty.then(|| {
                window.prompt(
                    gpui::PromptLevel::Warning,
                    "Ungespeicherte Dateien",
                    Some("Beim Schließen gehen ungespeicherte Änderungen verloren."),
                    &["Abbrechen", "Änderungen verwerfen und schließen"],
                    cx,
                )
            })
        } else {
            let detail = if dirty {
                "Ungespeicherte Dateiänderungen gehen beim Schließen verloren. Chats weiterlaufen lassen und beim nächsten Start wieder einhängen oder alle stoppen?"
            } else {
                "Chats weiterlaufen lassen und beim nächsten Start wieder einhängen oder alle stoppen?"
            };
            Some(window.prompt(
                gpui::PromptLevel::Warning,
                "Laufende Chats",
                Some(detail),
                &["Abbrechen", "Weiterlaufen lassen", "Alle stoppen"],
                cx,
            ))
        };
        self.task = Some(cx.spawn_in(window, async move |view, cx| {
            let choice = match answer {
                Some(answer) => answer.await.unwrap_or(0),
                None => 1,
            };
            if choice == 0 {
                let _ = view.update(cx, |view, cx| {
                    view.closing = false;
                    cx.notify();
                });
                return;
            }
            let task = cx.background_executor().spawn(async move {
                runtime
                    .lock()
                    .map_err(|_| io::Error::other("Native runtime lock poisoned"))?
                    .prepare_close(choice == 2)
            });
            let result = task.await;
            let _ = view.update_in(cx, |view, window, cx| match result {
                Ok(()) => {
                    window.remove_window();
                    cx.quit();
                }
                Err(error) => {
                    view.closing = false;
                    view.status = error.to_string().into();
                    cx.notify();
                }
            });
        }));
        false
    }
}

pub(crate) fn host_path() -> PathBuf {
    if let Some(path) = std::env::var_os("QUORUM_CHAT_HOST") {
        return path.into();
    }
    let name = if cfg!(windows) {
        "quorum-chat-host.exe"
    } else {
        "quorum-chat-host"
    };
    if let Ok(executable) = std::env::current_exe()
        && let Some(parent) = executable.parent()
    {
        let installed = parent.join(name);
        if installed.is_file() {
            return installed;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../bin")
        .join(name)
}

impl Render for Workbench {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.shell(window, cx)
    }
}

pub fn init(cx: &mut gpui::App) {
    shell::init(cx);
}
