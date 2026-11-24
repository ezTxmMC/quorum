use std::io;
use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;

const UNDO_BYTES: usize = 32 * 1024 * 1024;
const MAX_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone)]
struct Edit {
    start: usize,
    inserted: String,
    removed: String,
}

pub struct TextBuffer {
    text: String,
    starts: Vec<usize>,
    cursor: usize,
    anchor: usize,
    undo: Vec<Edit>,
    redo: Vec<Edit>,
    undo_bytes: usize,
    revision: u64,
}

impl TextBuffer {
    pub fn new(text: String) -> Self {
        let starts = std::iter::once(0)
            .chain(text.match_indices('\n').map(|(offset, _)| offset + 1))
            .collect();
        Self {
            text,
            starts,
            cursor: 0,
            anchor: 0,
            undo: Vec::new(),
            redo: Vec::new(),
            undo_bytes: 0,
            revision: 0,
        }
    }
    pub fn text(&self) -> &str {
        &self.text
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn cursor(&self) -> usize {
        self.cursor
    }
    pub fn anchor(&self) -> usize {
        self.anchor
    }
    pub fn line_count(&self) -> usize {
        self.starts.len()
    }
    pub fn line_of(&self, offset: usize) -> usize {
        self.starts
            .partition_point(|start| *start <= offset.min(self.text.len()))
            .saturating_sub(1)
    }
    pub fn line_start(&self, line: usize) -> usize {
        self.starts[line.min(self.starts.len() - 1)]
    }
    pub fn line_range(&self, line: usize) -> Range<usize> {
        let line = line.min(self.starts.len() - 1);
        let start = self.starts[line];
        let mut end = self
            .starts
            .get(line + 1)
            .map(|offset| offset - 1)
            .unwrap_or(self.text.len());
        if end > start && self.text.as_bytes()[end - 1] == b'\r' {
            end -= 1;
        }
        start..end
    }
    pub fn line(&self, line: usize) -> &str {
        &self.text[self.line_range(line)]
    }
    pub fn selection(&self) -> Range<usize> {
        self.anchor.min(self.cursor)..self.anchor.max(self.cursor)
    }
    pub fn select(&mut self, anchor: usize, cursor: usize) -> io::Result<()> {
        self.validate(&(anchor.min(cursor)..anchor.max(cursor)))?;
        self.anchor = anchor;
        self.cursor = cursor;
        Ok(())
    }
    pub fn move_to(&mut self, offset: usize, extend: bool) -> io::Result<()> {
        self.select(if extend { self.anchor } else { offset }, offset)
    }
    pub fn previous_boundary(&self) -> usize {
        self.text[..self.cursor]
            .grapheme_indices(true)
            .next_back()
            .map(|(offset, _)| offset)
            .unwrap_or(0)
    }
    pub fn next_boundary(&self) -> usize {
        self.text[self.cursor..]
            .graphemes(true)
            .next()
            .map(|grapheme| self.cursor + grapheme.len())
            .unwrap_or(self.cursor)
    }
    pub fn byte_to_utf16(&self, offset: usize) -> usize {
        self.text[..offset].encode_utf16().count()
    }
    pub fn utf16_to_byte(&self, offset: usize) -> usize {
        let mut units = 0;
        for (index, character) in self.text.char_indices() {
            if units + character.len_utf16() > offset {
                return index;
            }
            units += character.len_utf16();
        }
        self.text.len()
    }
    pub fn newline(&self) -> &'static str {
        if self.text.contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        }
    }

    pub fn replace(&mut self, range: Range<usize>, text: &str) -> io::Result<()> {
        self.validate(&range)?;
        if self.text.len() - range.len() + text.len() > MAX_BYTES {
            return Err(io::Error::other("Editor buffer exceeds 2 MiB"));
        }
        let edit = Edit {
            start: range.start,
            inserted: text.to_owned(),
            removed: self.text[range.clone()].to_owned(),
        };
        if edit.inserted == edit.removed {
            return Ok(());
        }
        self.replace_raw(range, text);
        self.undo_bytes += edit.inserted.len() + edit.removed.len();
        self.undo.push(edit);
        self.redo.clear();
        while self.undo_bytes > UNDO_BYTES && self.undo.len() > 1 {
            let first = self.undo.remove(0);
            self.undo_bytes -= first.inserted.len() + first.removed.len();
        }
        Ok(())
    }
    pub fn insert(&mut self, text: &str) -> io::Result<()> {
        self.replace(self.selection(), text)
    }
    pub fn undo(&mut self) {
        let Some(edit) = self.undo.pop() else {
            return;
        };
        self.undo_bytes -= edit.inserted.len() + edit.removed.len();
        self.replace_raw(edit.start..edit.start + edit.inserted.len(), &edit.removed);
        self.redo.push(edit);
    }
    pub fn redo(&mut self) {
        let Some(edit) = self.redo.pop() else {
            return;
        };
        self.replace_raw(edit.start..edit.start + edit.removed.len(), &edit.inserted);
        self.undo_bytes += edit.inserted.len() + edit.removed.len();
        self.undo.push(edit);
    }
    fn validate(&self, range: &Range<usize>) -> io::Result<()> {
        if range.start > range.end
            || range.end > self.text.len()
            || !self.text.is_char_boundary(range.start)
            || !self.text.is_char_boundary(range.end)
        {
            return Err(io::Error::other("Invalid UTF-8 editor range"));
        }
        Ok(())
    }
    fn replace_raw(&mut self, range: Range<usize>, replacement: &str) {
        let first_after = self.starts.partition_point(|offset| *offset <= range.start);
        let removed_end = self.starts.partition_point(|offset| *offset <= range.end);
        let inserted = replacement
            .match_indices('\n')
            .map(|(offset, _)| range.start + offset + 1)
            .collect::<Vec<_>>();
        for offset in &mut self.starts[removed_end..] {
            *offset = *offset - range.len() + replacement.len();
        }
        self.starts.splice(first_after..removed_end, inserted);
        self.text.replace_range(range.clone(), replacement);
        self.cursor = range.start + replacement.len();
        self.anchor = self.cursor;
        self.revision += 1;
    }
}
