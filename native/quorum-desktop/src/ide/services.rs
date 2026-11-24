use super::*;
use crate::theme::*;
use quorum_core::workspace::{git, search};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ServiceMode {
    Closed,
    Search,
    Git,
    Language,
}
impl NativeIde {
    pub(super) fn create_path(&mut self, cx: &mut Context<Self>) {
        let path = self.new_path.read(cx).value();
        if path.trim().is_empty() {
            return;
        }
        let root = self.root.clone();
        let requested = root.clone();
        let target = path.clone();
        let task = cx.background_executor().spawn(async move {
            let workspace = Workspace::open(Path::new(&requested))?;
            if target.ends_with('/') {
                workspace.create_directory(Path::new(target.trim_end_matches('/')))
            } else {
                workspace.create(Path::new(&target), "")
            }
        });
        self.tasks.insert(
            "create-path".into(),
            cx.spawn(async move |view, cx| {
                let result = task.await;
                let _ = view.update(cx, |view, cx| {
                    if view.root != root {
                        return;
                    }
                    match result {
                        Ok(()) => {
                            view.new_path
                                .update(cx, |input, cx| input.set_value(String::new(), cx));
                            view.directories.clear();
                            view.load_directory(String::new(), cx);
                            if !path.ends_with('/') {
                                view.open(path, cx);
                            }
                            view.error.clear();
                        }
                        Err(error) => view.error = error.to_string(),
                    }
                    cx.notify();
                });
            }),
        );
    }
    pub(super) fn reload_selected(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.prompting {
            return;
        }
        let Some(tab) = self
            .tabs
            .iter()
            .find(|tab| Some(&tab.key) == self.selected.as_ref())
        else {
            return;
        };
        if tab.saving {
            return;
        }
        let root = tab.root.clone();
        let path = tab.path.clone();
        let key = tab.key.clone();
        let current = tab.editor.read(cx).text().to_owned();
        let answer = if current != tab.saved.as_ref() {
            Some(window.prompt(
                PromptLevel::Warning,
                "Datei neu laden?",
                Some("Ungespeicherte Änderungen dieser Datei werden verworfen."),
                &["Abbrechen", "Neu laden"],
                cx,
            ))
        } else {
            None
        };
        self.prompting = true;
        self.prompt=Some(cx.spawn(async move|view,cx|{
            let approved=match answer{Some(answer)=>answer.await.unwrap_or(0)==1,None=>true};
            if !approved{let _=view.update(cx,|view,cx|{view.prompting=false;cx.notify();});return;}
            let result=cx.background_executor().spawn(async move{Workspace::open(Path::new(&root))?.read(Path::new(&path))}).await;
            let _=view.update(cx,|view,cx|{
                view.prompting=false;
                match result{Ok(text)=>{
                    if let Some(tab)=view.tabs.iter_mut().find(|tab|tab.key==key){
                        if tab.editor.read(cx).text()!=current{view.error="Datei wurde während des Ladens bearbeitet; Änderungen bleiben erhalten.".into();}
                        else{tab.saved=Arc::from(text.as_str());tab.editor.update(cx,|editor,cx|editor.set_value(text,cx));view.error.clear();}
                    }
                },Err(error)=>view.error=error.to_string()}cx.notify();
            });
        }));
    }

    pub(super) fn search_project(&mut self, cx: &mut Context<Self>) {
        let query = self.project_query.read(cx).value();
        let root = self.root.clone();
        let requested = root.clone();
        let task = cx
            .background_executor()
            .spawn(async move { search::search(Path::new(&requested), &query) });
        self.tasks.insert(
            "project-search".into(),
            cx.spawn(async move |view, cx| {
                let result = task.await;
                let _ = view.update(cx, |view, cx| {
                    if view.root != root {
                        return;
                    }
                    match result {
                        Ok(matches) => view.matches = Arc::new(matches),
                        Err(error) => view.error = error.to_string(),
                    }
                    cx.notify();
                });
            }),
        );
    }
    pub(super) fn refresh_git(&mut self, cx: &mut Context<Self>) {
        let root = self.root.clone();
        let requested = root.clone();
        let task = cx
            .background_executor()
            .spawn(async move { git::status(Path::new(&requested)) });
        self.tasks.insert(
            "git-status".into(),
            cx.spawn(async move |view, cx| {
                let result = task.await;
                let _ = view.update(cx, |view, cx| {
                    if view.root != root {
                        return;
                    }
                    match result {
                        Ok(changes) => {
                            view.changes = Arc::new(changes);
                            view.error.clear();
                        }
                        Err(error) => view.error = error.to_string(),
                    }
                    cx.notify();
                });
            }),
        );
    }
    fn diff_file(&mut self, path: String, cx: &mut Context<Self>) {
        let root = self.root.clone();
        let requested = root.clone();
        let target = path.clone();
        let task = cx
            .background_executor()
            .spawn(async move { git::diff(Path::new(&requested), &target) });
        self.tasks.insert(
            "git-diff".into(),
            cx.spawn(async move |view, cx| {
                let result = task.await;
                let _ = view.update(cx, |view, cx| {
                    if view.root != root {
                        return;
                    }
                    match result {
                        Ok(diff) => {
                            view.diff = diff;
                            view.diff_path = path;
                            view.error.clear();
                        }
                        Err(error) => view.error = error.to_string(),
                    }
                    cx.notify();
                });
            }),
        );
    }
    fn stage_diff(&mut self, cx: &mut Context<Self>) {
        if self.diff_path.is_empty() {
            return;
        }
        let root = self.root.clone();
        let requested = root.clone();
        let path = self.diff_path.clone();
        let task = cx
            .background_executor()
            .spawn(async move { git::stage(Path::new(&requested), &path) });
        self.tasks.insert(
            "git-stage".into(),
            cx.spawn(async move |view, cx| {
                let result = task.await;
                let _ = view.update(cx, |view, cx| {
                    if view.root != root {
                        return;
                    }
                    match result {
                        Ok(()) => view.refresh_git(cx),
                        Err(error) => view.error = error.to_string(),
                    }
                    cx.notify();
                });
            }),
        );
    }
    pub(super) fn service_panel(&self, cx: &mut Context<Self>) -> AnyElement {
        let view = cx.entity();
        let matches = self.matches.clone();
        let changes = self.changes.clone();
        div()
            .w(px(320.))
            .flex_shrink_0()
            .h_full()
            .border_l_1()
            .border_color(rgb(EDGE))
            .bg(rgb(SURFACE))
            .flex()
            .flex_col()
            .child(
                div()
                    .h(px(38.))
                    .px_2()
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(if self.service_mode == ServiceMode::Search {
                        "Im Projekt suchen"
                    } else if self.service_mode == ServiceMode::Git {
                        "Git-Änderungen"
                    } else {
                        "Sprachserver"
                    })
                    .child(button("close-service", "", "x").on_click(cx.listener(
                        |view, _, _, cx| {
                            view.service_mode = ServiceMode::Closed;
                            cx.notify();
                        },
                    ))),
            )
            .child(if self.service_mode == ServiceMode::Search {
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(self.project_query.clone())
                    .child(
                        div()
                            .px_2()
                            .text_size(px(11.))
                            .text_color(rgb(SUBTLE))
                            .child("Enter: suchen · maximal 200 Treffer"),
                    )
                    .child(
                        uniform_list("project-results", matches.len(), move |range, _, _| {
                            range
                                .map(|index| {
                                    let result = &matches[index];
                                    let path = result.path.clone();
                                    let view = view.clone();
                                    div()
                                        .id(index)
                                        .h(px(56.))
                                        .px_2()
                                        .py_1()
                                        .flex()
                                        .flex_col()
                                        .gap_1()
                                        .cursor_pointer()
                                        .hover(|s| s.bg(rgb(HOVER)))
                                        .on_click(move |_, _, cx| {
                                            view.update(cx, |view, cx| view.open(path.clone(), cx))
                                        })
                                        .child(
                                            div()
                                                .text_size(px(11.))
                                                .text_ellipsis()
                                                .child(format!("{}:{}", result.path, result.line)),
                                        )
                                        .child(
                                            div()
                                                .text_size(px(11.))
                                                .text_color(rgb(MUTED))
                                                .text_ellipsis()
                                                .child(result.excerpt.clone()),
                                        )
                                })
                                .collect()
                        })
                        .flex_1()
                        .min_h_0(),
                    )
                    .into_any_element()
            } else if self.service_mode == ServiceMode::Git {
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .flex_col()
                    .child(
                        button("refresh-git", "Aktualisieren", "chevron-down")
                            .on_click(cx.listener(|view, _, _, cx| view.refresh_git(cx))),
                    )
                    .child(
                        uniform_list("git-changes", changes.len(), move |range, _, _| {
                            range
                                .map(|index| {
                                    let change = &changes[index];
                                    let path = change.path.clone();
                                    let view = view.clone();
                                    div()
                                        .id(index)
                                        .h(px(30.))
                                        .px_2()
                                        .flex()
                                        .items_center()
                                        .cursor_pointer()
                                        .hover(|s| s.bg(rgb(HOVER)))
                                        .on_click(move |_, _, cx| {
                                            view.update(cx, |view, cx| {
                                                view.diff_file(path.clone(), cx)
                                            })
                                        })
                                        .child(
                                            div().text_size(px(11.)).text_ellipsis().child(
                                                format!("{}  {}", change.status, change.path),
                                            ),
                                        )
                                })
                                .collect()
                        })
                        .h(px(180.)),
                    )
                    .child(
                        button("stage-file", "Datei stagen", "plus")
                            .on_click(cx.listener(|view, _, _, cx| view.stage_diff(cx))),
                    )
                    .child(
                        div()
                            .id("git-diff-body")
                            .flex_1()
                            .min_h_0()
                            .overflow_y_scroll()
                            .p_2()
                            .font_family("monospace")
                            .text_size(px(11.))
                            .child(self.diff.clone()),
                    )
                    .into_any_element()
            } else {
                div()
                    .id("language-output")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p_3()
                    .text_size(px(12.))
                    .child(
                        crate::theme::button("stop-language-servers", "Server beenden", "square")
                            .on_click(cx.listener(|view, _, _, cx| {
                                view.language_servers.clear();
                                view.lsp_output = "Sprachserver beendet.".into();
                                cx.notify();
                            })),
                    )
                    .child(self.lsp_output.clone())
                    .into_any_element()
            })
            .into_any_element()
    }
}
