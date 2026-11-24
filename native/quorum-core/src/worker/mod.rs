mod command;

use crate::providers::{ClaudeParser, CodexParser};
use serde_json::{Value, json};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

const MAX_FRAME: u64 = 16_000_000;

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Invoked only inside quorum-chat-host's owned process group / Windows job.
pub fn run() -> io::Result<()> {
    if std::env::var("QUORUM_CHAT_WORKER").as_deref() != Ok("1") {
        return Err(io::Error::other(
            "Start this worker through quorum-chat-host",
        ));
    }
    let stdin = io::stdin();
    let mut input = BufReader::new(stdin);
    let first = read_frame(&mut input)?.ok_or_else(|| io::Error::other("Missing bootstrap"))?;
    let bootstrap: Value = serde_json::from_slice(&first)?;
    let mut command = command::build(&bootstrap)?;
    let prompt = command::prompt(&bootstrap)?;
    let mut child = OwnedChild(
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?,
    );
    let output = child
        .0
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("Missing stdout"))?;
    let errors = child
        .0
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("Missing stderr"))?;
    let mut prompt_pipe = child
        .0
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("Missing stdin"))?;
    let (frames, incoming) = mpsc::sync_channel(8);
    let (commands, control) = mpsc::sync_channel(8);
    let reader = thread::spawn(move || {
        let mut output = BufReader::new(output);
        loop {
            let frame = read_frame(&mut output);
            let finished = !matches!(&frame, Ok(Some(_)));
            if frames.send(frame).is_err() || finished {
                return;
            }
        }
    });
    let error_tail = Arc::new(Mutex::new(Vec::<u8>::new()));
    let error_writer = error_tail.clone();
    thread::spawn(move || {
        let mut errors = errors;
        let mut chunk = [0; 4096];
        while let Ok(size) = errors.read(&mut chunk) {
            if size == 0 {
                break;
            }
            let Ok(mut bytes) = error_writer.lock() else {
                break;
            };
            bytes.extend_from_slice(&chunk[..size]);
            if bytes.len() > 65536 {
                let excess = bytes.len() - 65536;
                bytes.drain(..excess);
            }
        }
    });
    // Pipes can block: prompt delivery never blocks cancellation and host heartbeats.
    thread::spawn(move || {
        let _ = prompt_pipe.write_all(&prompt);
    });
    thread::spawn(move || {
        while let Ok(Some(frame)) = read_frame(&mut input) {
            let Ok(value) = serde_json::from_slice::<Value>(&frame) else {
                continue;
            };
            if commands.send(value).is_err() {
                return;
            }
        }
    });
    emit(json!({"type":"worker_ready"}))?;
    let mut claude = ClaudeParser::default();
    let mut codex = CodexParser::default();
    let mut cancelled = false;
    let mut failed = false;
    let mut eof = false;
    let mut exited_at = None;
    loop {
        while let Ok(command) = control.try_recv() {
            if command["type"] == "cancel" {
                cancelled = true;
                let _ = child.0.kill();
            }
            // Injection is deliberately not acknowledged until native transport supports it.
        }
        if eof {
            thread::sleep(Duration::from_millis(25));
        }
        match incoming.recv_timeout(Duration::from_millis(25)) {
            Ok(Ok(Some(frame))) => {
                if let Ok(value) = serde_json::from_slice::<Value>(&frame) {
                    let events = if bootstrap["request"]["provider"] == "claude" {
                        claude.push(&value)
                    } else {
                        codex.push(&value)
                    };
                    for event in events {
                        failed |= event["type"] == "notice" && event["level"] == "error";
                        emit(event)?;
                    }
                }
            }
            Ok(Ok(None)) => eof = true,
            Ok(Err(error)) => return Err(error),
            Err(mpsc::RecvTimeoutError::Disconnected) => eof = true,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        let status = child.0.try_wait()?;
        if status.is_none() {
            continue;
        }
        let exited = exited_at.get_or_insert_with(Instant::now);
        if !eof && exited.elapsed() < Duration::from_millis(250) {
            continue;
        }
        let status = status.ok_or_else(|| io::Error::other("Missing exit status"))?;
        if eof {
            let _ = reader.join();
        }
        let errors = error_tail
            .lock()
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default();
        let ok = status.success() && !cancelled && !failed;
        let error = if cancelled {
            "Abgebrochen".to_owned()
        } else if errors.is_empty() {
            format!("Anbieter fehlgeschlagen (Exit {:?})", status.code())
        } else {
            errors
        };
        emit(
            json!({"type":"done","ok":ok,"code":status.code(),"error":if ok {None} else {Some(error)}}),
        )?;
        return Ok(());
    }
}

fn read_frame(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    reader.take(MAX_FRAME + 1).read_until(b'\n', &mut bytes)?;
    if bytes.len() as u64 > MAX_FRAME {
        return Err(io::Error::other("Provider frame exceeds 16 MB"));
    }
    Ok((!bytes.is_empty()).then_some(bytes))
}

pub fn emit(mut value: Value) -> io::Result<()> {
    let kind = value["type"].as_str().unwrap_or("").to_owned();
    if matches!(kind.as_str(), "text" | "thinking") {
        let delta = value["delta"].as_str().unwrap_or("");
        let mut start = 0;
        while start < delta.len() {
            let mut end = (start + 16000).min(delta.len());
            while !delta.is_char_boundary(end) {
                end -= 1;
            }
            write_event(json!({"type":kind,"delta":&delta[start..end]}))?;
            start = end;
        }
        return Ok(());
    }
    if kind == "tool_end"
        && let Some(output) = value["output"].as_str()
        && output.len() > 4096
    {
        let mut end = 4096;
        while !output.is_char_boundary(end) {
            end -= 1;
        }
        value["output"] = json!(format!("{}\n[output truncated]", &output[..end]));
    }
    if kind == "tool_start" && serde_json::to_vec(&value["input"])?.len() > 65536 {
        value["input"] = json!("[tool input exceeds native display limit]");
    }
    write_event(value)
}

fn write_event(mut value: Value) -> io::Result<()> {
    if let Some(object) = value.as_object_mut() {
        object.retain(|_, value| !value.is_null());
    }
    let bytes = serde_json::to_vec(&value)?;
    if bytes.len() > 2_000_000 {
        return Err(io::Error::other("Event exceeds native journal frame limit"));
    }
    let mut output = io::stdout().lock();
    output.write_all(&bytes)?;
    output.write_all(b"\n")?;
    output.flush()
}
