//! Request/reply transport to the transitional Node adapter over private stdio.
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
    mpsc,
};
use std::thread;

type Reply = Result<Value, String>;
type Pending = Arc<Mutex<Option<HashMap<u64, mpsc::Sender<Reply>>>>>;

pub struct Service {
    input: Mutex<Option<ChildStdin>>,
    child: Option<Child>,
    next_id: AtomicU64,
    pending: Pending,
}

impl Service {
    pub fn spawn(
        command: &mut Command,
        event: impl Fn(Value) + Send + 'static,
    ) -> io::Result<Self> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("Missing service stdin"))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("Missing service stdout"))?;
        let pending: Pending = Arc::new(Mutex::new(Some(HashMap::new())));
        let responses = pending.clone();
        thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                    break;
                };
                if frame["channel"].is_string() {
                    event(frame);
                    continue;
                }
                let Some(id) = frame["id"].as_u64() else {
                    continue;
                };
                let sender = responses
                    .lock()
                    .ok()
                    .and_then(|mut p| p.as_mut()?.remove(&id));
                if let Some(sender) = sender {
                    let reply = match frame["error"].as_str() {
                        Some(message) => Err(message.to_owned()),
                        None => Ok(frame["result"].clone()),
                    };
                    let _ = sender.send(reply);
                }
            }
            if let Ok(mut map) = responses.lock() {
                map.take();
            }
        });
        Ok(Self {
            input: Mutex::new(Some(input)),
            child: Some(child),
            next_id: AtomicU64::new(1),
            pending,
        })
    }

    pub fn call(&self, channel: &str, args: &[Value]) -> Reply {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut bytes = serde_json::to_vec(&json!({ "id": id, "channel": channel, "args": args }))
            .map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|e| e.to_string())?
            .as_mut()
            .ok_or("Quorum service closed")?
            .insert(id, sender);
        let result = self
            .input
            .lock()
            .map_err(|e| e.to_string())?
            .as_mut()
            .ok_or("Quorum service closed")?
            .write_all(&bytes);
        if let Err(error) = result {
            if let Some(map) = self.pending.lock().map_err(|e| e.to_string())?.as_mut() {
                map.remove(&id);
            }
            return Err(error.to_string());
        }
        receiver
            .recv()
            .map_err(|_| "Quorum service disconnected".to_owned())?
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        if let Ok(input) = self.input.get_mut() {
            input.take();
        }
        if let Some(mut child) = self.child.take() {
            thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
}
