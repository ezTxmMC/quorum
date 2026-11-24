use quorum_core::{
    archive::Archive,
    jobs::Runtime,
    workspace::{Workspace, attachments, git, search},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "quorum-features-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn attachments_keep_snapshots_and_validate_formats() {
    let fixture = Fixture::new();
    let text = fixture.0.join("text.txt");
    fs::write(&text, "Grüße 🦀\nZeile 2").unwrap();
    let saved = attachments::stage(&fixture.0, &text).unwrap();
    fs::write(&text, "changed").unwrap();
    assert_eq!(saved.text.as_deref(), Some("Grüße 🦀\nZeile 2"));
    let image = fixture.0.join("input.png");
    let bytes = b"\x89PNG\r\n\x1a\nimage";
    fs::write(&image, bytes).unwrap();
    let captured = attachments::stage(&fixture.0, &image).unwrap();
    fs::remove_file(&image).unwrap();
    assert_eq!(fs::read(&captured.path).unwrap(), bytes);
    assert!(captured.is_image());
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    assert!(attachments::stage_inline(&fixture.0, "legacy.png", "image/png", &encoded).is_ok());
    assert!(attachments::stage_inline(&fixture.0, "legacy.jpg", "image/jpeg", &encoded).is_err());
    let binary = fixture.0.join("binary");
    fs::write(&binary, b"a\0b").unwrap();
    assert!(attachments::stage(&fixture.0, &binary).is_err());
    let archive:Archive=serde_json::from_value(json!({"sessions":[{"id":"x","title":"x","provider":"claude","messages":[{"role":"user","files":[{"name":"pasted.txt","text":"snapshot"}]}]}]})).unwrap();
    assert_eq!(
        archive.sessions[0].messages[0].files[0].text.as_deref(),
        Some("snapshot")
    );
}
#[test]
fn deleted_chats_are_not_restored_from_worker_snapshots() {
    let fixture = Fixture::new();
    let mut runtime = Runtime::open(&fixture.0).unwrap();
    let id = runtime.create_chat("claude", &fixture.0, "").unwrap();
    drop(runtime);
    let path = fixture.0.join("hub.json");
    let mut profile: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let snapshot = profile["sessions"][0].clone();
    let directory = fixture.0.join("chat-jobs/old-run");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("meta.json"),serde_json::to_vec(&json!({"runId":"old-run","chatId":id,"snapshot":snapshot,"state":{"heartbeat":u64::MAX,"status":"starting"}})).unwrap()).unwrap();
    let mut runtime = Runtime::open(&fixture.0).unwrap();
    runtime.delete_chat(&id).unwrap();
    assert!(directory.join("stop").is_file());
    drop(runtime);
    // Simulate a crash after tombstone persistence but before the profile deletion was flushed.
    profile["sessions"][0]["future"] = json!("preserved until deleted");
    fs::write(&path, serde_json::to_vec(&profile).unwrap()).unwrap();
    let reopened = Runtime::open(&fixture.0).unwrap();
    assert!(reopened.snapshot().unwrap().archive.sessions.is_empty());
    assert!(reopened.snapshot().unwrap().active.is_empty());
}
#[cfg(target_os = "linux")]
#[test]
fn dead_supervisor_finishes_chat_and_allows_close() {
    let fixture = Fixture::new();
    let directory = fixture.0.join("chat-jobs/dead-run");
    fs::create_dir_all(&directory).unwrap();
    let session = json!({"id":"chat","title":"Interrupted","provider":"claude","cwd":fixture.0,"messages":[{"id":"assistant","role":"assistant","workerRunId":"dead-run","workerSequence":0,"blocks":[]}]});
    fs::write(
        fixture.0.join("hub.json"),
        serde_json::to_vec(&json!({"version":1,"sessions":[session],"settings":{}})).unwrap(),
    )
    .unwrap();
    fs::write(directory.join("meta.json"),serde_json::to_vec(&json!({"runId":"dead-run","chatId":"chat","messageId":"assistant","provider":"claude","createdAt":0})).unwrap()).unwrap();
    fs::write(
        directory.join("state.json"),
        r#"{"pid":4294967295,"status":"running","heartbeat":0}"#,
    )
    .unwrap();
    fs::write(
        directory.join("events.jsonl"),
        r#"{"sequence":1,"event":{"type":"text","delta":"partial"}}"#,
    )
    .unwrap();
    let mut runtime = Runtime::open(&fixture.0).unwrap();
    runtime.tick().unwrap();
    assert!(runtime.snapshot().unwrap().active.is_empty());
    assert!(
        runtime.snapshot().unwrap().archive.sessions[0].messages[0]
            .error
            .is_some()
    );
    runtime.prepare_close(true).unwrap();
}
#[test]
fn workspace_creation_and_search_stay_inside_project() {
    let fixture = Fixture::new();
    let workspace = Workspace::open(&fixture.0).unwrap();
    workspace.create_directory(Path::new("src")).unwrap();
    workspace
        .create(Path::new("src/main.rs"), "needle 🦀")
        .unwrap();
    assert!(
        workspace
            .create(Path::new("src/main.rs"), "overwrite")
            .is_err()
    );
    assert!(workspace.create(Path::new("../escape"), "x").is_err());
    fs::create_dir(fixture.0.join("node_modules")).unwrap();
    fs::write(fixture.0.join("node_modules/ignored"), "needle").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&fixture.0, fixture.0.join("loop")).unwrap();
    let found = search::search(&fixture.0, "needle").unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].line, 1);
    assert!(found[0].path.ends_with("src/main.rs"));
}
fn command(root: &Path, args: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
#[test]
fn git_handles_unicode_paths_staging_and_subdirectory_scope() {
    let fixture = Fixture::new();
    command(&fixture.0, &["-c", "init.templateDir=", "init", "-q"]);
    fs::create_dir(fixture.0.join("sub")).unwrap();
    fs::write(fixture.0.join("sub/Grüße file.txt"), "original\n").unwrap();
    fs::write(fixture.0.join("outside.txt"), "outside\n").unwrap();
    command(&fixture.0, &["add", "."]);
    command(
        &fixture.0,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "initial",
        ],
    );
    fs::write(fixture.0.join("sub/Grüße file.txt"), "changed\n").unwrap();
    fs::write(fixture.0.join("outside.txt"), "changed outside\n").unwrap();
    let root = fixture.0.join("sub");
    let changes = git::status(&root).unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].path, "Grüße file.txt");
    assert!(
        git::diff(&root, "Grüße file.txt")
            .unwrap()
            .contains("+changed")
    );
    git::stage(&root, "Grüße file.txt").unwrap();
    assert!(git::status(&root).unwrap()[0].status.starts_with('M'));
    assert!(git::stage(&root, "../outside.txt").is_err());
}
