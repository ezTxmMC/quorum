use super::*;
#[derive(Clone, Debug)]
pub struct ProcessInfo {
    pub chat_id: String,
    pub title: String,
    pub provider: String,
    pub status: String,
    pub pid: Option<u64>,
    pub worker_pid: Option<u64>,
    pub age_ms: u64,
}
fn state(directory: &Path, metadata: &Value) -> io::Result<Value> {
    match fs::read(directory.join("state.json")) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(metadata["state"].clone()),
        Err(error) => Err(error),
    }
}
pub(super) fn interrupted(directory: &Path, metadata: &Value) -> io::Result<bool> {
    let state = state(directory, metadata)?;
    if matches!(
        state["status"].as_str(),
        Some("completed" | "failed" | "cancelled" | "interrupted")
    ) {
        return Ok(true);
    }
    let heartbeat = state["heartbeat"]
        .as_u64()
        .or_else(|| metadata["createdAt"].as_u64())
        .unwrap_or_else(now);
    if now().saturating_sub(heartbeat) < 15_000 {
        return Ok(false);
    }
    let Some(pid) = state["pid"].as_u64().filter(|pid| *pid > 0) else {
        return Ok(true);
    };
    #[cfg(target_os = "linux")]
    {
        let path = PathBuf::from(format!("/proc/{pid}/stat"));
        match fs::read_to_string(path) {
            Ok(stat) => Ok(stat
                .rsplit_once(')')
                .is_some_and(|(_, tail)| tail.trim_start().starts_with('Z'))),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
            Err(_) => Ok(false),
        }
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        Ok(Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| !status.success()))
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        Ok(false)
    }
}
impl Runtime {
    pub fn processes(&self) -> io::Result<Vec<ProcessInfo>> {
        self.jobs
            .iter()
            .map(|(id, job)| {
                let state = state(&self.root.join("chat-jobs").join(id), &job.metadata)?;
                Ok(ProcessInfo {
                    chat_id: job.metadata["chatId"].as_str().unwrap_or("").into(),
                    title: job.metadata["title"].as_str().unwrap_or("Chat").into(),
                    provider: job.metadata["provider"].as_str().unwrap_or("").into(),
                    status: if job.metadata["nativeInterrupted"] == true {
                        "interrupted".into()
                    } else if job.finished && state["status"] == "starting" {
                        "beendet".into()
                    } else {
                        state["status"].as_str().unwrap_or("unbekannt").into()
                    },
                    pid: state["pid"].as_u64(),
                    worker_pid: state["workerPid"].as_u64(),
                    age_ms: now()
                        .saturating_sub(job.metadata["createdAt"].as_u64().unwrap_or_else(now)),
                })
            })
            .collect()
    }
    pub fn stop_all(&self) -> io::Result<()> {
        for (id, job) in &self.jobs {
            if !job.finished {
                fs::write(self.root.join("chat-jobs").join(id).join("stop"), b"")?;
            }
        }
        Ok(())
    }
}
