mod journal;
mod platform;

use journal::Journal;
use serde::Deserialize;
use serde_json::{Value, json};
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

const MAX_LINE: u64 = 16_000_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Launch {
    executable: String,
    worker: String,
    payload: Value,
}

fn run(directory: PathBuf) -> io::Result<()> {
    let _lock = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join("host.lock"))?;
    let mut bootstrap = String::new();
    io::stdin()
        .take(32_000_001)
        .read_to_string(&mut bootstrap)?;
    if bootstrap.len() > 32_000_000 {
        return Err(io::Error::other("Chat bootstrap exceeds 32 MB"));
    }
    let mut launch: Launch = serde_json::from_str(&bootstrap)?;
    let mut journal = Journal::new(&directory)?;
    journal.checkpoint()?;
    let mut command = Command::new(&launch.executable);
    command
        .arg(&launch.worker)
        .env("ELECTRON_RUN_AS_NODE", "1")
        .env("QUORUM_CHAT_WORKER", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    platform::configure(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            journal.append(json!({"type":"done","ok":false,"error":format!("Worker konnte nicht gestartet werden: {error}")}))?;
            journal.state.status = "failed";
            journal.checkpoint()?;
            return Ok(());
        }
    };
    let group = match platform::ProcessGroup::new(child.id()) {
        Ok(group) => group,
        Err(error) => {
            child.kill()?;
            child.wait()?;
            return Err(error);
        }
    };
    let mut input = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("Missing worker stdin"))?;
    if let Some(payload) = launch.payload.as_object_mut() {
        payload.insert("supervisorPid".into(), json!(std::process::id()));
        payload.insert("processGroup".into(), json!(child.id()));
    }
    let mut initial = serde_json::to_vec(&launch.payload)?;
    initial.push(b'\n');
    let (control, incoming) = mpsc::sync_channel::<Vec<u8>>(8);
    let writer = thread::spawn(move || -> io::Result<()> {
        input.write_all(&initial)?;
        input.flush()?;
        for command in incoming {
            input.write_all(&command)?;
            input.flush()?;
        }
        Ok(())
    });
    journal.state.worker_pid = Some(child.id());
    journal.state.status = "running";
    journal.checkpoint()?;
    let output = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("Missing worker stdout"))?;
    let (sender, receiver) = mpsc::sync_channel::<io::Result<Value>>(8);
    let reader = thread::spawn(move || {
        let mut output = BufReader::new(output);
        loop {
            let mut line = Vec::new();
            let result = output
                .by_ref()
                .take(MAX_LINE + 1)
                .read_until(b'\n', &mut line);
            match result {
                Ok(0) => break,
                Ok(_) if line.len() as u64 > MAX_LINE => {
                    let _ = sender.send(Err(io::Error::other("Worker event exceeds limit")));
                    break;
                }
                Ok(_) => {
                    let parsed = serde_json::from_slice::<Value>(&line)
                        .map_err(io::Error::from)
                        .and_then(|value| {
                            if value.get("type").and_then(Value::as_str).is_none() {
                                return Err(io::Error::other("Invalid worker event"));
                            }
                            Ok(value)
                        });
                    if sender.send(parsed).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = sender.send(Err(error));
                    break;
                }
            }
        }
    });
    let mut stopped = None;
    let mut checkpoint = Instant::now();
    loop {
        if directory.join("stop").exists() && stopped.is_none() {
            let _ = control.try_send(b"{\"type\":\"cancel\"}\n".to_vec());
            stopped = Some(Instant::now());
        }
        let mailbox = directory.join("commands");
        let mut commands = fs::read_dir(mailbox)?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .collect::<Vec<_>>();
        commands.sort();
        for next in commands.into_iter().take(20) {
            let mut bytes = fs::read(&next)?;
            if bytes.len() > 16_000_000 {
                return Err(io::Error::other("Chat command exceeds limit"));
            }
            bytes.push(b'\n');
            match control.try_send(bytes) {
                Ok(()) => fs::remove_file(next)?,
                Err(mpsc::TrySendError::Full(_)) => break,
                Err(mpsc::TrySendError::Disconnected(_)) => {
                    fs::remove_file(next)?;
                }
            }
        }
        if stopped.is_some_and(|since| since.elapsed() > Duration::from_secs(4)) {
            group.terminate();
        }
        if stopped.is_some_and(|since| since.elapsed() > Duration::from_secs(5)) {
            drop(group);
            child.wait()?;
            break;
        }
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(Ok(event)) => journal.append(event)?,
            Ok(Err(error)) => {
                journal.append(json!({"type":"done","ok":false,"error":error.to_string()}))?;
                group.terminate();
                stopped.get_or_insert_with(Instant::now);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                if let Some(status) = child.try_wait()? {
                    if !journal.done {
                        journal.append(json!({"type":"done","ok":false,"error":format!("Worker beendet ({status})")}))?;
                    }
                    drop(group);
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
        }
        if checkpoint.elapsed() >= Duration::from_millis(500) {
            journal.checkpoint()?;
            checkpoint = Instant::now();
        }
    }
    // Closing the owned process group releases stdout even if a descendant kept the pipe open.
    drop(control);
    drop(receiver);
    reader
        .join()
        .map_err(|_| io::Error::other("Worker event reader failed"))?;
    let _ = writer
        .join()
        .map_err(|_| io::Error::other("Worker command writer failed"))?;
    if !journal.done {
        journal.append(json!({"type":"done","ok":false,"error":"Gestoppt"}))?;
    }
    journal.state.status = if stopped.is_some() {
        "cancelled"
    } else if journal.ok {
        "completed"
    } else {
        "failed"
    };
    fs::remove_dir_all(directory.join("commands"))?;
    journal.checkpoint()
}

fn main() {
    let result = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other("Missing chat job directory"))
        .and_then(run);
    if let Err(error) = result {
        eprintln!("quorum-chat-host: {error}");
        std::process::exit(1);
    }
}
