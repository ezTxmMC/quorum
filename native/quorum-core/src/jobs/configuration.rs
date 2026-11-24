use super::*;

impl Runtime {
    pub fn settings(&self) -> Value {
        self.profile.data["settings"].clone()
    }
    pub fn set_binaries(&mut self, claude: &str, codex: &str) -> io::Result<()> {
        for value in [claude, codex] {
            if value.contains('\0') || value.len() > 4096 {
                return Err(io::Error::other("Ungültiger CLI-Pfad"));
            }
        }
        if !self.profile.data["settings"].is_object() {
            self.profile.data["settings"] = json!({});
        }
        if !self.profile.data["settings"]["binaries"].is_object() {
            self.profile.data["settings"]["binaries"] = json!({});
        }
        for (key, value) in [("claude", claude), ("codex", codex)] {
            self.profile.data["settings"]["binaries"][key] = json!(if value.trim().is_empty() {
                key
            } else {
                value.trim()
            });
        }
        self.revision += 1;
        self.flush()
    }
    pub fn set_access(&mut self, id: &str, read_only: bool) -> io::Result<()> {
        if self
            .jobs
            .values()
            .any(|job| !job.finished && job.metadata["chatId"] == id)
        {
            return Err(io::Error::other(
                "Zugriffsrechte können während eines Laufs nicht geändert werden",
            ));
        }
        let session = self.profile.data["sessions"]
            .as_array_mut()
            .and_then(|sessions| sessions.iter_mut().find(|session| session["id"] == id))
            .ok_or_else(|| io::Error::other("Chat fehlt"))?;
        if !session["options"].is_object() {
            session["options"] = json!({});
        }
        session["options"]["permission"] = json!(if read_only { "plan" } else { "acceptEdits" });
        session["options"]["sandbox"] = json!(if read_only {
            "read-only"
        } else {
            "workspace-write"
        });
        session["options"]["fullAccess"] = json!(false);
        self.revision += 1;
        self.flush()
    }
    pub fn rename_chat(&mut self, id: &str, title: &str) -> io::Result<()> {
        if title.trim().is_empty() || title.chars().count() > 200 {
            return Err(io::Error::other("Titel muss 1–200 Zeichen enthalten"));
        }
        let session = self.profile.data["sessions"]
            .as_array_mut()
            .and_then(|sessions| sessions.iter_mut().find(|session| session["id"] == id))
            .ok_or_else(|| io::Error::other("Chat fehlt"))?;
        session["title"] = json!(title.trim());
        session["updatedAt"] = json!(now());
        self.revision += 1;
        self.flush()
    }
    pub fn delete_chat(&mut self, id: &str) -> io::Result<()> {
        self.stop(id)?;
        let path = self.root.join("chat-jobs").join("deleted-chats.json");
        fs::create_dir_all(
            path.parent()
                .ok_or_else(|| io::Error::other("Jobs directory missing"))?,
        )?;
        let mut tombstones: Vec<String> = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error),
        };
        if !tombstones.iter().any(|chat| chat == id) {
            tombstones.push(id.to_owned());
        }
        let temporary = path.with_extension("native.tmp");
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let result = (|| {
            output.write_all(&serde_json::to_vec(&tombstones)?)?;
            output.sync_all()?;
            fs::rename(&temporary, &path)
        })();
        drop(output);
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result?;
        for (run_id, job) in &mut self.jobs {
            if job.metadata["chatId"] != id {
                continue;
            }
            job.metadata["forgotten"] = json!(true);
            job.finished = true;
            let metadata = self.root.join("chat-jobs").join(run_id).join("meta.json");
            if metadata.exists() {
                let mut value: Value = serde_json::from_slice(&fs::read(&metadata)?)?;
                value["forgotten"] = json!(true);
                fs::write(metadata, serde_json::to_vec(&value)?)?;
            }
        }
        self.profile.data["sessions"]
            .as_array_mut()
            .ok_or_else(|| io::Error::other("Invalid session list"))?
            .retain(|session| session["id"] != id);
        self.revision += 1;
        self.flush()
    }
}
