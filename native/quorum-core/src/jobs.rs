mod processes;
pub use processes::ProcessInfo;
mod configuration;
mod planning;
use crate::{
    archive::{Archive, Session},
    journal::JournalReader,
    profile::Profile,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub struct Snapshot {
    pub archive: Arc<Archive>,
    pub revision: u64,
    pub active: Vec<String>,
    pub processes: Vec<ProcessInfo>,
}

struct Job {
    metadata: Value,
    reader: Option<JournalReader>,
    finished: bool,
}

pub struct Runtime {
    root: PathBuf,
    profile: Profile,
    jobs: HashMap<String, Job>,
    dirty: bool,
    last_save: Instant,
    revision: u64,
}

impl Runtime {
    pub fn open(root: &Path) -> io::Result<Self> {
        fs::create_dir_all(root)?;
        let path = root.join("hub.json");
        if !path.exists() {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(fs::Permissions::from_mode(0o600))?;
            }
            file.write_all(br#"{"version":1,"settings":{},"sessions":[],"multiRuns":[],"projects":[],"recentProjects":[]}"#)?;
            file.sync_all()?;
        }
        let profile = Profile::open(root)?;
        let mut runtime = Self {
            root: root.to_owned(),
            profile,
            jobs: HashMap::new(),
            dirty: false,
            last_save: Instant::now(),
            revision: 0,
        };
        let directory = root.join("chat-jobs");
        let tombstones: Vec<String> = match fs::read(directory.join("deleted-chats.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error),
        };
        if !tombstones.is_empty() {
            let sessions = runtime.profile.data["sessions"]
                .as_array_mut()
                .ok_or_else(|| io::Error::other("Invalid session list"))?;
            let previous = sessions.len();
            sessions.retain(|session| !tombstones.iter().any(|id| session["id"] == id.as_str()));
            runtime.dirty |= sessions.len() != previous;
        }
        if directory.exists() {
            for entry in fs::read_dir(directory)? {
                let entry = entry?;
                if !entry.file_type()?.is_dir() {
                    continue;
                }
                let metadata_path = entry.path().join("meta.json");
                if !metadata_path.exists() {
                    continue;
                }
                let mut metadata: Value = serde_json::from_slice(&fs::read(metadata_path)?)?;
                if metadata["forgotten"] == true || metadata["acknowledged"] == true {
                    continue;
                }
                let Some(run_id) = metadata["runId"].as_str() else {
                    continue;
                };
                if !valid_id(run_id) {
                    return Err(io::Error::other("Invalid chat job identifier"));
                }
                let chat_id = metadata["chatId"].as_str().unwrap_or("");
                if tombstones.iter().any(|id| id == chat_id) {
                    continue;
                }
                if !runtime
                    .sessions()
                    .iter()
                    .any(|session| session["id"] == chat_id)
                    && metadata["snapshot"].is_object()
                {
                    runtime.profile.data["sessions"]
                        .as_array_mut()
                        .ok_or_else(|| io::Error::other("Invalid session list"))?
                        .push(metadata["snapshot"].clone());
                    runtime.dirty = true;
                }
                let run_id = run_id.to_owned();
                metadata["snapshot"] = Value::Null;
                runtime.jobs.insert(
                    run_id,
                    Job {
                        metadata,
                        reader: None,
                        finished: false,
                    },
                );
            }
        }
        runtime.finish_plans()?;
        if runtime.dirty {
            runtime.flush()?;
        }
        Ok(runtime)
    }

    fn sessions(&self) -> &[Value] {
        self.profile.data["sessions"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    pub fn snapshot(&self) -> io::Result<Snapshot> {
        let sessions = self
            .sessions()
            .iter()
            .map(|value| serde_json::from_value::<Session>(value.clone()))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Snapshot {
            revision: self.revision,
            archive: Arc::new(Archive { sessions }),
            processes: self.processes()?,
            active: self
                .jobs
                .values()
                .filter(|job| !job.finished)
                .filter_map(|job| job.metadata["chatId"].as_str().map(str::to_owned))
                .collect(),
        })
    }

    pub fn create_chat(&mut self, provider: &str, cwd: &Path, model: &str) -> io::Result<String> {
        if !matches!(provider, "claude" | "codex") {
            return Err(io::Error::other("Native provider not implemented"));
        }
        let cwd = cwd.canonicalize()?;
        if !cwd.is_dir() {
            return Err(io::Error::other("Workspace is not a folder"));
        }
        let id = identifier();
        let options = if provider == "claude" {
            json!({"model":model,"chatMode":"coding","permission":"acceptEdits"})
        } else {
            json!({"model":model,"chatMode":"coding","sandbox":"workspace-write"})
        };
        self.profile.data["sessions"].as_array_mut().ok_or_else(|| io::Error::other("Invalid session list"))?.insert(0, json!({"id":id,"title":"Neuer Chat","cwd":cwd,"provider":provider,"options":options,"providerSessions":{},"messages":[],"createdAt":now(),"updatedAt":now()}));
        self.revision += 1;
        self.flush()?;
        Ok(id)
    }

    pub fn configure_chat(
        &mut self,
        chat_id: &str,
        provider: &str,
        cwd: &Path,
        model: &str,
    ) -> io::Result<()> {
        if !matches!(provider, "claude" | "codex") {
            return Err(io::Error::other("Native provider not implemented"));
        }
        if self
            .jobs
            .values()
            .any(|job| !job.finished && job.metadata["chatId"] == chat_id)
        {
            return Err(io::Error::other("Chat läuft bereits"));
        }
        let cwd = cwd.canonicalize()?;
        if !cwd.is_dir() {
            return Err(io::Error::other("Workspace is not a folder"));
        }
        let session = self.profile.data["sessions"]
            .as_array_mut()
            .and_then(|sessions| sessions.iter_mut().find(|session| session["id"] == chat_id))
            .ok_or_else(|| io::Error::other("Chat not found"))?;
        if session["provider"] != provider {
            session["options"] = if provider == "claude" {
                json!({"chatMode":"coding","permission":"acceptEdits"})
            } else {
                json!({"chatMode":"coding","sandbox":"workspace-write"})
            };
        }
        let cwd = serde_json::to_value(cwd)?;
        if session["provider"] != provider || session["cwd"] != cwd {
            session["providerSessions"] = json!({});
        }
        session["provider"] = json!(provider);
        session["cwd"] = cwd;
        if !session["options"].is_object() {
            session["options"] = json!({});
        }
        session["options"]["model"] = json!(model);
        self.revision += 1;
        self.flush()
    }

    pub fn send(
        &mut self,
        chat_id: &str,
        prompt: &str,
        host: &Path,
        worker: &Path,
    ) -> io::Result<()> {
        self.send_files(chat_id, prompt, &[], host, worker)
    }

    pub fn send_files(
        &mut self,
        chat_id: &str,
        prompt: &str,
        files: &[crate::workspace::attachments::ChatFile],
        host: &Path,
        worker: &Path,
    ) -> io::Result<()> {
        if files.len() > 8 {
            return Err(io::Error::other("Maximal 8 Anhänge pro Nachricht"));
        }
        if prompt.trim().is_empty() && files.is_empty() {
            return Err(io::Error::other("Empty message"));
        }
        if self
            .jobs
            .values()
            .any(|job| !job.finished && job.metadata["chatId"] == chat_id)
        {
            return Err(io::Error::other("This chat is already running"));
        }
        if !host.is_file() || !worker.is_file() {
            return Err(io::Error::other(
                "Native host/worker missing; run native:build-worker and build:chat-host",
            ));
        }
        let run_id = identifier();
        let message_id = identifier();
        let session = self
            .sessions()
            .iter()
            .find(|session| session["id"] == chat_id)
            .ok_or_else(|| io::Error::other("Chat not found"))?;
        let mut request = json!({"runId":run_id,"chatId":chat_id,"messageId":message_id,"provider":session["provider"],"cwd":session["cwd"],"prompt":prompt,"options":session["options"]});
        let images: Vec<_> = files
            .iter()
            .filter(|file| file.is_image())
            .map(|file| file.path.clone())
            .collect();
        let text_files: Vec<_> = files.iter().filter(|file| !file.is_image()).collect();
        request["images"] = serde_json::to_value(&images)?;
        request["files"] = serde_json::to_value(&text_files)?;
        let provider = session["provider"].as_str().unwrap_or("");
        if let Some(session_id) = session["providerSessions"][&provider].as_str() {
            request["resume"] = json!({"sessionId":session_id});
        }
        let session = self.profile.data["sessions"]
            .as_array_mut()
            .and_then(|sessions| sessions.iter_mut().find(|session| session["id"] == chat_id))
            .ok_or_else(|| io::Error::other("Chat not found"))?;
        let messages = session["messages"]
            .as_array_mut()
            .ok_or_else(|| io::Error::other("Invalid messages"))?;
        messages.push(json!({"id":identifier(),"role":"user","blocks":[{"kind":"text","text":prompt}],"images":images,"files":text_files,"createdAt":now()}));
        messages.push(json!({"id":message_id,"role":"assistant","provider":request["provider"],"model":request["options"]["model"],"blocks":[],"createdAt":now(),"workerRunId":run_id,"workerSequence":0}));
        if messages.len() == 2 {
            session["title"] = json!(if prompt.trim().is_empty() {
                files
                    .first()
                    .map(|file| file.name.clone())
                    .unwrap_or_else(|| "Neuer Chat".into())
            } else {
                prompt.chars().take(60).collect::<String>()
            });
        }
        session["updatedAt"] = json!(now());
        let directory = self.root.join("chat-jobs").join(&run_id);
        fs::create_dir_all(&directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        }
        fs::create_dir(directory.join("commands"))?;
        fs::create_dir(directory.join("acks"))?;
        let metadata = json!({"runId":run_id,"chatId":chat_id,"messageId":message_id,"provider":request["provider"],"title":session["title"],"createdAt":now(),"snapshot":session,"state":{"status":"starting","sequence":0,"heartbeat":now()}});
        fs::write(directory.join("meta.json"), serde_json::to_vec(&metadata)?)?;
        self.flush()?;
        let bootstrap = serde_json::to_vec(
            &json!({"executable":worker,"worker":"--worker","payload":{"request":request,"settings":self.profile.data["settings"],"apiKeys":{}}}),
        )?;
        let launch = (|| {
            let mut command = Command::new(host);
            command
                .arg(&directory)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                command.process_group(0);
            }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000008);
            }
            let mut child = command.spawn()?;
            let sent = child
                .stdin
                .take()
                .ok_or_else(|| io::Error::other("Missing host stdin"))
                .and_then(|mut stdin| stdin.write_all(&bootstrap));
            if let Err(error) = sent {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok::<_, io::Error>(())
        })();
        if let Err(error) = launch {
            fs::write(
                directory.join("events.jsonl"),
                format!(
                    "{}\n",
                    json!({"sequence":1,"event":{"type":"done","ok":false,"error":error.to_string()}})
                ),
            )?;
        }
        self.revision += 1;
        let mut metadata = metadata;
        metadata["snapshot"] = Value::Null;
        self.jobs.insert(
            run_id,
            Job {
                metadata,
                reader: None,
                finished: false,
            },
        );
        Ok(())
    }

    pub fn tick(&mut self) -> io::Result<bool> {
        let mut changes = Vec::new();
        for (run_id, job) in &mut self.jobs {
            if job.finished {
                continue;
            }
            let path = self
                .root
                .join("chat-jobs")
                .join(run_id)
                .join("events.jsonl");
            if job.reader.is_none() && path.exists() {
                job.reader = Some(JournalReader::open(&path, 0)?);
            }
            if job.reader.is_none()
                && processes::interrupted(&self.root.join("chat-jobs").join(run_id), &job.metadata)?
            {
                job.finished = true;
                job.metadata["nativeInterrupted"] = json!(true);
                changes.push((job.metadata["chatId"].as_str().unwrap_or("").into(),job.metadata["messageId"].as_str().unwrap_or("").into(),job.metadata["provider"].as_str().unwrap_or("").into(),crate::journal::JournalEvent{sequence:1,event:json!({"type":"done","ok":false,"error":"Chat-Prozess wurde unterbrochen, bevor ein Journal angelegt wurde."})}));
            }
            let Some(reader) = &mut job.reader else {
                continue;
            };
            for event in reader.poll()? {
                job.finished |= event.event["type"] == "done";
                changes.push((
                    job.metadata["chatId"].as_str().unwrap_or("").to_owned(),
                    job.metadata["messageId"].as_str().unwrap_or("").to_owned(),
                    job.metadata["provider"].as_str().unwrap_or("").to_owned(),
                    event,
                ));
            }
            if !job.finished
                && reader.caught_up()?
                && processes::interrupted(&self.root.join("chat-jobs").join(run_id), &job.metadata)?
            {
                job.finished = true;
                job.metadata["nativeInterrupted"] = json!(true);
                changes.push((job.metadata["chatId"].as_str().unwrap_or("").into(),job.metadata["messageId"].as_str().unwrap_or("").into(),job.metadata["provider"].as_str().unwrap_or("").into(),crate::journal::JournalEvent{sequence:reader.sequence()+1,event:json!({"type":"done","ok":false,"error":"Chat-Prozess wurde ohne vollständige Abschlussmeldung unterbrochen."})}));
            }
        }
        if changes.is_empty() {
            let plans_changed = self.finish_plans()?;
            if self.dirty && self.last_save.elapsed().as_secs() >= 5 {
                self.flush()?;
            }
            return Ok(plans_changed);
        }
        self.revision += 1;
        for (chat_id, message_id, provider, event) in changes {
            let session = self.profile.data["sessions"]
                .as_array_mut()
                .and_then(|sessions| sessions.iter_mut().find(|session| session["id"] == chat_id));
            let Some(session) = session else {
                continue;
            };
            let Some(index) = session["messages"].as_array().and_then(|messages| {
                messages
                    .iter()
                    .position(|message| message["id"] == message_id)
            }) else {
                continue;
            };
            if session["messages"][index]["workerSequence"]
                .as_u64()
                .unwrap_or(0)
                >= event.sequence
            {
                continue;
            }
            if event.event["type"] == "session" {
                if !session["providerSessions"].is_object() {
                    session["providerSessions"] = json!({});
                }
                session["providerSessions"][&provider] = event.event["sessionId"].clone();
            }
            let message = &mut session["messages"][index];
            apply(message, &event.event)?;
            message["workerSequence"] = json!(event.sequence);
            self.dirty = true;
        }
        self.finish_plans()?;
        if self.jobs.values().all(|job| job.finished) || self.last_save.elapsed().as_secs() >= 5 {
            self.flush()?;
        }
        Ok(true)
    }

    pub fn stop(&self, chat_id: &str) -> io::Result<()> {
        for (id, job) in &self.jobs {
            if !job.finished && job.metadata["chatId"] == chat_id {
                fs::write(self.root.join("chat-jobs").join(id).join("stop"), b"")?;
            }
        }
        Ok(())
    }

    pub fn prepare_close(&mut self, stop: bool) -> io::Result<()> {
        if stop {
            for (id, job) in &self.jobs {
                if !job.finished {
                    fs::write(self.root.join("chat-jobs").join(id).join("stop"), b"")?;
                }
            }
        }
        let deadline = Instant::now() + std::time::Duration::from_secs(10);
        loop {
            self.tick()?;
            let mut ready = true;
            for (id, job) in &self.jobs {
                if job.metadata["nativeInterrupted"] == true {
                    continue;
                }
                let path = self.root.join("chat-jobs").join(id).join("state.json");
                let state = match fs::read(&path) {
                    Ok(bytes) => serde_json::from_slice::<Value>(&bytes)?,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        ready &= job.finished;
                        continue;
                    }
                    Err(error) => return Err(error),
                };
                let terminal = matches!(
                    state["status"].as_str(),
                    Some("completed" | "failed" | "cancelled" | "interrupted")
                );
                ready &= if stop {
                    terminal && job.finished
                } else {
                    terminal || state["workerReady"] == true
                };
            }
            if ready {
                break;
            }
            if Instant::now() >= deadline {
                return Err(io::Error::other(
                    "Chat workers have not confirmed stop/background readiness; window stays open",
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        if self.dirty {
            return self.flush();
        }
        Ok(())
    }

    pub fn flush(&mut self) -> io::Result<()> {
        self.profile.save()?;
        self.dirty = false;
        self.last_save = Instant::now();
        for (id, job) in &mut self.jobs {
            if !job.finished || job.metadata["acknowledged"] == true {
                continue;
            }
            let mut metadata = job.metadata.clone();
            metadata["acknowledged"] = json!(true);
            metadata["snapshot"] = Value::Null;
            let directory = self.root.join("chat-jobs").join(id);
            let temporary = directory.join("meta.native.tmp");
            fs::write(&temporary, serde_json::to_vec(&metadata)?)?;
            fs::rename(temporary, directory.join("meta.json"))?;
            job.metadata = metadata;
        }
        Ok(())
    }
}

fn apply(message: &mut Value, event: &Value) -> io::Result<()> {
    let kind = event["type"].as_str().unwrap_or("");
    match kind {
        "text" | "thinking" => {
            let blocks = message["blocks"]
                .as_array_mut()
                .ok_or_else(|| io::Error::other("Invalid blocks"))?;
            if blocks.last().is_none_or(|block| block["kind"] != kind) {
                blocks.push(json!({"kind":kind,"text":""}));
            }
            if let Some(Value::String(text)) =
                blocks.last_mut().and_then(|block| block.get_mut("text"))
            {
                text.push_str(event["delta"].as_str().unwrap_or(""));
            }
        }
        "tool_start" => {
            let blocks = message["blocks"]
                .as_array_mut()
                .ok_or_else(|| io::Error::other("Invalid blocks"))?;
            let block = json!({"kind":"tool","id":event["id"],"name":event["name"],"input":event["input"],"running":true});
            if let Some(existing) = blocks
                .iter_mut()
                .find(|block| block["kind"] == "tool" && block["id"] == event["id"])
            {
                *existing = block;
            } else {
                blocks.push(block);
            }
        }
        "tool_end" => {
            if let Some(blocks) = message["blocks"].as_array_mut() {
                for block in blocks
                    .iter_mut()
                    .filter(|block| block["kind"] == "tool" && block["id"] == event["id"])
                {
                    block["output"] = event["output"].clone();
                    block["isError"] = event["isError"].clone();
                    block["running"] = json!(false);
                }
            }
        }
        "usage" => {
            if !message["usage"].is_object() {
                message["usage"] = json!({});
            }
            if let Some(values) = event.as_object() {
                for (key, value) in values {
                    if key != "type" && !value.is_null() {
                        message["usage"][key] = value.clone();
                    }
                }
            }
        }
        "notice" => message["error"] = event["text"].clone(),
        "done" => {
            message["workerDone"] = json!(true);
            if event["ok"] == false && event["error"].is_string() {
                message["error"] = event["error"].clone();
            }
            if let Some(blocks) = message["blocks"].as_array_mut() {
                for block in blocks.iter_mut().filter(|block| block["kind"] == "tool") {
                    block["running"] = json!(false);
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub(crate) fn identifier() -> String {
    format!(
        "native-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}
