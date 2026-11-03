use serde::Serialize;
use serde_json::{Value, json};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn private_file(path: &Path, create_new: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(create_new)
        .create(!create_new)
        .append(!create_new);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub pid: u32,
    pub worker_pid: Option<u32>,
    pub worker_ready: bool,
    pub status: &'static str,
    pub sequence: u64,
    pub heartbeat: u64,
}

pub struct Journal {
    directory: PathBuf,
    events: File,
    pub state: State,
    pub done: bool,
    pub ok: bool,
    bytes: usize,
}

impl Journal {
    pub fn new(directory: &Path) -> io::Result<Self> {
        Ok(Self {
            directory: directory.to_path_buf(),
            events: private_file(&directory.join("events.jsonl"), true)?,
            state: State {
                pid: std::process::id(),
                worker_pid: None,
                worker_ready: false,
                status: "starting",
                sequence: 0,
                heartbeat: now(),
            },
            done: false,
            ok: false,
            bytes: 0,
        })
    }

    pub fn append(&mut self, event: Value) -> io::Result<()> {
        if event.get("type").and_then(Value::as_str) == Some("worker_ready") {
            self.state.worker_ready = true;
            return Ok(());
        }
        if self.done {
            return Ok(());
        }
        let encoded =
            serde_json::to_vec(&json!({ "sequence": self.state.sequence + 1, "event": event }))?;
        if self.bytes + encoded.len() > 256_000_000 {
            return Err(io::Error::other("Chat event journal exceeded 256 MB"));
        }
        self.events.write_all(&encoded)?;
        self.events.write_all(b"\n")?;
        self.events.flush()?;
        self.bytes += encoded.len() + 1;
        self.state.sequence += 1;
        if event.get("type").and_then(Value::as_str) == Some("done") {
            self.done = true;
            self.ok = event.get("ok").and_then(Value::as_bool) == Some(true);
            self.events.sync_data()?;
        }
        Ok(())
    }

    pub fn checkpoint(&mut self) -> io::Result<()> {
        self.state.heartbeat = now();
        let temporary = self.directory.join("state.tmp");
        let mut file = private_file(&temporary, true)?;
        serde_json::to_writer(&mut file, &self.state)?;
        file.sync_all()?;
        drop(file);
        #[cfg(windows)]
        {
            let target = self.directory.join("state.json");
            if target.exists() {
                fs::remove_file(target)?;
            }
        }
        fs::rename(temporary, self.directory.join("state.json"))
    }
}
