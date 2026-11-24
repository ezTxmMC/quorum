use serde::Deserialize;
use serde_json::Value;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

const BATCH_BYTES: usize = 256 * 1024;
const MAX_FRAME_BYTES: usize = 2_100_000;

#[derive(Debug, Deserialize)]
pub struct JournalEvent {
    pub sequence: u64,
    pub event: Value,
}

/// Incremental replay compatible with the per-chat Rust host's JSONL journals.
/// A partial UTF-8/JSON frame remains bytes until its newline arrives.
pub struct JournalReader {
    file: File,
    offset: u64,
    pending: Vec<u8>,
    buffer: Vec<u8>,
    sequence: u64,
}

impl JournalReader {
    pub fn open(path: &Path, applied_sequence: u64) -> io::Result<Self> {
        Ok(Self {
            file: File::open(path)?,
            offset: 0,
            pending: Vec::new(),
            buffer: vec![0; BATCH_BYTES],
            sequence: applied_sequence,
        })
    }

    pub fn poll(&mut self) -> io::Result<Vec<JournalEvent>> {
        if self.file.metadata()?.len() < self.offset {
            return Err(io::Error::other("Chat journal was truncated"));
        }
        self.file.seek(SeekFrom::Start(self.offset))?;
        let read = self.file.read(&mut self.buffer)?;
        self.offset += read as u64;
        self.pending.extend_from_slice(&self.buffer[..read]);
        let mut events = Vec::new();
        let mut consumed = 0;
        let mut sequence = self.sequence;
        for (position, byte) in self.pending.iter().enumerate() {
            if *byte != b'\n' {
                continue;
            }
            let frame = &self.pending[consumed..position];
            consumed = position + 1;
            if frame.len() > MAX_FRAME_BYTES {
                return Err(io::Error::other("Chat journal frame exceeds 2 MiB"));
            }
            if frame.is_empty() {
                continue;
            }
            let event: JournalEvent = serde_json::from_slice(frame).map_err(io::Error::other)?;
            if event.sequence <= sequence {
                continue;
            }
            if event.sequence != sequence + 1 {
                return Err(io::Error::other(
                    "Chat journal sequence gap; replay stopped",
                ));
            }
            sequence = event.sequence;
            events.push(event);
        }
        self.pending.drain(..consumed);
        if self.pending.len() > MAX_FRAME_BYTES {
            return Err(io::Error::other(
                "Unterminated chat journal frame exceeds 2 MiB",
            ));
        }
        self.sequence = sequence;
        Ok(events)
    }

    pub(crate) fn caught_up(&self) -> io::Result<bool> {
        Ok(self.file.metadata()?.len() == self.offset)
    }

    pub fn sequence(&self) -> u64 {
        self.sequence
    }
}
