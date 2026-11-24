use quorum_core::workspace::buffer::TextBuffer;

#[test]
fn edits_keep_line_offsets_and_undo_exactly() {
    let original = "a\r\n🦀bc\nlast";
    let mut buffer = TextBuffer::new(original.into());
    assert_eq!(buffer.line_count(), 3);
    assert_eq!(buffer.line(0), "a");
    assert_eq!(buffer.line(1), "🦀bc");
    buffer.replace(3..7, "x\ny").unwrap();
    assert_eq!(buffer.text(), "a\r\nx\nybc\nlast");
    assert_eq!(buffer.line_count(), 4);
    buffer.undo();
    assert_eq!(buffer.text(), original);
    assert_eq!(buffer.line_count(), 3);
    buffer.redo();
    assert_eq!(buffer.line(2), "ybc");
}

#[test]
fn utf16_ime_offsets_and_graphemes() {
    let mut buffer = TextBuffer::new("a🦀e\u{301}\r\n".into());
    assert_eq!(buffer.byte_to_utf16(5), 3);
    assert_eq!(buffer.utf16_to_byte(2), 1);
    buffer.move_to(8, false).unwrap();
    assert_eq!(buffer.previous_boundary(), 5);
    buffer.move_to(8, false).unwrap();
    assert_eq!(buffer.next_boundary(), 10);
    assert!(buffer.replace(2..3, "broken").is_err());
    assert_eq!(buffer.text(), "a🦀e\u{301}\r\n");
}

#[test]
fn line_index_matches_full_rebuild_after_insertions_and_deletions() {
    let mut buffer = TextBuffer::new("one\ntwo\nthree\n".into());
    for (start, end, text) in [(0, 0, "\n"), (1, 5, "x\ny\n"), (0, 3, ""), (2, 2, "\r\n")] {
        buffer.replace(start..end, text).unwrap();
        let rebuilt = TextBuffer::new(buffer.text().into());
        assert_eq!(buffer.line_count(), rebuilt.line_count());
        for line in 0..buffer.line_count() {
            assert_eq!(buffer.line(line), rebuilt.line(line));
            assert_eq!(buffer.line_start(line), rebuilt.line_start(line));
        }
    }
}
