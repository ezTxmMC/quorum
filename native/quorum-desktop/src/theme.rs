use gpui::{prelude::*, *};
use std::borrow::Cow;
pub const BG: u32 = 0x0e1013;
pub const SURFACE: u32 = 0x14171c;
pub const HOVER: u32 = 0x1e232b;
pub const ACTIVE: u32 = 0x262c36;
pub const EDGE: u32 = 0x232830;
pub const FG: u32 = 0xe4e7ec;
pub const MUTED: u32 = 0x9aa3b0;
pub const SUBTLE: u32 = 0x646d7a;
pub const ACCENT: u32 = 0x7c8cff;
pub struct Assets;
impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        let bytes: &'static [u8] = match path {
            "panel-left" => include_bytes!("../assets/panel-left.svg"),
            "messages-square" => include_bytes!("../assets/messages-square.svg"),
            "files" => include_bytes!("../assets/files.svg"),
            "network" => include_bytes!("../assets/network.svg"),
            "box" => include_bytes!("../assets/box.svg"),
            "wrench" => include_bytes!("../assets/wrench.svg"),
            "settings-2" => include_bytes!("../assets/settings-2.svg"),
            "plus" => include_bytes!("../assets/plus.svg"),
            "search" => include_bytes!("../assets/search.svg"),
            "folder" => include_bytes!("../assets/folder.svg"),
            "folder-open" => include_bytes!("../assets/folder-open.svg"),
            "chevron-down" => include_bytes!("../assets/chevron-down.svg"),
            "chevron-right" => include_bytes!("../assets/chevron-right.svg"),
            "arrow-up" => include_bytes!("../assets/arrow-up.svg"),
            "square" => include_bytes!("../assets/square.svg"),
            "sliders-horizontal" => include_bytes!("../assets/sliders-horizontal.svg"),
            "code-2" => include_bytes!("../assets/code-2.svg"),
            "pin" => include_bytes!("../assets/pin.svg"),
            "x" => include_bytes!("../assets/x.svg"),
            "check" => include_bytes!("../assets/check.svg"),
            "terminal" => include_bytes!("../assets/terminal.svg"),
            "git-branch" => include_bytes!("../assets/git-branch.svg"),
            "external-link" => include_bytes!("../assets/external-link.svg"),
            "logo" => include_bytes!("../assets/logo.svg"),
            _ => return Ok(None),
        };
        Ok(Some(Cow::Borrowed(bytes)))
    }
    fn list(&self, _: &str) -> Result<Vec<SharedString>> {
        Ok(Vec::new())
    }
}
pub fn icon(name: &'static str, size: f32) -> Svg {
    svg()
        .path(name)
        .size(px(size))
        .text_color(rgb(MUTED))
        .flex_shrink_0()
}
pub fn button(id: &'static str, label: &'static str, glyph: &'static str) -> Stateful<Div> {
    button_with_hover(id, label, glyph, HOVER)
}

pub fn button_with_hover(
    id: &'static str,
    label: &'static str,
    glyph: &'static str,
    hover_background: u32,
) -> Stateful<Div> {
    let hint = if id == "window-maximize" {
        "Maximieren / Wiederherstellen"
    } else if !label.is_empty() {
        label
    } else {
        match glyph {
            "panel-left" => "Seitenleiste ein-/ausblenden (Strg+B)",
            "messages-square" => "Neuer Chat (Strg+N)",
            "files" => "Dateien & Editor",
            "sliders-horizontal" | "settings-2" => "Chat-Einstellungen",
            "square" => "Chat stoppen",
            "x" => "Schließen",
            _ => "Öffnen",
        }
    };
    div()
        .id(id)
        .tooltip(move |_, cx| tooltip(hint, cx))
        .flex()
        .items_center()
        .gap_2()
        .px_2()
        .h(px(30.))
        .rounded(px(6.))
        .text_size(px(12.))
        .cursor_pointer()
        .hover(move |style| style.bg(rgb(hover_background)))
        .child(icon(glyph, 15.))
        .child(label)
}

struct TooltipLabel(&'static str);
impl Render for TooltipLabel {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .px_3()
            .py_2()
            .rounded(px(6.))
            .border_1()
            .border_color(rgb(EDGE))
            .bg(rgb(HOVER))
            .text_color(rgb(FG))
            .text_size(px(12.))
            .child(self.0)
    }
}
pub fn tooltip(label: &'static str, cx: &mut App) -> AnyView {
    cx.new(|_| TooltipLabel(label)).into()
}
