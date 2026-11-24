use gpui::{self, prelude::*, *};
use quorum_core::workspace::{
    buffer::TextBuffer,
    syntax::{self, Language, TokenKind},
};
use std::collections::HashMap;
use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;

const LINE_HEIGHT: f32 = 22.;
const GUTTER: f32 = 58.;

actions!(
    native_editor,
    [
        Left,
        Right,
        Up,
        Down,
        SelectLeft,
        SelectRight,
        SelectUp,
        SelectDown,
        Home,
        End,
        SelectAll,
        Backspace,
        Delete,
        Newline,
        InsertNewline,
        Tab,
        Copy,
        Cut,
        Paste,
        Undo,
        Redo,
        Save,
        Find
    ]
);

pub enum EditorEvent {
    Changed,
    Save,
    Find,
    Submitted,
}

pub struct CodeEditor {
    buffer: TextBuffer,
    composer: bool,
    language: Option<Language>,
    history: Vec<SharedString>,
    history_index: usize,
    history_draft: String,
    focus: FocusHandle,
    marked: Option<Range<usize>>,
    bounds: Option<Bounds<Pixels>>,
    scroll_x: f32,
    scroll_y: f32,
    selecting: bool,
    layouts: HashMap<usize, ShapedLine>,
    error: Option<String>,
}

impl EventEmitter<EditorEvent> for CodeEditor {}
impl Focusable for CodeEditor {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl CodeEditor {
    pub fn new(text: String, cx: &mut Context<Self>) -> Self {
        Self {
            buffer: TextBuffer::new(text),
            composer: false,
            language: None,
            history: Vec::new(),
            history_index: 0,
            history_draft: String::new(),
            focus: cx.focus_handle(),
            marked: None,
            bounds: None,
            scroll_x: 0.,
            scroll_y: 0.,
            selecting: false,
            layouts: HashMap::new(),
            error: None,
        }
    }
    pub fn for_file(text: String, path: &str, cx: &mut Context<Self>) -> Self {
        let mut editor = Self::new(text, cx);
        editor.language = Language::for_path(path);
        editor
    }
    pub fn composer(cx: &mut Context<Self>) -> Self {
        let mut editor = Self::new(String::new(), cx);
        editor.composer = true;
        editor
    }
    fn gutter(&self) -> f32 {
        if self.composer { 4. } else { GUTTER }
    }
    pub fn value(&self) -> String {
        self.text().to_owned()
    }
    pub fn set_value(&mut self, text: String, cx: &mut Context<Self>) {
        self.buffer = TextBuffer::new(text);
        let _ = self.buffer.move_to(self.buffer.text().len(), false);
        self.marked = None;
        self.layouts.clear();
        self.reveal();
        cx.notify();
    }
    pub fn history(&mut self, history: Vec<SharedString>) {
        self.history = history;
        self.history_index = self.history.len();
    }
    pub fn sent(&mut self, cx: &mut Context<Self>) {
        if !self.text().is_empty() {
            self.history.push(self.text().to_owned().into());
        }
        self.history_index = self.history.len();
        self.history_draft.clear();
        self.set_value(String::new(), cx);
    }
    fn recall(&mut self, down: bool, cx: &mut Context<Self>) -> bool {
        if !self.composer || self.history.is_empty() || self.marked.is_some() {
            return false;
        }
        let line = self.buffer.line_of(self.buffer.cursor());
        if (!down && line != 0) || (down && line + 1 != self.buffer.line_count()) {
            return false;
        }
        if self.history_index == self.history.len() {
            if down {
                return false;
            }
            self.history_draft = self.value();
        }
        self.history_index = if down {
            (self.history_index + 1).min(self.history.len())
        } else {
            self.history_index.saturating_sub(1)
        };
        let value = self
            .history
            .get(self.history_index)
            .map(ToString::to_string)
            .unwrap_or_else(|| self.history_draft.clone());
        self.set_value(value, cx);
        true
    }
    pub fn position(&self) -> (u32, u32) {
        let line = self.buffer.line_of(self.buffer.cursor());
        let column = self.text()[self.buffer.line_start(line)..self.buffer.cursor()]
            .encode_utf16()
            .count();
        (line as u32, column as u32)
    }
    pub fn text(&self) -> &str {
        self.buffer.text()
    }
    pub fn find_next(&mut self, query: &str, cx: &mut Context<Self>) {
        if query.is_empty() {
            return;
        }
        let start = self.buffer.selection().end;
        let index = self.text()[start..]
            .find(query)
            .map(|offset| offset + start)
            .or_else(|| self.text()[..start].find(query));
        if let Some(index) = index {
            let _ = self.buffer.select(index, index + query.len());
            self.reveal();
            cx.notify();
        }
    }
    fn changed(&mut self, cx: &mut Context<Self>) {
        self.marked = None;
        self.reveal();
        cx.emit(EditorEvent::Changed);
        cx.notify();
    }
    fn edit(&mut self, range: Range<usize>, text: &str, cx: &mut Context<Self>) {
        match self.buffer.replace(range, text) {
            Ok(()) => {
                self.error = None;
                self.changed(cx);
            }
            Err(error) => {
                self.error = Some(error.to_string());
                cx.notify();
            }
        }
    }
    fn reveal(&mut self) {
        let line = self.buffer.line_of(self.buffer.cursor());
        let Some(bounds) = self.bounds else {
            return;
        };
        let height = f32::from(bounds.size.height);
        let top = line as f32 * LINE_HEIGHT;
        if top < self.scroll_y {
            self.scroll_y = top;
        }
        if top + LINE_HEIGHT > self.scroll_y + height {
            self.scroll_y = (top + LINE_HEIGHT - height).max(0.);
        }
        let column = self.buffer.cursor() - self.buffer.line_start(line);
        let x = self
            .layouts
            .get(&line)
            .map(|layout| f32::from(layout.x_for_index(column)))
            .unwrap_or(column as f32 * 8.);
        let width = (f32::from(bounds.size.width) - self.gutter() - 12.).max(20.);
        if x < self.scroll_x {
            self.scroll_x = x;
        }
        if x > self.scroll_x + width {
            self.scroll_x = (x - width).max(0.);
        }
    }
    fn horizontal(&mut self, right: bool, extend: bool, cx: &mut Context<Self>) {
        let selection = self.buffer.selection();
        let offset = match (right, extend, selection.is_empty()) {
            (true, false, false) => selection.end,
            (false, false, false) => selection.start,
            (true, _, _) => self.buffer.next_boundary(),
            _ => self.buffer.previous_boundary(),
        };
        let _ = self.buffer.move_to(offset, extend);
        self.reveal();
        cx.notify();
    }
    fn vertical(&mut self, down: bool, extend: bool, cx: &mut Context<Self>) {
        let line = self.buffer.line_of(self.buffer.cursor());
        let target = if down {
            (line + 1).min(self.buffer.line_count() - 1)
        } else {
            line.saturating_sub(1)
        };
        let column = self.text()[self.buffer.line_start(line)..self.buffer.cursor()]
            .graphemes(true)
            .count();
        let target_text = self.buffer.line(target);
        let offset = target_text
            .grapheme_indices(true)
            .nth(column)
            .map(|(offset, _)| offset)
            .unwrap_or(target_text.len());
        let _ = self
            .buffer
            .move_to(self.buffer.line_start(target) + offset, extend);
        self.reveal();
        cx.notify();
    }
    fn key_left(&mut self, _: &Left, _: &mut Window, cx: &mut Context<Self>) {
        self.horizontal(false, false, cx);
    }
    fn key_right(&mut self, _: &Right, _: &mut Window, cx: &mut Context<Self>) {
        self.horizontal(true, false, cx);
    }
    fn key_up(&mut self, _: &Up, _: &mut Window, cx: &mut Context<Self>) {
        if self.recall(false, cx) {
            return;
        }
        self.vertical(false, false, cx);
    }
    fn key_down(&mut self, _: &Down, _: &mut Window, cx: &mut Context<Self>) {
        if self.recall(true, cx) {
            return;
        }
        self.vertical(true, false, cx);
    }
    fn select_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.horizontal(false, true, cx);
    }
    fn select_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        self.horizontal(true, true, cx);
    }
    fn select_up(&mut self, _: &SelectUp, _: &mut Window, cx: &mut Context<Self>) {
        self.vertical(false, true, cx);
    }
    fn select_down(&mut self, _: &SelectDown, _: &mut Window, cx: &mut Context<Self>) {
        self.vertical(true, true, cx);
    }
    fn home(&mut self, _: &Home, _: &mut Window, cx: &mut Context<Self>) {
        let start = self
            .buffer
            .line_start(self.buffer.line_of(self.buffer.cursor()));
        let _ = self.buffer.move_to(start, false);
        self.reveal();
        cx.notify();
    }
    fn end(&mut self, _: &End, _: &mut Window, cx: &mut Context<Self>) {
        let end = self
            .buffer
            .line_range(self.buffer.line_of(self.buffer.cursor()))
            .end;
        let _ = self.buffer.move_to(end, false);
        self.reveal();
        cx.notify();
    }
    fn all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        let _ = self.buffer.select(0, self.text().len());
        cx.notify();
    }
    fn backspace(&mut self, _: &Backspace, _: &mut Window, cx: &mut Context<Self>) {
        let mut range = self.buffer.selection();
        if range.is_empty() {
            range.start = self.buffer.previous_boundary();
        }
        self.edit(range, "", cx);
    }
    fn delete(&mut self, _: &Delete, _: &mut Window, cx: &mut Context<Self>) {
        let mut range = self.buffer.selection();
        if range.is_empty() {
            range.end = self.buffer.next_boundary();
        }
        self.edit(range, "", cx);
    }
    fn newline(&mut self, _: &Newline, window: &mut Window, cx: &mut Context<Self>) {
        if self.marked.is_some() {
            return;
        }
        if self.composer {
            cx.emit(EditorEvent::Submitted);
            return;
        }
        self.insert_newline(&InsertNewline, window, cx);
    }
    fn insert_newline(&mut self, _: &InsertNewline, _: &mut Window, cx: &mut Context<Self>) {
        let line = self.buffer.line(self.buffer.line_of(self.buffer.cursor()));
        let indent = line
            .chars()
            .take_while(|character| matches!(character, ' ' | '\t'))
            .collect::<String>();
        let value = format!("{}{indent}", self.buffer.newline());
        self.edit(self.buffer.selection(), &value, cx);
    }
    fn tab(&mut self, _: &Tab, _: &mut Window, cx: &mut Context<Self>) {
        let selection = self.buffer.selection();
        if selection.is_empty() {
            self.edit(selection, "    ", cx);
            return;
        }
        let first = self.buffer.line_of(selection.start);
        let mut last = self.buffer.line_of(selection.end);
        if last > first && selection.end == self.buffer.line_start(last) {
            last -= 1;
        }
        let range = self.buffer.line_start(first)..self.buffer.line_range(last).end;
        let text = self.text()[range.clone()]
            .split_inclusive('\n')
            .map(|line| format!("    {line}"))
            .collect::<String>();
        self.edit(range, &text, cx);
    }
    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(
            self.text()[self.buffer.selection()].to_owned(),
        ));
    }
    fn cut(&mut self, _: &Cut, window: &mut Window, cx: &mut Context<Self>) {
        self.copy(&Copy, window, cx);
        self.edit(self.buffer.selection(), "", cx);
    }
    fn paste(&mut self, _: &Paste, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.edit(self.buffer.selection(), &text, cx);
        }
    }
    fn undo(&mut self, _: &Undo, _: &mut Window, cx: &mut Context<Self>) {
        self.buffer.undo();
        self.changed(cx);
    }
    fn redo(&mut self, _: &Redo, _: &mut Window, cx: &mut Context<Self>) {
        self.buffer.redo();
        self.changed(cx);
    }
    fn save(&mut self, _: &Save, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(EditorEvent::Save);
    }
    fn find(&mut self, _: &Find, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(EditorEvent::Find);
    }
    fn point_offset(&self, position: Point<Pixels>) -> usize {
        let Some(bounds) = self.bounds else {
            return self.buffer.cursor();
        };
        let line = (((f32::from(position.y - bounds.top()) + self.scroll_y) / LINE_HEIGHT).max(0.)
            as usize)
            .min(self.buffer.line_count() - 1);
        let x = position.x - bounds.left() - px(self.gutter()) + px(self.scroll_x);
        let offset = self
            .layouts
            .get(&line)
            .map(|layout| layout.closest_index_for_x(x))
            .unwrap_or(0)
            .min(self.buffer.line(line).len());
        self.buffer.line_start(line) + offset
    }
    fn mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus);
        self.selecting = true;
        let offset = self.point_offset(event.position);
        let _ = self.buffer.move_to(offset, event.modifiers.shift);
        cx.notify();
    }
    fn mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selecting {
            return;
        }
        let offset = self.point_offset(event.position);
        let _ = self.buffer.move_to(offset, true);
        cx.notify();
    }
    fn mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.selecting = false;
    }
    fn wheel(&mut self, event: &ScrollWheelEvent, _: &mut Window, cx: &mut Context<Self>) {
        let delta = event.delta.pixel_delta(px(LINE_HEIGHT));
        let height = self
            .bounds
            .map(|bounds| f32::from(bounds.size.height))
            .unwrap_or(0.);
        self.scroll_y = (self.scroll_y - f32::from(delta.y)).clamp(
            0.,
            (self.buffer.line_count() as f32 * LINE_HEIGHT - height).max(0.),
        );
        self.scroll_x = (self.scroll_x - f32::from(delta.x)).max(0.);
        cx.stop_propagation();
        cx.notify();
    }
}

impl EntityInputHandler for CodeEditor {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.buffer.utf16_to_byte(range.start)..self.buffer.utf16_to_byte(range.end);
        *actual =
            Some(self.buffer.byte_to_utf16(range.start)..self.buffer.byte_to_utf16(range.end));
        Some(self.text()[range].to_owned())
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let range = self.buffer.selection();
        Some(UTF16Selection {
            range: self.buffer.byte_to_utf16(range.start)..self.buffer.byte_to_utf16(range.end),
            reversed: self.buffer.cursor() < self.buffer.anchor(),
        })
    }
    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.as_ref().map(|range| {
            self.buffer.byte_to_utf16(range.start)..self.buffer.byte_to_utf16(range.end)
        })
    }
    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        self.marked = None;
    }
    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range
            .map(|range| {
                self.buffer.utf16_to_byte(range.start)..self.buffer.utf16_to_byte(range.end)
            })
            .or(self.marked.clone())
            .unwrap_or_else(|| self.buffer.selection());
        self.edit(range, text, cx);
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selected: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range
            .map(|range| {
                self.buffer.utf16_to_byte(range.start)..self.buffer.utf16_to_byte(range.end)
            })
            .or(self.marked.clone())
            .unwrap_or_else(|| self.buffer.selection());
        let start = range.start;
        self.edit(range, text, cx);
        if self.error.is_some() {
            return;
        }
        self.marked = (!text.is_empty()).then_some(start..start + text.len());
        if let Some(selected) = selected {
            let prefix = self.buffer.byte_to_utf16(start);
            let _ = self.buffer.select(
                self.buffer.utf16_to_byte(prefix + selected.start),
                self.buffer.utf16_to_byte(prefix + selected.end),
            );
        }
    }
    fn bounds_for_range(
        &mut self,
        range: Range<usize>,
        bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let offset = self.buffer.utf16_to_byte(range.start);
        let line = self.buffer.line_of(offset);
        let x = self
            .layouts
            .get(&line)?
            .x_for_index(offset - self.buffer.line_start(line));
        Some(Bounds::new(
            point(
                bounds.left() + px(self.gutter()) + x - px(self.scroll_x),
                bounds.top() + px(line as f32 * LINE_HEIGHT - self.scroll_y),
            ),
            size(px(2.), px(LINE_HEIGHT)),
        ))
    }
    fn character_index_for_point(
        &mut self,
        point: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        Some(self.buffer.byte_to_utf16(self.point_offset(point)))
    }
}

struct EditorSurface(Entity<CodeEditor>);
struct DrawState {
    lines: Vec<(usize, Point<Pixels>, ShapedLine)>,
    selection: Vec<PaintQuad>,
    caret: Option<PaintQuad>,
}
impl IntoElement for EditorSurface {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}
impl Element for EditorSurface {
    type RequestLayoutState = ();
    type PrepaintState = DrawState;
    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }
    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = relative(1.).into();
        (window.request_layout(style, [], cx), ())
    }
    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> DrawState {
        let style = window.text_style();
        let font = style.font();
        let font_size = style.font_size.to_pixels(window.rem_size());
        self.0.update(cx, |editor, _| {
            editor.bounds = Some(bounds);
            let max_y = (editor.buffer.line_count() as f32 * LINE_HEIGHT
                - f32::from(bounds.size.height))
            .max(0.);
            editor.scroll_y = editor.scroll_y.clamp(0., max_y);
            let first = (editor.scroll_y / LINE_HEIGHT) as usize;
            let last = (first + (f32::from(bounds.size.height) / LINE_HEIGHT).ceil() as usize + 1)
                .min(editor.buffer.line_count());
            editor
                .layouts
                .retain(|line, _| *line >= first && *line < last);
            let mut lines = Vec::new();
            let mut selection = Vec::new();
            let mut caret = None;
            let selected = editor.buffer.selection();
            let cursor_line = editor.buffer.line_of(editor.buffer.cursor());
            for line in first..last {
                let text = editor.buffer.line(line);
                let cached = editor
                    .layouts
                    .get(&line)
                    .filter(|layout| layout.text.as_str() == text)
                    .cloned();
                let shaped = cached.unwrap_or_else(|| {
                    window.text_system().shape_line(
                        text.to_owned().into(),
                        font_size,
                        &if let Some(language) = editor.language.filter(|_| !text.is_empty()) {
                            syntax::line(text, language)
                                .into_iter()
                                .map(|token| TextRun {
                                    len: token.range.len(),
                                    font: font.clone(),
                                    color: match token.kind {
                                        TokenKind::Plain => style.color,
                                        TokenKind::Keyword => rgb(0xbb9af7).into(),
                                        TokenKind::String => rgb(0x9ece6a).into(),
                                        TokenKind::Number => rgb(0xff9e64).into(),
                                        TokenKind::Comment => rgb(0x646d7a).into(),
                                    },
                                    background_color: None,
                                    underline: None,
                                    strikethrough: None,
                                })
                                .collect::<Vec<_>>()
                        } else {
                            vec![TextRun {
                                len: text.len(),
                                font: font.clone(),
                                color: style.color,
                                background_color: None,
                                underline: None,
                                strikethrough: None,
                            }]
                        },
                        None,
                    )
                });
                let origin = point(
                    bounds.left() + px(editor.gutter() - editor.scroll_x),
                    bounds.top() + px(line as f32 * LINE_HEIGHT - editor.scroll_y),
                );
                let range = editor.buffer.line_range(line);
                if selected.start < range.end + 1
                    && selected.end > range.start
                    && !selected.is_empty()
                {
                    let left = shaped
                        .x_for_index(selected.start.saturating_sub(range.start).min(text.len()));
                    let right = shaped
                        .x_for_index(selected.end.saturating_sub(range.start).min(text.len()));
                    selection.push(fill(
                        Bounds::new(
                            origin + point(left, px(0.)),
                            size((right - left).max(px(3.)), px(LINE_HEIGHT)),
                        ),
                        rgba(0x7c8cff4d),
                    ));
                }
                if line == cursor_line {
                    caret = Some(fill(
                        Bounds::new(
                            origin
                                + point(
                                    shaped.x_for_index(editor.buffer.cursor() - range.start),
                                    px(0.),
                                ),
                            size(px(1.5), px(LINE_HEIGHT)),
                        ),
                        rgb(0x7c8cff),
                    ));
                }
                editor.layouts.insert(line, shaped.clone());
                lines.push((line, origin, shaped));
            }
            DrawState {
                lines,
                selection,
                caret,
            }
        })
    }
    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        state: &mut DrawState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let editor = self.0.read(cx);
        let focus = editor.focus.clone();
        let gutter = editor.gutter();
        let composer = editor.composer;
        window.handle_input(&focus, ElementInputHandler::new(bounds, self.0.clone()), cx);
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            for selection in state.selection.drain(..) {
                window.paint_quad(selection);
            }
            let code_bounds = Bounds::new(
                point(
                    (bounds.left() + px(gutter)).min(bounds.right()),
                    bounds.top(),
                ),
                size(
                    (bounds.size.width - px(gutter)).max(px(0.)),
                    bounds.size.height,
                ),
            );
            window.with_content_mask(
                Some(ContentMask {
                    bounds: code_bounds,
                }),
                |window| {
                    for (_, origin, shaped) in &state.lines {
                        let _ = shaped.paint(*origin, px(LINE_HEIGHT), window, cx);
                    }
                    if focus.is_focused(window)
                        && let Some(caret) = state.caret.take()
                    {
                        window.paint_quad(caret);
                    }
                },
            );
            if !composer {
                window.paint_quad(fill(
                    Bounds::new(
                        bounds.origin,
                        size(px(gutter).min(bounds.size.width), bounds.size.height),
                    ),
                    rgb(0x0e1013),
                ));
                for (line, origin, _) in &state.lines {
                    let number = (line + 1).to_string();
                    let style = window.text_style();
                    let shaped = window.text_system().shape_line(
                        number.clone().into(),
                        px(11.),
                        &[TextRun {
                            len: number.len(),
                            font: style.font(),
                            color: rgb(0x646d7a).into(),
                            background_color: None,
                            underline: None,
                            strikethrough: None,
                        }],
                        None,
                    );
                    let _ = shaped.paint(
                        point(bounds.left() + px(6.), origin.y),
                        px(LINE_HEIGHT),
                        window,
                        cx,
                    );
                }
            }
        });
    }
}

impl Render for CodeEditor {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let position = self.buffer.line_of(self.buffer.cursor());
        div()
            .w_full()
            .when(!self.composer, |d| d.h_full())
            .when(self.composer, |d| {
                d.h(px(
                    (self.buffer.line_count() as f32 * LINE_HEIGHT + 8.).clamp(42., 220.)
                ))
            })
            .flex()
            .flex_col()
            .bg(rgb(if self.composer { 0x14171c } else { 0x0e1013 }))
            .text_color(rgb(0xe4e7ec))
            .font_family(if self.composer {
                "sans-serif"
            } else {
                "monospace"
            })
            .text_size(px(14.))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .key_context("CodeEditor")
                    .track_focus(&self.focus)
                    .cursor(CursorStyle::IBeam)
                    .on_action(cx.listener(Self::key_left))
                    .on_action(cx.listener(Self::key_right))
                    .on_action(cx.listener(Self::key_up))
                    .on_action(cx.listener(Self::key_down))
                    .on_action(cx.listener(Self::select_left))
                    .on_action(cx.listener(Self::select_right))
                    .on_action(cx.listener(Self::select_up))
                    .on_action(cx.listener(Self::select_down))
                    .on_action(cx.listener(Self::home))
                    .on_action(cx.listener(Self::end))
                    .on_action(cx.listener(Self::all))
                    .on_action(cx.listener(Self::backspace))
                    .on_action(cx.listener(Self::delete))
                    .on_action(cx.listener(Self::newline))
                    .on_action(cx.listener(Self::insert_newline))
                    .on_action(cx.listener(Self::tab))
                    .on_action(cx.listener(Self::copy))
                    .on_action(cx.listener(Self::cut))
                    .on_action(cx.listener(Self::paste))
                    .on_action(cx.listener(Self::undo))
                    .on_action(cx.listener(Self::redo))
                    .on_action(cx.listener(Self::save))
                    .on_action(cx.listener(Self::find))
                    .on_mouse_down(MouseButton::Left, cx.listener(Self::mouse_down))
                    .on_mouse_move(cx.listener(Self::mouse_move))
                    .on_mouse_up(MouseButton::Left, cx.listener(Self::mouse_up))
                    .on_mouse_up_out(MouseButton::Left, cx.listener(Self::mouse_up))
                    .on_scroll_wheel(cx.listener(Self::wheel))
                    .relative()
                    .child(EditorSurface(cx.entity()))
                    .when(self.composer && self.text().is_empty(), |d| {
                        d.child(
                            div()
                                .absolute()
                                .top(px(0.))
                                .left(px(4.))
                                .text_color(rgb(0x646d7a))
                                .text_size(px(13.))
                                .child("Nachricht …   Enter senden · Shift+Enter neue Zeile"),
                        )
                    }),
            )
            .when(!self.composer, |d| {
                d.child(div().h(px(24.)).px_2().text_size(px(11.)).child(
                    self.error.clone().unwrap_or_else(|| {
                        format!(
                            "Zeile {} · Spalte {} · UTF-8",
                            position + 1,
                            self.text()[self.buffer.line_start(position)..self.buffer.cursor()]
                                .chars()
                                .count()
                                + 1
                        )
                    }),
                ))
            })
    }
}

pub fn init(cx: &mut App) {
    let context = Some("CodeEditor");
    cx.bind_keys([
        KeyBinding::new("left", Left, context),
        KeyBinding::new("right", Right, context),
        KeyBinding::new("up", Up, context),
        KeyBinding::new("down", Down, context),
        KeyBinding::new("shift-left", SelectLeft, context),
        KeyBinding::new("shift-right", SelectRight, context),
        KeyBinding::new("shift-up", SelectUp, context),
        KeyBinding::new("shift-down", SelectDown, context),
        KeyBinding::new("home", Home, context),
        KeyBinding::new("end", End, context),
        KeyBinding::new("backspace", Backspace, context),
        KeyBinding::new("delete", Delete, context),
        KeyBinding::new("enter", Newline, context),
        KeyBinding::new("shift-enter", InsertNewline, context),
        KeyBinding::new("tab", Tab, context),
        KeyBinding::new("ctrl-a", SelectAll, context),
        KeyBinding::new("cmd-a", SelectAll, context),
        KeyBinding::new("ctrl-c", Copy, context),
        KeyBinding::new("cmd-c", Copy, context),
        KeyBinding::new("ctrl-x", Cut, context),
        KeyBinding::new("cmd-x", Cut, context),
        KeyBinding::new("ctrl-v", Paste, context),
        KeyBinding::new("cmd-v", Paste, context),
        KeyBinding::new("ctrl-z", Undo, context),
        KeyBinding::new("cmd-z", Undo, context),
        KeyBinding::new("ctrl-shift-z", Redo, context),
        KeyBinding::new("cmd-shift-z", Redo, context),
        KeyBinding::new("ctrl-s", Save, context),
        KeyBinding::new("cmd-s", Save, context),
        KeyBinding::new("ctrl-f", Find, context),
        KeyBinding::new("cmd-f", Find, context),
    ]);
}
