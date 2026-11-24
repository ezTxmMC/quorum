use crate::theme::*;
use gpui::{prelude::*, *};
use quorum_core::archive::Message;

pub(super) fn message(
    message: &Message,
    provider: &str,
    view: WeakEntity<super::Workbench>,
) -> AnyElement {
    let user = message.role == "user";
    div()
        .w_full()
        .px_4()
        .py_3()
        .child(
            div()
                .w_full()
                .max_w(px(1152.))
                .mx_auto()
                .flex()
                .flex_col()
                .gap_2()
                .when(user, |d| d.items_end())
                .when(!user, |d| {
                    d.child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .child(div().size(px(7.)).rounded_full().bg(rgb(ACCENT)))
                            .child(if message.role == "system" {
                                "System".to_owned()
                            } else {
                                provider.to_owned()
                            }),
                    )
                })
                .child(
                    div()
                        .min_w_0()
                        .max_w_full()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .when(user, |d| {
                            d.px_4()
                                .py_3()
                                .rounded(px(14.))
                                .border_1()
                                .border_color(rgb(EDGE))
                                .bg(rgb(SURFACE))
                        })
                        .child(
                            div()
                                .id("message-images")
                                .flex()
                                .flex_wrap()
                                .gap_2()
                                .children(message.images.iter().enumerate().map(
                                    |(index, path)| {
                                        let preview =
                                            super::attachments::Preview::Image(path.into());
                                        let view = view.clone();
                                        div()
                                            .id(index)
                                            .cursor_pointer()
                                            .on_click(move |_, _, cx| {
                                                let _ = view.update(cx, |view, cx| {
                                                    view.preview = Some(preview.clone());
                                                    cx.notify();
                                                });
                                            })
                                            .child(
                                                img(std::path::PathBuf::from(path))
                                                    .w(px(200.))
                                                    .h(px(140.))
                                                    .object_fit(ObjectFit::Contain),
                                            )
                                    },
                                )),
                        )
                        .child(
                            div()
                                .id("message-files")
                                .flex()
                                .flex_wrap()
                                .gap_2()
                                .children(message.files.iter().enumerate().map(|(index, file)| {
                                    let preview = super::attachments::Preview::Text(
                                        file.name.clone(),
                                        file.text.clone().unwrap_or_default(),
                                    );
                                    let view = view.clone();
                                    div()
                                        .id(index)
                                        .px_3()
                                        .py_2()
                                        .border_1()
                                        .border_color(rgb(EDGE))
                                        .rounded(px(6.))
                                        .cursor_pointer()
                                        .child(file.name.clone())
                                        .on_click(move |_, _, cx| {
                                            let _ = view.update(cx, |view, cx| {
                                                view.preview = Some(preview.clone());
                                                cx.notify();
                                            });
                                        })
                                })),
                        )
                        .child(
                            div()
                                .id("inline-images")
                                .flex()
                                .flex_wrap()
                                .gap_2()
                                .children(message.attachments.iter().enumerate().map(
                                    |(index, file)| {
                                        let name = file.name.clone();
                                        let mime = file.mime.clone();
                                        let data = file.data.clone();
                                        let view = view.clone();
                                        div()
                                            .id(index)
                                            .px_3()
                                            .py_2()
                                            .border_1()
                                            .border_color(rgb(EDGE))
                                            .rounded(px(6.))
                                            .cursor_pointer()
                                            .child(format!("Bild: {}", file.name))
                                            .on_click(move |_, _, cx| {
                                                let _ = view.update(cx, |view, cx| {
                                                    view.preview_inline(
                                                        name.clone(),
                                                        mime.clone(),
                                                        data.clone(),
                                                        cx,
                                                    )
                                                });
                                            })
                                    },
                                )),
                        )
                        .children(message.blocks.iter().map(|block| {
                            match block.kind.as_str() {
                                "thinking" => div()
                                    .border_l_2()
                                    .border_color(rgb(EDGE))
                                    .pl_3()
                                    .text_size(px(12.))
                                    .text_color(rgb(SUBTLE))
                                    .child(block.text.clone().unwrap_or_default())
                                    .into_any_element(),
                                "tool" => div()
                                    .border_1()
                                    .border_color(rgb(EDGE))
                                    .rounded(px(8.))
                                    .px_3()
                                    .py_2()
                                    .flex()
                                    .flex_col()
                                    .gap_2()
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .gap_2()
                                            .text_size(px(12.))
                                            .text_color(rgb(MUTED))
                                            .child(icon("terminal", 14.))
                                            .child(
                                                block
                                                    .name
                                                    .clone()
                                                    .unwrap_or_else(|| "Werkzeug".into()),
                                            ),
                                    )
                                    .when(block.output.is_some(), |d| {
                                        d.child(
                                            div()
                                                .font_family("monospace")
                                                .text_size(px(12.))
                                                .text_color(rgb(MUTED))
                                                .child(block.output.clone().unwrap_or_default()),
                                        )
                                    })
                                    .into_any_element(),
                                _ => text_content(block.text.as_deref().unwrap_or("")),
                            }
                        }))
                        .when_some(message.error.as_ref(), |d, error| {
                            d.child(
                                div()
                                    .p_3()
                                    .rounded(px(8.))
                                    .bg(rgb(0x2b191c))
                                    .text_color(rgb(0xf87171))
                                    .child(error.clone()),
                            )
                        }),
                ),
        )
        .into_any_element()
}

fn text_content(text: &str) -> AnyElement {
    let mut content = div()
        .text_size(px(14.))
        .line_height(px(23.))
        .flex()
        .flex_col()
        .gap_2();
    for (index, section) in text.split("```").enumerate() {
        if section.is_empty() {
            continue;
        }
        if index % 2 == 1 {
            let (language, code) = section.split_once('\n').unwrap_or(("", section));
            content = content.child(
                div()
                    .border_1()
                    .border_color(rgb(EDGE))
                    .rounded(px(8.))
                    .overflow_hidden()
                    .child(
                        div()
                            .px_3()
                            .py_1()
                            .bg(rgb(HOVER))
                            .text_size(px(11.))
                            .text_color(rgb(MUTED))
                            .child(language.to_owned()),
                    )
                    .child(
                        div()
                            .p_3()
                            .bg(rgb(SURFACE))
                            .font_family("monospace")
                            .text_size(px(12.))
                            .child(code.to_owned()),
                    ),
            );
        } else {
            content = content.child(section.to_owned());
        }
    }
    content.into_any_element()
}
