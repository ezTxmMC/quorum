use quorum_core::{archive, journal::JournalReader};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "quorum-core-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn legacy_archive_remains_unchanged_and_unicode_is_not_cut() {
    let fixture = Fixture::new();
    let path = fixture.0.join("hub.json");
    let text = "🦀".repeat(301);
    let bytes = serde_json::to_vec(&serde_json::json!({
        "version": 1, "settings": { "unknownFutureSetting": 42 },
        "sessions": [{"id":"chat","title":"Titel","cwd":"/tmp","provider":"claude",
            "messages":[{"role":"user","blocks":[{"kind":"text","text":text}],"futureField":"keep"}]}]
    })).unwrap();
    fs::write(&path, &bytes).unwrap();
    let loaded = archive::load(&path).unwrap();
    let rows = archive::transcript(&loaded.sessions[0]);
    assert_eq!(
        rows[1..4]
            .iter()
            .map(|row| row.as_ref())
            .collect::<String>(),
        text
    );
    assert_eq!(fs::read(&path).unwrap(), bytes);
}

#[test]
fn partial_unicode_frames_and_durable_cursor() {
    let fixture = Fixture::new();
    let path = fixture.0.join("events.jsonl");
    let first = b"{\"sequence\":1,\"event\":{\"type\":\"text\",\"delta\":\"old\"}}\n";
    let second = "{\"sequence\":2,\"event\":{\"type\":\"text\",\"delta\":\"🦀\"}}\n";
    let split = second.find('🦀').unwrap() + 2;
    fs::write(&path, first).unwrap();
    let mut append = OpenOptions::new().append(true).open(&path).unwrap();
    append.write_all(&second.as_bytes()[..split]).unwrap();
    let mut reader = JournalReader::open(&path, 1).unwrap();
    assert!(reader.poll().unwrap().is_empty());
    append.write_all(&second.as_bytes()[split..]).unwrap();
    let events = reader.poll().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event["delta"], "🦀");
    assert_eq!(reader.sequence(), 2);
    assert!(reader.poll().unwrap().is_empty());
}

#[test]
fn sequence_gap_does_not_acknowledge_partial_batch() {
    let fixture = Fixture::new();
    let path = fixture.0.join("events.jsonl");
    fs::write(
        &path,
        "{\"sequence\":1,\"event\":{}}\n{\"sequence\":3,\"event\":{}}\n",
    )
    .unwrap();
    let mut reader = JournalReader::open(&path, 0).unwrap();
    assert!(reader.poll().is_err());
    assert_eq!(reader.sequence(), 0);
}

#[test]
fn bounded_batches_and_truncation_detection() {
    let fixture = Fixture::new();
    let path = fixture.0.join("events.jsonl");
    let mut bytes = String::new();
    for sequence in 1..=20000 {
        bytes.push_str(&format!("{{\"sequence\":{sequence},\"event\":{{}}}}\n"));
    }
    fs::write(&path, bytes).unwrap();
    let mut reader = JournalReader::open(&path, 0).unwrap();
    let first = reader.poll().unwrap();
    assert!(!first.is_empty() && first.len() < 20000);
    let mut total = first.len();
    while reader.sequence() < 20000 {
        total += reader.poll().unwrap().len();
    }
    assert_eq!(total, 20000);
    fs::write(&path, "").unwrap();
    assert!(reader.poll().is_err());
}

#[test]
fn native_profile_keeps_unknown_fields_and_rejects_other_writers() {
    use quorum_core::profile::Profile;
    let fixture = Fixture::new();
    let path = fixture.0.join("hub.json");
    fs::write(
        &path,
        r#"{"version":1,"sessions":[],"settings":{"future":42},"unknown":{"attachments":[1,2]}}"#,
    )
    .unwrap();
    let mut profile = Profile::open(&fixture.0).unwrap();
    assert!(Profile::open(&fixture.0).is_err());
    profile.data["settings"]["future"] = serde_json::json!(43);
    profile.save().unwrap();
    let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["settings"]["future"], 43);
    assert_eq!(saved["unknown"]["attachments"], serde_json::json!([1, 2]));
    fs::write(&path, r#"{"version":1,"sessions":[],"external":true}"#).unwrap();
    assert!(profile.save().is_err());
    drop(profile);
    assert!(
        Profile::open(&fixture.0).is_ok(),
        "OS ownership lock releases on close"
    );
}

#[test]
fn workspace_file_roundtrip_and_stale_buffer_protection() {
    use quorum_core::workspace::Workspace;
    let fixture = Fixture::new();
    fs::write(fixture.0.join("main.rs"), "old 🦀").unwrap();
    let workspace = Workspace::open(&fixture.0).unwrap();
    assert_eq!(
        workspace.list(std::path::Path::new("")).unwrap()[0].path,
        "main.rs"
    );
    let file = std::path::Path::new("main.rs");
    workspace.save(file, "old 🦀", "new 🦀").unwrap();
    assert_eq!(workspace.read(file).unwrap(), "new 🦀");
    assert!(workspace.save(file, "old 🦀", "overwrite").is_err());
    assert!(workspace.read(std::path::Path::new("../outside")).is_err());
    fs::write(fixture.0.join("binary"), b"a\0b").unwrap();
    assert!(workspace.read(std::path::Path::new("binary")).is_err());
}

#[cfg(unix)]
#[test]
fn workspace_rejects_symlink_escape() {
    use quorum_core::workspace::Workspace;
    let root = Fixture::new();
    let outside = Fixture::new();
    fs::write(outside.0.join("secret"), "secret").unwrap();
    std::os::unix::fs::symlink(&outside.0, root.0.join("escape")).unwrap();
    let workspace = Workspace::open(&root.0).unwrap();
    assert!(workspace.list(std::path::Path::new("")).unwrap().is_empty());
    assert!(
        workspace
            .read(std::path::Path::new("escape/secret"))
            .is_err()
    );
}

#[test]
fn native_runtime_durably_replays_then_acknowledges_completed_job() {
    use quorum_core::jobs::Runtime;
    let fixture = Fixture::new();
    fs::write(fixture.0.join("hub.json"), serde_json::to_vec(&serde_json::json!({"version":1,"settings":{"future":42},"sessions":[{"id":"chat","title":"Chat","cwd":"/tmp","provider":"claude","messages":[{"id":"m","role":"assistant","blocks":[]}]}]})).unwrap()).unwrap();
    let job = fixture.0.join("chat-jobs/run");
    fs::create_dir_all(&job).unwrap();
    fs::write(
        job.join("meta.json"),
        br#"{"runId":"run","chatId":"chat","messageId":"m","provider":"claude"}"#,
    )
    .unwrap();
    fs::write(job.join("events.jsonl"), "{\"sequence\":1,\"event\":{\"type\":\"text\",\"delta\":\"Rust 🦀\"}}\n{\"sequence\":2,\"event\":{\"type\":\"done\",\"ok\":true}}\n").unwrap();
    let mut runtime = Runtime::open(&fixture.0).unwrap();
    assert!(runtime.tick().unwrap());
    assert_eq!(
        runtime.snapshot().unwrap().archive.sessions[0].messages[0].blocks[0]
            .text
            .as_deref(),
        Some("Rust 🦀")
    );
    drop(runtime);
    let saved: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.0.join("hub.json")).unwrap()).unwrap();
    assert_eq!(saved["sessions"][0]["messages"][0]["workerSequence"], 2);
    assert_eq!(saved["settings"]["future"], 42);
    let metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(job.join("meta.json")).unwrap()).unwrap();
    assert_eq!(metadata["acknowledged"], true);
    let mut reopened = Runtime::open(&fixture.0).unwrap();
    assert!(!reopened.tick().unwrap());
    assert_eq!(
        reopened.snapshot().unwrap().archive.sessions[0].messages[0]
            .blocks
            .len(),
        1
    );
}

#[test]
fn chat_configuration_matches_selected_model_and_resets_changed_project_resume() {
    use quorum_core::jobs::Runtime;
    let fixture = Fixture::new();
    let mut runtime = Runtime::open(&fixture.0).unwrap();
    let id = runtime
        .create_chat("claude", &fixture.0, "claude-fable-5-2")
        .unwrap();
    runtime
        .configure_chat(&id, "claude", &fixture.0, "claude-opus-5-5")
        .unwrap();
    assert_eq!(
        runtime.snapshot().unwrap().archive.sessions[0].options["model"],
        "claude-opus-5-5"
    );
    drop(runtime);
    let path = fixture.0.join("hub.json");
    let mut data: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    data["sessions"][0]["providerSessions"] = serde_json::json!({"claude":"previous"});
    data["sessions"][0]["future"] = serde_json::json!({"keep":true});
    fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
    let mut runtime = Runtime::open(&fixture.0).unwrap();
    runtime
        .configure_chat(&id, "claude", &fixture.0, "claude-fable-5-2")
        .unwrap();
    assert!(
        runtime
            .configure_chat(&id, "other", &fixture.0, "unknown")
            .is_err()
    );
    assert!(
        runtime
            .configure_chat(&id, "claude", &fixture.0.join("missing"), "unknown")
            .is_err()
    );
    let unchanged: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        unchanged["sessions"][0]["providerSessions"]["claude"],
        "previous"
    );
    let project = fixture.0.join("project");
    fs::create_dir(&project).unwrap();
    runtime.configure_chat(&id, "codex", &project, "").unwrap();
    let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        saved["sessions"][0]["providerSessions"],
        serde_json::json!({})
    );
    assert_eq!(
        saved["sessions"][0]["options"]["sandbox"],
        "workspace-write"
    );
    assert_eq!(saved["sessions"][0]["future"]["keep"], true);
}
