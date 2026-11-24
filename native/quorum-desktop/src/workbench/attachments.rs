use super::*;
use gpui::*;
use quorum_core::workspace::attachments::{ChatFile, stage};

#[derive(Clone)]
pub(super) enum Preview {
    Image(PathBuf),
    Text(String, String),
}
impl Workbench {
    pub(super) fn preview_inline(
        &mut self,
        name: String,
        mime: String,
        data: String,
        cx: &mut Context<Self>,
    ) {
        if self.loading_files {
            return;
        }
        self.loading_files = true;
        let root = self.directory.clone();
        let task = cx.background_executor().spawn(async move {
            quorum_core::workspace::attachments::stage_inline(&root, &name, &mime, &data)
        });
        self.file_task = Some(cx.spawn(async move |view, cx| {
            let result = task.await;
            let _ = view.update(cx, |view, cx| {
                view.loading_files = false;
                match result {
                    Ok(file) => view.preview = Some(Preview::Image(file.path)),
                    Err(error) => view.status = error.to_string().into(),
                }
                cx.notify();
            });
        }));
    }
    pub(super) fn pick_files(&mut self, cx: &mut Context<Self>) {
        if self.busy || self.loading_files {
            return;
        }
        let answer = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Bilder oder Textdateien anhängen".into()),
        });
        let root = self.directory.clone();
        let generation = self.generation;
        self.loading_files = true;
        self.file_task = Some(cx.spawn(async move |view, cx| {
            let selected = answer.await;
            let result = match selected {
                Ok(Ok(Some(paths))) => {
                    cx.background_executor()
                        .spawn(async move {
                            if paths.len() > 8 {
                                return Err(io::Error::other("Maximal 8 Anhänge pro Nachricht"));
                            }
                            paths
                                .iter()
                                .map(|path| stage(&root, path))
                                .collect::<io::Result<Vec<ChatFile>>>()
                        })
                        .await
                }
                Ok(Err(error)) => Err(io::Error::other(error)),
                Err(error) => Err(io::Error::other(error)),
                _ => Ok(Vec::new()),
            };
            let _ = view.update(cx, |view, cx| {
                view.loading_files = false;
                if generation != view.generation {
                    return;
                }
                match result {
                    Ok(files) => {
                        if view.files.len() + files.len() <= 8 {
                            view.files.extend(files);
                        } else {
                            view.status = "Maximal 8 Anhänge pro Nachricht".into();
                        }
                    }
                    Err(error) => view.status = error.to_string().into(),
                }
                cx.notify();
            });
        }));
        cx.notify();
    }
    pub(super) fn preview_view(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(preview) = self.preview.clone() else {
            return div().into_any_element();
        };
        div()
            .id("preview-backdrop")
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .p_6()
            .bg(rgba(0x000000cc))
            .child(
                div()
                    .id("attachment-preview")
                    .w_full()
                    .max_w(px(1000.))
                    .max_h_full()
                    .flex()
                    .flex_col()
                    .p_4()
                    .gap_3()
                    .rounded(px(14.))
                    .bg(rgb(crate::theme::SURFACE))
                    .border_1()
                    .border_color(rgb(crate::theme::EDGE))
                    .on_click(|_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(match &preview {
                                Preview::Image(path) => path
                                    .file_name()
                                    .unwrap_or_default()
                                    .to_string_lossy()
                                    .into_owned(),
                                Preview::Text(name, _) => name.clone(),
                            })
                            .child(
                                crate::theme::button("close-preview", "Schließen", "x").on_click(
                                    cx.listener(|view, _, _, cx| {
                                        view.preview = None;
                                        cx.notify();
                                    }),
                                ),
                            ),
                    )
                    .child(match &preview {
                        Preview::Image(path) => img(path.clone())
                            .w_full()
                            .h(px(500.))
                            .object_fit(ObjectFit::Contain)
                            .into_any_element(),
                        Preview::Text(_, text) => div()
                            .id("preview-text")
                            .h(px(500.))
                            .overflow_y_scroll()
                            .p_3()
                            .font_family("monospace")
                            .text_size(px(12.))
                            .child(text.clone())
                            .into_any_element(),
                    })
                    .when(matches!(preview, Preview::Text(_, _)), |d| {
                        d.child(
                            crate::theme::button("copy-attachment", "Inhalt kopieren", "files")
                                .on_click(move |_, _, cx| {
                                    if let Preview::Text(_, text) = &preview {
                                        cx.write_to_clipboard(ClipboardItem::new_string(
                                            text.clone(),
                                        ));
                                    }
                                }),
                        )
                    }),
            )
            .on_click(cx.listener(|view, _, _, cx| {
                view.preview = None;
                cx.notify();
            }))
            .into_any_element()
    }
}
