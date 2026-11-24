use crate::journal::Journal;
use serde_json::{Value, json};
use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;
use std::thread;
use std::time::Duration;

pub enum Admission {
    Ready(Option<File>),
    Cancelled,
}

/// Keep one local-model worker per profile. File locks are released on process exit.
pub fn admit(directory: &Path, request: &Value, journal: &mut Journal) -> io::Result<Admission> {
    if request["provider"] != "local" {
        return Ok(Admission::Ready(None));
    }
    let parent = directory
        .parent()
        .ok_or_else(|| io::Error::other("Missing jobs directory"))?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(parent.join("local-model.lock"))?;
    let mut notified = false;
    loop {
        if directory.join("stop").exists() {
            journal.append(
                json!({"type":"done","ok":false,"error":"Wartender Modelllauf gestoppt"}),
            )?;
            journal.state.status = "cancelled";
            journal.checkpoint()?;
            return Ok(Admission::Cancelled);
        }
        match lock.try_lock() {
            Ok(()) => return Ok(Admission::Ready(Some(lock))),
            Err(std::fs::TryLockError::Error(error)) => return Err(error),
            Err(std::fs::TryLockError::WouldBlock) => {}
        }
        if !notified {
            journal.append(json!({"type":"notice","level":"info","text":"Ein lokales Modell läuft bereits. Dieser Chat wartet auf freien Modellspeicher."}))?;
            notified = true;
        }
        journal.checkpoint()?;
        thread::sleep(Duration::from_millis(500));
    }
}
