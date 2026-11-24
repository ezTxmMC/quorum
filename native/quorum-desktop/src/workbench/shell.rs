use super::Workbench;
use crate::theme::*;
use gpui::{prelude::*, *};
use std::{collections::HashMap, path::Path};

actions!(quorum, [ToggleSidebar, NewChat]);

pub(super) fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("ctrl-b", ToggleSidebar, Some("Workbench")),
        KeyBinding::new("cmd-b", ToggleSidebar, Some("Workbench")),
        KeyBinding::new("ctrl-n", NewChat, Some("Workbench")),
        KeyBinding::new("cmd-n", NewChat, Some("Workbench")),
    ]);
}

enum SidebarRow {
    Project(String),
    Chat(usize),
}

impl Workbench {
    fn toggle_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.plans_open = false;
        self.agents_open = false;
        self.ide_open = !self.ide_open;
        if self.ide_open {
            let root = self.workspace.read(cx).value();
            self.ide.update(cx, |ide, cx| ide.set_root(root, cx));
        } else {
            window.focus(&self.composer.focus_handle(cx));
        }
        cx.notify();
    }

    fn open_plans(&mut self, cx: &mut Context<Self>) {
        let root = self.workspace.read(cx).value();
        let model = self.model.read(cx).value();
        let provider = self.provider.clone();
        self.plans
            .update(cx, |plans, cx| plans.context(root, provider, model, cx));
        self.agents_open = false;
        self.plans_open = true;
        self.ide_open = false;
        cx.notify();
    }

    fn topbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let session = self.selected.and_then(|i| self.archive.sessions.get(i));
        div()
            .h(px(40.))
            .flex_shrink_0()
            .flex()
            .items_center()
            .border_b_1()
            .border_color(rgb(EDGE))
            .px_2()
            .gap_2()
            .child(
                button("sidebar-toggle", "", "panel-left").on_click(cx.listener(
                    |view, _, _, cx| {
                        view.sidebar_open = !view.sidebar_open;
                        cx.notify();
                    },
                )),
            )
            .child(img(ImageSource::Resource(Resource::Embedded("logo".into()))).size(px(22.)))
            .child(
                div()
                    .text_size(px(12.5))
                    .font_weight(FontWeight::EXTRA_BOLD)
                    .child("QUORUM"),
            )
            .child(
                div()
                    .on_mouse_down(MouseButton::Left, |event, window, _| {
                        if event.click_count == 2 {
                            window.zoom_window();
                        } else {
                            window.start_window_move();
                        }
                    })
                    .ml_4()
                    .min_w_0()
                    .flex_1()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(div().size(px(7.)).rounded_full().bg(rgb(
                        if self.provider == "claude" {
                            0xd99b7b
                        } else {
                            0x9fc5b4
                        },
                    )))
                    .child(
                        div()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .child(
                                div().text_size(px(12.5)).text_ellipsis().child(
                                    session
                                        .map(|s| s.title.clone())
                                        .unwrap_or("Neuer Chat".into()),
                                ),
                            )
                            .child(
                                div()
                                    .text_size(px(10.5))
                                    .text_color(rgb(SUBTLE))
                                    .child(self.model_label(cx)),
                            ),
                    ),
            )
            .child(
                button("project-picker", "Ordner wählen", "folder-open")
                    .on_click(cx.listener(|view, _, _, cx| view.pick_folder(cx))),
            )
            .child(
                button("plans-toggle", "Pläne", "files")
                    .on_click(cx.listener(|view, _, _, cx| view.open_plans(cx))),
            )
            .child(
                button("editor-toggle", "", "files")
                    .on_click(cx.listener(|view, _, window, cx| view.toggle_editor(window, cx))),
            )
            .child(
                button("options-toggle", "", "sliders-horizontal").on_click(cx.listener(
                    |view, _, _, cx| {
                        view.options_open = !view.options_open;
                        cx.notify();
                    },
                )),
            )
            .child(
                div()
                    .id("window-minimize")
                    .w(px(32.))
                    .h(px(32.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(4.))
                    .cursor_pointer()
                    .hover(|s| s.bg(rgb(HOVER)))
                    .on_click(|_, window, _| window.minimize_window())
                    .child("−"),
            )
            .child(
                button("window-maximize", "", "square")
                    .on_click(|_, window, _| window.zoom_window()),
            )
            .child(
                button_with_hover("window-close", "", "x", 0xe5484d).on_click(cx.listener(
                    |view, _, window, cx| {
                        if view.should_close(window, cx) {
                            window.remove_window();
                            cx.quit();
                        }
                    },
                )),
            )
    }

    fn rail(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .w(px(44.))
            .flex_shrink_0()
            .h_full()
            .flex()
            .flex_col()
            .items_center()
            .py_2()
            .gap_1()
            .border_r_1()
            .border_color(rgb(EDGE))
            .bg(rgb(SURFACE))
            .child(
                button("rail-chat", "", "messages-square")
                    .on_click(cx.listener(|view, _, _, cx| view.new_chat(cx))),
            )
            .child(
                button("rail-ide", "", "files")
                    .when(self.ide_open, |d| d.bg(rgb(ACTIVE)))
                    .on_click(cx.listener(|view, _, _, cx| view.open_plans(cx))),
            )
            .child(
                button("rail-agents", "", "network").on_click(cx.listener(|view, _, _, cx| {
                    view.agents_open = true;
                    view.plans_open = false;
                    view.ide_open = false;
                    cx.notify();
                })),
            )
            .children(
                [
                    ("box", "Modelle · noch nicht nativ verfügbar"),
                    ("wrench", "Werkzeuge · noch nicht nativ verfügbar"),
                ]
                .map(|(name, hint)| {
                    div()
                        .id(name)
                        .tooltip(move |_, cx| tooltip(hint, cx))
                        .h(px(36.))
                        .w(px(36.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .opacity(0.3)
                        .child(icon(name, 20.))
                }),
            )
            .child(div().flex_1())
            .child(
                button("rail-settings", "", "settings-2").on_click(cx.listener(
                    |view, _, _, cx| {
                        view.options_open = !view.options_open;
                        cx.notify();
                    },
                )),
            )
    }

    fn sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let query = self.search.read(cx).value().to_lowercase();
        let mut groups: Vec<(String, Vec<usize>)> = Vec::new();
        let mut positions = HashMap::new();
        let mut sorted: Vec<_> = self.archive.sessions.iter().enumerate().collect();
        sorted.sort_by_key(|(_, session)| std::cmp::Reverse(session.updated_at));
        for (index, session) in sorted {
            if session.messages.is_empty()
                || (!query.is_empty() && !session.title.to_lowercase().contains(&query))
            {
                continue;
            }
            let position = *positions.entry(session.cwd.clone()).or_insert_with(|| {
                groups.push((session.cwd.clone(), Vec::new()));
                groups.len() - 1
            });
            groups[position].1.push(index);
        }
        let mut entries = Vec::new();
        for (path, chats) in groups {
            let collapsed = self.collapsed_projects.contains(&path) && query.is_empty();
            entries.push(SidebarRow::Project(path));
            if !collapsed {
                entries.extend(chats.into_iter().map(SidebarRow::Chat));
            }
        }
        let collapsed = self.collapsed_projects.clone();
        let archive = self.archive.clone();
        let selected = self.selected;
        let active = self.active.clone();
        let view = cx.entity();
        div()
            .w(px(280.))
            .flex_shrink_0()
            .h_full()
            .flex()
            .flex_col()
            .border_r_1()
            .border_color(rgb(EDGE))
            .bg(rgb(SURFACE))
            .child(
                div()
                    .p_3()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .text_size(px(12.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Chats"),
                    )
                    .child(
                        button("new-chat", "Neuer Chat", "plus").on_click(cx.listener(
                            |view, _, window, cx| {
                                view.new_chat(cx);
                                window.focus(&view.composer.focus_handle(cx));
                            },
                        )),
                    ),
            )
            .child(
                div()
                    .mx_3()
                    .mb_2()
                    .border_1()
                    .border_color(rgb(EDGE))
                    .rounded(px(6.))
                    .overflow_hidden()
                    .child(self.search.clone()),
            )
            .child(
                div()
                    .px_3()
                    .py_2()
                    .flex()
                    .items_center()
                    .justify_between()
                    .text_size(px(11.))
                    .text_color(rgb(SUBTLE))
                    .child("NACH PROJEKT")
                    .child("Zuletzt aktiv"),
            )
            .child(
                uniform_list("session-list", entries.len(), move |range, _, _| {
                    range
                        .map(|row| match &entries[row] {
                            SidebarRow::Project(path) => {
                                let path_copy = path.clone();
                                let view = view.clone();
                                div()
                                    .id(row)
                                    .cursor_pointer()
                                    .on_click(move |_, _, cx| {
                                        view.update(cx, |view, cx| {
                                            if !view.collapsed_projects.remove(&path_copy) {
                                                view.collapsed_projects.insert(path_copy.clone());
                                            }
                                            cx.notify();
                                        })
                                    })
                                    .h(px(36.))
                                    .px_3()
                                    .flex()
                                    .items_center()
                                    .gap_2()
                                    .text_size(px(11.))
                                    .text_color(rgb(MUTED))
                                    .child(icon(
                                        if collapsed.contains(path) {
                                            "chevron-right"
                                        } else {
                                            "chevron-down"
                                        },
                                        12.,
                                    ))
                                    .child(icon("folder", 14.))
                                    .child(
                                        div().min_w_0().text_ellipsis().child(project_name(path)),
                                    )
                                    .into_any_element()
                            }
                            SidebarRow::Chat(index) => {
                                let index = *index;
                                let session = &archive.sessions[index];
                                let view = view.clone();
                                div()
                                    .id(row)
                                    .h(px(36.))
                                    .mx_2()
                                    .px_2()
                                    .rounded(px(6.))
                                    .flex()
                                    .items_center()
                                    .gap_2()
                                    .bg(rgb(if selected == Some(index) {
                                        ACTIVE
                                    } else {
                                        SURFACE
                                    }))
                                    .hover(|style| style.bg(rgb(HOVER)))
                                    .cursor_pointer()
                                    .on_click(move |_, _, cx| {
                                        view.update(cx, |view, cx| {
                                            view.select(index, cx);
                                            view.ide_open = false;
                                            view.plans_open = false;
                                            view.agents_open = false;
                                        })
                                    })
                                    .child(div().size(px(5.)).flex_shrink_0().rounded_full().bg(
                                        rgb(if active.contains(&session.id) {
                                            0x4ade80
                                        } else {
                                            SUBTLE
                                        }),
                                    ))
                                    .child(
                                        div()
                                            .min_w_0()
                                            .flex_1()
                                            .text_ellipsis()
                                            .text_size(px(12.))
                                            .child(session.title.clone()),
                                    )
                                    .into_any_element()
                            }
                        })
                        .collect()
                })
                .flex_1()
                .min_h_0(),
            )
            .child(
                div()
                    .h(px(35.))
                    .px_3()
                    .border_t_1()
                    .border_color(rgb(EDGE))
                    .flex()
                    .items_center()
                    .text_size(px(11.))
                    .text_color(rgb(SUBTLE))
                    .child(format!(
                        "{} Chats",
                        self.archive
                            .sessions
                            .iter()
                            .filter(|s| !s.messages.is_empty())
                            .count()
                    )),
            )
    }

    fn model_label(&self, cx: &App) -> String {
        match self.model.read(cx).value().as_str() {
            "claude-fable-5-2" => "Claude Fable 5.2".into(),
            "" => format!("{} · Standardmodell", self.provider),
            model => model.into(),
        }
    }

    fn empty_chat(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let cwd = self.workspace.read(cx).value();
        div()
            .w_full()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .px_6()
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .justify_center()
                    .gap_2()
                    .mb_5()
                    .children(
                        [
                            ("claude", "Claude", "Anthropic"),
                            ("codex", "Codex", "OpenAI"),
                        ]
                        .map(|(id, name, vendor)| {
                            div()
                                .id(id)
                                .w(px(144.))
                                .p_4()
                                .rounded(px(14.))
                                .border_1()
                                .border_color(rgb(if self.provider == id { ACCENT } else { EDGE }))
                                .bg(rgb(if self.provider == id { HOVER } else { BG }))
                                .cursor_pointer()
                                .hover(|s| s.bg(rgb(HOVER)))
                                .flex()
                                .flex_col()
                                .items_center()
                                .gap_2()
                                .on_click(cx.listener(move |view, _, _, cx| {
                                    view.provider = id.into();
                                    view.model.update(cx, |input, cx| {
                                        input.set_value(
                                            if id == "claude" {
                                                "claude-fable-5-2"
                                            } else {
                                                ""
                                            }
                                            .into(),
                                            cx,
                                        )
                                    });
                                    cx.notify();
                                }))
                                .child(
                                    div()
                                        .text_size(px(22.))
                                        .text_color(rgb(if id == "claude" {
                                            0xd99b7b
                                        } else {
                                            0x9fc5b4
                                        }))
                                        .child(if id == "claude" { "✳" } else { "◉" }),
                                )
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .child(name),
                                )
                                .child(
                                    div()
                                        .text_size(px(11.))
                                        .text_color(rgb(SUBTLE))
                                        .child(vendor),
                                )
                        }),
                    ),
            )
            .child(
                div()
                    .text_size(px(22.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .mb_2()
                    .child("Coding"),
            )
            .child(
                div()
                    .text_color(rgb(MUTED))
                    .mb_3()
                    .child("Code schreiben, Projekte verstehen und gemeinsam entwickeln"),
            )
            .child(
                button("empty-project", "Ordner wählen", "folder-open")
                    .border_1()
                    .border_color(rgb(EDGE))
                    .on_click(cx.listener(|view, _, _, cx| view.pick_folder(cx))),
            )
            .when(!cwd.is_empty(), |d| {
                d.child(
                    div()
                        .mt_2()
                        .max_w(px(600.))
                        .text_ellipsis()
                        .text_size(px(12.))
                        .text_color(rgb(MUTED))
                        .child(cwd),
                )
            })
            .child(
                div()
                    .mt_6()
                    .text_size(px(12.))
                    .text_color(rgb(SUBTLE))
                    .child("Tipp: @ Dateien aus dem Editor einfügen · ↑ / ↓ frühere Nachrichten"),
            )
    }

    fn composer_view(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let running = self
            .selected_id()
            .is_some_and(|id| self.active.contains(&id));
        div()
            .w_full()
            .max_w(px(1152.))
            .mx_auto()
            .px_4()
            .pb_4()
            .child(
                div()
                    .rounded(px(18.))
                    .border_1()
                    .border_color(rgb(0x333a45))
                    .bg(rgb(SURFACE))
                    .overflow_hidden()
                    .when(!self.files.is_empty(), |d| {
                        d.child(div().p_2().flex().flex_wrap().gap_2().children(
                            self.files.iter().enumerate().map(|(index, file)| {
                                let preview = if file.is_image() {
                                    super::attachments::Preview::Image(file.path.clone())
                                } else {
                                    super::attachments::Preview::Text(
                                        file.name.clone(),
                                        file.text.clone().unwrap_or_default(),
                                    )
                                };
                                div()
                                    .id(index)
                                    .px_2()
                                    .py_1()
                                    .rounded(px(6.))
                                    .bg(rgb(ACTIVE))
                                    .flex()
                                    .items_center()
                                    .gap_2()
                                    .child(
                                        div()
                                            .cursor_pointer()
                                            .on_mouse_down(
                                                MouseButton::Left,
                                                cx.listener(move |view, _, _, cx| {
                                                    view.preview = Some(preview.clone());
                                                    cx.notify();
                                                }),
                                            )
                                            .child(file.name.clone()),
                                    )
                                    .child(button("remove-file", "", "x").on_click(cx.listener(
                                        move |view, _, _, cx| {
                                            if index < view.files.len() {
                                                view.files.remove(index);
                                            }
                                            cx.notify();
                                        },
                                    )))
                            }),
                        ))
                    })
                    .child(div().px_3().pt_3().pb_2().child(self.composer.clone()))
                    .child(
                        div()
                            .px_2()
                            .pb_2()
                            .flex()
                            .items_center()
                            .gap_1()
                            .child(
                                button("attach-files", "Anhängen", "plus")
                                    .on_click(cx.listener(|view, _, _, cx| view.pick_files(cx))),
                            )
                            .child(button("mode", "Coding", "code-2"))
                            .child(
                                button("model", "", "chevron-down")
                                    .child(self.model_label(cx))
                                    .on_click(cx.listener(|view, _, _, cx| {
                                        view.options_open = !view.options_open;
                                        cx.notify();
                                    })),
                            )
                            .child(
                                button(
                                    "permissions",
                                    if self.read_only {
                                        "Nur lesen"
                                    } else {
                                        "Projekt bearbeiten"
                                    },
                                    "check",
                                )
                                .on_click(cx.listener(
                                    |view, _, _, cx| {
                                        view.options_open = true;
                                        cx.notify();
                                    },
                                )),
                            )
                            .child(div().flex_1())
                            .when(running, |d| {
                                d.child(
                                    button("stop", "", "square")
                                        .text_color(rgb(0xf87171))
                                        .on_click(cx.listener(|view, _, _, cx| view.stop(cx))),
                                )
                            })
                            .child(
                                div()
                                    .id("send")
                                    .w(px(44.))
                                    .h(px(32.))
                                    .rounded_full()
                                    .bg(rgb(ACCENT))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .cursor_pointer()
                                    .hover(|s| s.bg(rgb(0x94a0ff)))
                                    .on_click(cx.listener(|view, _, _, cx| view.send(cx)))
                                    .child(icon("arrow-up", 17.).text_color(rgb(0x0b0d10))),
                            ),
                    ),
            )
    }

    fn chat(&self, cx: &mut Context<Self>) -> AnyElement {
        let empty = self
            .selected
            .and_then(|i| self.archive.sessions.get(i))
            .is_none_or(|s| s.messages.is_empty());
        let archive = self.archive.clone();
        let selected = self.selected;
        let weak = cx.entity().downgrade();
        div()
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .flex_col()
            .child(if empty {
                self.empty_chat(cx).into_any_element()
            } else {
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .child(
                        list(self.scroll.clone(), move |index, _, _| {
                            selected
                                .and_then(|selected| archive.sessions.get(selected))
                                .and_then(|session| {
                                    session.messages.get(index).map(|message| {
                                        super::message::message(
                                            message,
                                            &session.provider,
                                            weak.clone(),
                                        )
                                    })
                                })
                                .unwrap_or_else(|| div().into_any_element())
                        })
                        .flex_1()
                        .min_h_0(),
                    )
                    .into_any_element()
            })
            .when(!self.follow, |d| {
                d.child(div().flex().justify_center().py_1().child(
                    button("scroll-bottom", "Zum Ende", "chevron-down").on_click(cx.listener(
                        |view, _, _, cx| {
                            view.follow = true;
                            view.follow_end();
                            cx.notify();
                        },
                    )),
                ))
            })
            .child(self.composer_view(cx))
            .into_any_element()
    }

    fn options(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .w(px(300.))
            .flex_shrink_0()
            .h_full()
            .bg(rgb(SURFACE))
            .border_l_1()
            .border_color(rgb(EDGE))
            .flex()
            .flex_col()
            .child(
                div()
                    .id("chat-options")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p_3()
                    .flex()
                    .items_center()
                    .justify_between()
                    .border_b_1()
                    .border_color(rgb(EDGE))
                    .child("Chat-Einstellungen")
                    .child(button("close-options", "", "x").on_click(cx.listener(
                        |view, _, _, cx| {
                            view.options_open = false;
                            cx.notify();
                        },
                    ))),
            )
            .child(
                div()
                    .p_3()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(div().text_color(rgb(MUTED)).child("Projektordner"))
                    .child(self.workspace.clone())
                    .child(
                        button("choose-folder", "Ordner auswählen", "folder-open")
                            .on_click(cx.listener(|view, _, _, cx| view.pick_folder(cx))),
                    )
                    .child(
                        button(
                            "access-mode",
                            if self.read_only {
                                "Nur lesen"
                            } else {
                                "Projekt bearbeiten"
                            },
                            "check",
                        )
                        .on_click(cx.listener(|view, _, _, cx| {
                            view.read_only = !view.read_only;
                            cx.notify();
                        })),
                    )
                    .child(div().text_color(rgb(MUTED)).child("Modell"))
                    .child(self.model.clone())
                    .when(self.provider == "claude", |d| {
                        d.children(
                            [
                                ("claude-fable-5-2", "Claude Fable 5.2"),
                                ("claude-opus-5-5", "Claude Opus 5.5"),
                                ("claude-sonnet-5-5", "Claude Sonnet 5.5"),
                                ("claude-haiku-5-5", "Claude Haiku 5.5"),
                            ]
                            .map(|(id, label)| {
                                div()
                                    .id(id)
                                    .px_3()
                                    .py_2()
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .bg(rgb(if self.model.read(cx).value() == id {
                                        ACTIVE
                                    } else {
                                        SURFACE
                                    }))
                                    .hover(|s| s.bg(rgb(HOVER)))
                                    .child(label)
                                    .on_click(cx.listener(move |view, _, _, cx| {
                                        view.model
                                            .update(cx, |input, cx| input.set_value(id.into(), cx));
                                        cx.notify();
                                    }))
                            }),
                        )
                    })
                    .child(div().text_size(px(11.)).text_color(rgb(SUBTLE)).child(
                        "Anbieter und Modell werden beim Senden für diesen Chat übernommen.",
                    ))
                    .child(div().mt_3().text_color(rgb(MUTED)).child("CLI-Anwendungen"))
                    .child(self.claude_binary.clone())
                    .child(self.codex_binary.clone())
                    .child(
                        button("save-binaries", "CLI-Pfade speichern", "check")
                            .on_click(cx.listener(|view, _, _, cx| view.save_binaries(cx))),
                    )
                    .when(self.selected.is_some(), |d| {
                        d.child(self.title_input.clone())
                            .child(
                                button("rename-chat", "Chat umbenennen", "code-2")
                                    .on_click(cx.listener(|view, _, _, cx| view.rename_chat(cx))),
                            )
                            .child(
                                button("delete-chat", "Chat löschen", "x")
                                    .text_color(rgb(0xf87171))
                                    .on_click(cx.listener(|view, _, window, cx| {
                                        view.delete_chat(window, cx)
                                    })),
                            )
                    }),
            )
    }

    pub(super) fn shell(&self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .key_context("Workbench")
            .on_action(cx.listener(|view, _: &ToggleSidebar, _, cx| {
                view.sidebar_open = !view.sidebar_open;
                cx.notify();
            }))
            .on_action(cx.listener(|view, _: &NewChat, window, cx| {
                view.new_chat(cx);
                window.focus(&view.composer.focus_handle(cx));
            }))
            .bg(rgb(BG))
            .text_color(rgb(FG))
            .text_size(px(13.))
            .child(self.topbar(cx))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .overflow_hidden()
                    .child(self.rail(cx))
                    .when(self.sidebar_open, |d| d.child(self.sidebar(cx)))
                    .child(if self.agents_open {
                        self.agents_view(cx)
                    } else if self.plans_open {
                        div()
                            .flex_1()
                            .min_w_0()
                            .h_full()
                            .child(self.plans.clone())
                            .into_any_element()
                    } else if self.ide_open {
                        div()
                            .flex_1()
                            .min_w_0()
                            .h_full()
                            .child(self.ide.clone())
                            .into_any_element()
                    } else {
                        self.chat(cx)
                    })
                    .when(self.options_open, |d| d.child(self.options(cx))),
            )
            .child(
                div()
                    .h(px(24.))
                    .flex_shrink_0()
                    .px_3()
                    .border_t_1()
                    .border_color(rgb(EDGE))
                    .flex()
                    .items_center()
                    .gap_2()
                    .text_size(px(11.))
                    .text_color(rgb(MUTED))
                    .child(icon("folder", 12.))
                    .child(project_name(&self.workspace.read(cx).value()))
                    .child(div().flex_1())
                    .child(self.status.clone())
                    .child(
                        div()
                            .ml_3()
                            .text_color(rgb(0x4ade80))
                            .child(format!("● {} aktiv", self.active.len())),
                    ),
            )
            .when(self.preview.is_some(), |d| d.child(self.preview_view(cx)))
    }
}

fn project_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Ohne Projekt".into())
}
