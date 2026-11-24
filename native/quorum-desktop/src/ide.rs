mod language;
mod services;
use crate::{
    editor::{CodeEditor, EditorEvent},
    input::{Submitted, TextInput},
};
use gpui::{prelude::*, *};
use quorum_core::workspace::{Entry, Workspace};
use services::ServiceMode;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

struct Tab {
    key: String,
    root: String,
    path: String,
    editor: Entity<CodeEditor>,
    saved: Arc<str>,
    saving: bool,
    _events: Subscription,
}

pub struct InsertPath(pub String);
pub struct NativeIde {
    root: String,
    service_mode: ServiceMode,
    language_servers: HashMap<String, Arc<std::sync::Mutex<quorum_core::workspace::lsp::Server>>>,
    lsp_busy: bool,
    lsp_output: String,
    project_query: Entity<TextInput>,
    new_path: Entity<TextInput>,
    _new_event: Subscription,
    matches: Arc<Vec<quorum_core::workspace::search::Match>>,
    changes: Arc<Vec<quorum_core::workspace::git::Change>>,
    diff: String,
    diff_path: String,
    _project_event: Subscription,
    directories: HashMap<String, Vec<Entry>>,
    expanded: HashSet<String>,
    tabs: Vec<Tab>,
    selected: Option<String>,
    error: String,
    tasks: HashMap<String, Task<()>>,
    saves: HashMap<String, Task<()>>,
    prompt: Option<Task<()>>,
    prompting: bool,
    find_open: bool,
    find: Entity<TextInput>,
    _find_event: Subscription,
}
impl EventEmitter<InsertPath> for NativeIde {}

impl NativeIde {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let new_path = cx.new(|cx| TextInput::new("Neue Datei · Ordner mit / am Ende", cx));
        let new_event = cx.subscribe(&new_path, |view, _, _: &Submitted, cx| view.create_path(cx));
        let project_query = cx.new(|cx| TextInput::new("Suchbegriff im Projekt", cx));
        let project_event = cx.subscribe(&project_query, |view, _, _: &Submitted, cx| {
            view.search_project(cx)
        });
        let find = cx.new(|cx| TextInput::new("Im Dokument suchen · Enter: nächster Treffer", cx));
        let event = cx.subscribe(&find, |view, _, _: &Submitted, cx| view.find_next(cx));
        Self {
            root: String::new(),
            service_mode: ServiceMode::Closed,
            language_servers: HashMap::new(),
            lsp_busy: false,
            lsp_output: String::new(),
            new_path,
            _new_event: new_event,
            project_query,
            matches: Arc::new(Vec::new()),
            changes: Arc::new(Vec::new()),
            diff: String::new(),
            diff_path: String::new(),
            _project_event: project_event,
            directories: HashMap::new(),
            expanded: HashSet::new(),
            tabs: Vec::new(),
            selected: None,
            error: String::new(),
            tasks: HashMap::new(),
            saves: HashMap::new(),
            prompt: None,
            prompting: false,
            find_open: false,
            find,
            _find_event: event,
        }
    }
    pub fn set_root(&mut self, root: String, cx: &mut Context<Self>) {
        if self.root == root {
            return;
        }
        self.root = root;
        self.language_servers.clear();
        self.lsp_busy = false;
        self.lsp_output.clear();
        self.matches = Arc::new(Vec::new());
        self.changes = Arc::new(Vec::new());
        self.diff.clear();
        self.diff_path.clear();
        self.directories.clear();
        self.expanded.clear();
        self.tasks.clear();
        self.error.clear();
        if !self.root.is_empty() {
            self.load_directory(String::new(), cx);
        }
        cx.notify();
    }
    pub fn is_prompting(&self) -> bool {
        self.prompting
    }
    pub fn is_dirty(&self, cx: &App) -> bool {
        self.tabs
            .iter()
            .any(|tab| tab.editor.read(cx).text() != tab.saved.as_ref())
    }
    fn load_directory(&mut self, directory: String, cx: &mut Context<Self>) {
        let root = self.root.clone();
        let key = format!("tree:{directory}");
        let root_copy = root.clone();
        let directory_copy = directory.clone();
        let task = cx.background_executor().spawn(async move {
            Workspace::open(Path::new(&root_copy))?.list(Path::new(&directory_copy))
        });
        self.tasks.insert(
            key,
            cx.spawn(async move |view, cx| {
                let result = task.await;
                let _ = view.update(cx, |view, cx| {
                    if view.root != root {
                        return;
                    }
                    match result {
                        Ok(entries) => {
                            view.directories.insert(directory, entries);
                        }
                        Err(error) => view.error = error.to_string(),
                    }
                    cx.notify();
                });
            }),
        );
    }
    fn open(&mut self, path: String, cx: &mut Context<Self>) {
        let root = self.root.clone();
        let key = format!("{root}\0{path}");
        if self.tabs.iter().any(|tab| tab.key == key) {
            self.selected = Some(key);
            cx.notify();
            return;
        }
        let root_copy = root.clone();
        let path_copy = path.clone();
        let task = cx.background_executor().spawn(async move {
            Workspace::open(Path::new(&root_copy))?.read(Path::new(&path_copy))
        });
        self.tasks.insert(
            format!("read:{key}"),
            cx.spawn(async move |view, cx| {
                let result = task.await;
                let _ = view.update(cx, |view, cx| {
                    match result {
                        Ok(text) => {
                            if view.tabs.iter().any(|tab| tab.key == key) {
                                view.selected = Some(key);
                                cx.notify();
                                return;
                            }
                            let saved: Arc<str> = Arc::from(text.as_str());
                            let editor = cx.new(|cx| CodeEditor::for_file(text, &path, cx));
                            let event_key = key.clone();
                            let events =
                                cx.subscribe(&editor, move |view, _, event: &EditorEvent, cx| {
                                    match event {
                                        EditorEvent::Save => view.save(&event_key, cx),
                                        EditorEvent::Find => {
                                            view.find_open = true;
                                        }
                                        EditorEvent::Changed => {
                                            view.lsp_output =
                                                "Dokument geändert. Sprachserver erneut prüfen."
                                                    .into();
                                        }
                                        EditorEvent::Submitted => {}
                                    }
                                    cx.notify();
                                });
                            view.tabs.push(Tab {
                                key: key.clone(),
                                root,
                                path,
                                editor,
                                saved,
                                saving: false,
                                _events: events,
                            });
                            view.selected = Some(key);
                        }
                        Err(error) => view.error = error.to_string(),
                    }
                    cx.notify();
                });
            }),
        );
    }
    fn save(&mut self, key: &str, cx: &mut Context<Self>) {
        let Some(tab) = self.tabs.iter_mut().find(|tab| tab.key == key) else {
            return;
        };
        if tab.saving {
            return;
        }
        let text = tab.editor.read(cx).text().to_owned();
        if text == tab.saved.as_ref() {
            return;
        }
        tab.saving = true;
        let saved = tab.saved.clone();
        let root = tab.root.clone();
        let path = tab.path.clone();
        let key = key.to_owned();
        let task = cx.background_executor().spawn(async move {
            Workspace::open(Path::new(&root))?.save(Path::new(&path), &saved, &text)?;
            Ok::<_, std::io::Error>(text)
        });
        self.saves.insert(
            key.clone(),
            cx.spawn(async move |view, cx| {
                let result = task.await;
                let _ = view.update(cx, |view, cx| {
                    if let Some(tab) = view.tabs.iter_mut().find(|tab| tab.key == key) {
                        tab.saving = false;
                        match result {
                            Ok(text) => {
                                tab.saved = text.into();
                                view.error.clear();
                            }
                            Err(error) => view.error = error.to_string(),
                        }
                    }
                    cx.notify();
                });
            }),
        );
        cx.notify();
    }
    fn close(&mut self, key: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.prompting {
            return;
        }
        let Some(tab) = self.tabs.iter().find(|tab| tab.key == key) else {
            return;
        };
        if tab.saving {
            self.error = "Datei wird gerade gespeichert".into();
            cx.notify();
            return;
        }
        if tab.editor.read(cx).text() == tab.saved.as_ref() {
            self.remove(&key);
            cx.notify();
            return;
        }
        self.prompting = true;
        let answer = window.prompt(
            PromptLevel::Warning,
            "Ungespeicherte Änderungen",
            Some(&format!("Änderungen an {} verwerfen?", tab.path)),
            &["Abbrechen", "Verwerfen"],
            cx,
        );
        self.prompt = Some(cx.spawn(async move |view, cx| {
            let choice = answer.await.unwrap_or(0);
            let _ = view.update(cx, |view, cx| {
                view.prompting = false;
                if choice == 1 {
                    view.remove(&key);
                }
                cx.notify();
            });
        }));
    }
    fn remove(&mut self, key: &str) {
        self.tabs.retain(|tab| tab.key != key);
        if self.selected.as_deref() == Some(key) {
            self.selected = self.tabs.last().map(|tab| tab.key.clone());
        }
    }
    fn find_next(&mut self, cx: &mut Context<Self>) {
        let query = self.find.read(cx).value();
        if let Some(tab) = self
            .tabs
            .iter()
            .find(|tab| Some(&tab.key) == self.selected.as_ref())
        {
            tab.editor
                .update(cx, |editor, cx| editor.find_next(&query, cx));
        }
    }
    fn tree_rows(
        &self,
        directory: &str,
        depth: usize,
        rows: &mut Vec<(String, String, bool, usize)>,
    ) {
        if depth > 64 {
            return;
        }
        let Some(entries) = self.directories.get(directory) else {
            return;
        };
        for entry in entries {
            rows.push((
                entry.path.clone(),
                entry.name.clone(),
                entry.is_directory,
                depth,
            ));
            if entry.is_directory && self.expanded.contains(&entry.path) {
                self.tree_rows(&entry.path, depth + 1, rows);
            }
        }
    }
}

impl Render for NativeIde {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut rows = Vec::new();
        self.tree_rows("", 0, &mut rows);
        let rows = Arc::new(rows);
        let expanded = self.expanded.clone();
        let selected = self
            .tabs
            .iter()
            .find(|tab| Some(&tab.key) == self.selected.as_ref());
        let editor = selected.map(|tab| tab.editor.clone());
        let path = selected
            .map(|tab| {
                PathBuf::from(&tab.root)
                    .join(&tab.path)
                    .to_string_lossy()
                    .into_owned()
            })
            .unwrap_or_else(|| self.root.clone());
        let tabs = self
            .tabs
            .iter()
            .map(|tab| {
                let key = tab.key.clone();
                let close = key.clone();
                let dirty = tab.editor.read(cx).text() != tab.saved.as_ref();
                div()
                    .flex()
                    .items_center()
                    .border_r_1()
                    .border_color(rgb(0x232830))
                    .bg(rgb(if self.selected.as_ref() == Some(&key) {
                        0x262c36
                    } else {
                        0x14171c
                    }))
                    .child(
                        div()
                            .id(SharedString::new(format!("select:{key}")))
                            .px_3()
                            .py_2()
                            .cursor_pointer()
                            .on_click(cx.listener(move |view, _, _, cx| {
                                view.selected = Some(key.clone());
                                cx.notify();
                            }))
                            .child(format!(
                                "{}{}{}",
                                if dirty { "● " } else { "" },
                                tab.path.rsplit('/').next().unwrap_or(&tab.path),
                                if tab.saving { " …" } else { "" }
                            )),
                    )
                    .child(
                        div()
                            .id(SharedString::new(format!("close:{close}")))
                            .px_2()
                            .cursor_pointer()
                            .on_click(cx.listener(move |view, _, window, cx| {
                                view.close(close.clone(), window, cx)
                            }))
                            .child("×"),
                    )
            })
            .collect::<Vec<_>>();
        div()
            .size_full()
            .flex()
            .bg(rgb(0x0e1013))
            .child(
                div()
                    .w(px(210.))
                    .h_full()
                    .flex()
                    .flex_col()
                    .border_r_1()
                    .border_color(rgb(0x232830))
                    .child(
                        div()
                            .h(px(36.))
                            .px_2()
                            .flex()
                            .items_center()
                            .justify_between()
                            .child("Dateien")
                            .child(
                                div()
                                    .id("refresh-tree")
                                    .cursor_pointer()
                                    .on_click(cx.listener(|view, _, _, cx| {
                                        view.directories.clear();
                                        view.load_directory(String::new(), cx);
                                    }))
                                    .child("↻"),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .px_2()
                            .gap_1()
                            .child(
                                crate::theme::button("project-search", "Suchen", "search")
                                    .on_click(cx.listener(|view, _, window, cx| {
                                        view.service_mode = ServiceMode::Search;
                                        window.focus(&view.project_query.focus_handle(cx));
                                        cx.notify();
                                    })),
                            )
                            .child(
                                crate::theme::button("project-git", "Git", "git-branch").on_click(
                                    cx.listener(|view, _, _, cx| {
                                        view.service_mode = ServiceMode::Git;
                                        view.refresh_git(cx);
                                        cx.notify();
                                    }),
                                ),
                            ),
                    )
                    .child(self.new_path.clone())
                    .child(
                        crate::theme::button("create-path", "Anlegen", "plus")
                            .on_click(cx.listener(|view, _, _, cx| view.create_path(cx))),
                    )
                    .child(
                        uniform_list("workspace-tree", rows.len(), {
                            let view = cx.entity();
                            move |range, _, _| {
                                range
                                    .map(|index| {
                                        let (path, name, directory, depth) = &rows[index];
                                        let path = path.clone();
                                        let view = view.clone();
                                        let directory = *directory;
                                        let prefix = if directory {
                                            if expanded.contains(&path) {
                                                "▾ "
                                            } else {
                                                "▸ "
                                            }
                                        } else {
                                            "  "
                                        };
                                        div()
                                            .id(index)
                                            .h(px(26.))
                                            .pl(px(8. + *depth as f32 * 12.))
                                            .overflow_hidden()
                                            .cursor_pointer()
                                            .on_click(move |_, _, cx| {
                                                view.update(cx, |view, cx| {
                                                    if !directory {
                                                        view.open(path.clone(), cx);
                                                        return;
                                                    }
                                                    if !view.expanded.remove(&path) {
                                                        view.expanded.insert(path.clone());
                                                        view.load_directory(path.clone(), cx);
                                                    }
                                                    cx.notify();
                                                })
                                            })
                                            .child(SharedString::new(format!("{prefix}{name}")))
                                    })
                                    .collect()
                            }
                        })
                        .flex_1()
                        .min_h_0(),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .id("editor-tabs")
                            .flex()
                            .overflow_x_scroll()
                            .children(tabs),
                    )
                    .child(
                        div()
                            .h(px(28.))
                            .px_2()
                            .flex()
                            .items_center()
                            .justify_between()
                            .overflow_hidden()
                            .text_size(px(11.))
                            .child(div().flex_1().min_w_0().text_ellipsis().child(path.clone()))
                            .child(
                                crate::theme::button("reload-file", "Neu laden", "chevron-down")
                                    .on_click(cx.listener(|view, _, window, cx| {
                                        view.reload_selected(window, cx)
                                    })),
                            )
                            .child(
                                crate::theme::button("inspect-language", "LSP prüfen", "code-2")
                                    .on_click(
                                        cx.listener(|view, _, _, cx| view.inspect_language(cx)),
                                    ),
                            )
                            .child(
                                div()
                                    .id("insert-path")
                                    .cursor_pointer()
                                    .on_click(cx.listener(move |_, _, _, cx| {
                                        cx.emit(InsertPath(path.clone()))
                                    }))
                                    .child("In Chat einfügen"),
                            ),
                    )
                    .when(!self.error.is_empty(), |view| {
                        view.child(
                            div()
                                .px_3()
                                .py_2()
                                .text_color(rgb(0xefb1a8))
                                .child(self.error.clone()),
                        )
                    })
                    .when(self.find_open, |view| {
                        view.child(
                            div()
                                .flex()
                                .items_center()
                                .gap_2()
                                .p_2()
                                .child(div().flex_1().child(self.find.clone()))
                                .child(
                                    div()
                                        .id("find-next")
                                        .px_2()
                                        .cursor_pointer()
                                        .on_click(cx.listener(|view, _, _, cx| view.find_next(cx)))
                                        .child("Weiter"),
                                )
                                .child(
                                    div()
                                        .id("find-close")
                                        .px_2()
                                        .cursor_pointer()
                                        .on_click(cx.listener(|view, _, _, cx| {
                                            view.find_open = false;
                                            cx.notify();
                                        }))
                                        .child("×"),
                                ),
                        )
                    })
                    .child(match editor {
                        Some(editor) => div().flex_1().min_h_0().child(editor).into_any_element(),
                        None => div()
                            .flex_1()
                            .p_4()
                            .child("Datei auswählen · Strg+S speichern · Strg+F suchen")
                            .into_any_element(),
                    }),
            )
            .when(self.service_mode != ServiceMode::Closed, |d| {
                d.child(self.service_panel(cx))
            })
    }
}
