use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{self, BufRead, BufReader, Read, Write},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, mpsc},
    time::Duration,
};
const MAX_BODY: usize = 8_000_000;
type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<io::Result<Value>>>>>;
pub(super) struct Rpc {
    child: Child,
    outbound: Option<mpsc::SyncSender<Value>>,
    pending: Pending,
    next: u64,
    pub diagnostics: Arc<Mutex<HashMap<String, Value>>>,
}
fn send(input: &mut impl Write, message: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(message)?;
    if bytes.len() > MAX_BODY {
        return Err(io::Error::other("LSP-Nachricht überschreitet 8 MB"));
    }
    write!(input, "Content-Length: {}\r\n\r\n", bytes.len())?;
    input.write_all(&bytes)?;
    input.flush()
}
pub(super) fn frame(reader: &mut impl BufRead) -> io::Result<Option<Value>> {
    let mut length = None;
    let mut total = 0;
    loop {
        let mut line = Vec::new();
        let size = reader.by_ref().take(8193).read_until(b'\n', &mut line)?;
        if size == 0 {
            return if total == 0 {
                Ok(None)
            } else {
                Err(io::Error::other("Unvollständiger LSP-Header"))
            };
        }
        total += size;
        if total > 8192 {
            return Err(io::Error::other("LSP-Header zu groß"));
        }
        if line == b"\r\n" || line == b"\n" {
            break;
        }
        let line = std::str::from_utf8(&line).map_err(io::Error::other)?;
        if let Some((name, value)) = line.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            if length.is_some() {
                return Err(io::Error::other("Doppelter Content-Length-Header"));
            }
            length = Some(value.trim().parse::<usize>().map_err(io::Error::other)?);
        }
    }
    let length = length
        .filter(|length| *length <= MAX_BODY)
        .ok_or_else(|| io::Error::other("Ungültige LSP-Nachrichtenlänge"))?;
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes)?;
    let value: Value = serde_json::from_slice(&bytes)?;
    if !value.is_object() {
        return Err(io::Error::other("Ungültige LSP-Nachricht"));
    }
    Ok(Some(value))
}
fn fail(pending: &Pending, message: &str) {
    if let Ok(mut pending) = pending.lock() {
        for (_, sender) in pending.drain() {
            let _ = sender.send(Err(io::Error::other(message.to_owned())));
        }
    }
}
impl Rpc {
    pub fn spawn(mut command: Command, root_uri: String) -> io::Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let mut input = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("LSP stdin fehlt"))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("LSP stdout fehlt"))?;
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let diagnostics = Arc::new(Mutex::new(HashMap::new()));
        let (outbound, messages) = mpsc::sync_channel::<Value>(8);
        let writer_pending = pending.clone();
        std::thread::spawn(move || {
            for message in messages {
                if let Err(error) = send(&mut input, &message) {
                    fail(&writer_pending, &error.to_string());
                    return;
                }
            }
        });
        let reader_pending = pending.clone();
        let reader_diagnostics = diagnostics.clone();
        let answers = outbound.clone();
        std::thread::spawn(move || {
            let mut output = BufReader::new(output);
            loop {
                let message = match frame(&mut output) {
                    Ok(Some(message)) => message,
                    Ok(None) => {
                        fail(&reader_pending, "Language Server wurde beendet");
                        return;
                    }
                    Err(error) => {
                        fail(&reader_pending, &error.to_string());
                        return;
                    }
                };
                if let Some(method) = message["method"].as_str() {
                    if !message["id"].is_null() {
                        let response = match method {
                            "workspace/configuration" => {
                                json!({"result":message["params"]["items"].as_array().map(|items|vec![Value::Null;items.len().min(100)]).unwrap_or_default()})
                            }
                            "workspace/workspaceFolders" => {
                                json!({"result":[{"uri":root_uri,"name":"Quorum"}]})
                            }
                            "client/registerCapability"
                            | "client/unregisterCapability"
                            | "window/workDoneProgress/create" => json!({"result":null}),
                            "workspace/applyEdit" => {
                                json!({"result":{"applied":false,"failureReason":"Änderungen müssen im Editor geprüft werden"}})
                            }
                            _ => {
                                json!({"error":{"code":-32601,"message":"Unsupported server request"}})
                            }
                        };
                        let mut response = response;
                        response["id"] = message["id"].clone();
                        response["jsonrpc"] = json!("2.0");
                        if answers.try_send(response).is_err() {
                            fail(&reader_pending, "LSP-Ausgabewarteschlange ist voll");
                            return;
                        }
                    } else if method == "textDocument/publishDiagnostics"
                        && let Some(uri) = message["params"]["uri"]
                            .as_str()
                            .filter(|uri| uri.len() <= 8192)
                        && let Ok(mut diagnostics) = reader_diagnostics.lock()
                        && (diagnostics.len() < 32 || diagnostics.contains_key(uri))
                    {
                        let items:Vec<_>=message["params"]["diagnostics"].as_array().into_iter().flatten().take(1000).map(|item|json!({"range":item["range"],"severity":item["severity"],"message":item["message"].as_str().unwrap_or("Diagnose").chars().take(4000).collect::<String>()})).collect();
                        let params = json!({"uri":uri,"version":message["params"]["version"],"diagnostics":items});
                        diagnostics.insert(uri.to_owned(), params);
                    }
                    continue;
                }
                if let Some(id) = message["id"].as_u64()
                    && let Ok(mut pending) = reader_pending.lock()
                    && let Some(sender) = pending.remove(&id)
                {
                    let result = if message.get("error").is_some() {
                        Err(io::Error::other(format!(
                            "Language Server: {}",
                            message["error"]["message"]
                                .as_str()
                                .unwrap_or("Anfrage fehlgeschlagen")
                        )))
                    } else {
                        Ok(message["result"].clone())
                    };
                    let _ = sender.send(result);
                }
            }
        });
        Ok(Self {
            child,
            outbound: Some(outbound),
            pending,
            next: 0,
            diagnostics,
        })
    }
    fn enqueue(&self, value: Value) -> io::Result<()> {
        if serde_json::to_vec(&value)?.len() > MAX_BODY {
            return Err(io::Error::other("LSP-Nachricht ist zu groß"));
        }
        self.outbound
            .as_ref()
            .ok_or_else(|| io::Error::other("LSP wurde geschlossen"))?
            .try_send(value)
            .map_err(|_| io::Error::other("LSP ist nicht verfügbar oder beschäftigt"))
    }
    pub fn notify(&self, method: &str, params: Value) -> io::Result<()> {
        self.enqueue(json!({"jsonrpc":"2.0","method":method,"params":params}))
    }
    pub fn request(&mut self, method: &str, params: Value) -> io::Result<Value> {
        self.next += 1;
        let id = self.next;
        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| io::Error::other("LSP lock poisoned"))?
            .insert(id, sender);
        let result = self
            .enqueue(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .and_then(|()| {
                receiver
                    .recv_timeout(Duration::from_secs(15))
                    .map_err(io::Error::other)?
            });
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&id);
        }
        if result.is_err() {
            let _ = self.notify("$/cancelRequest", json!({"id":id}));
        }
        result
    }
}
impl Drop for Rpc {
    fn drop(&mut self) {
        self.outbound.take();
        #[cfg(unix)]
        // SAFETY: this unreaped child was started as leader of its own process group.
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        fail(&self.pending, "LSP wurde geschlossen");
    }
}
