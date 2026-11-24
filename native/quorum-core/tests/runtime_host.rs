#![cfg(unix)]
use quorum_core::jobs::Runtime;
use serde_json::json;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        let jobs = self.0.join("chat-jobs");
        if let Ok(entries) = fs::read_dir(jobs) {
            for entry in entries.flatten().filter(|entry| entry.path().is_dir()) {
                let _ = fs::write(entry.path().join("stop"), "");
            }
        }
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
#[ignore = "requires built quorum-chat-host; use npm run test:native-runtime"]
fn native_chat_launch_persistence_and_reopen() {
    let root = std::env::temp_dir().join(format!(
        "quorum-runtime-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&root).unwrap();
    let fixture = Fixture(root);
    let fake = fixture.0.join("fake-claude");
    fs::write(&fake, "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '{\"type\":\"assistant\",\"session_id\":\"native-session\",\"message\":{\"id\":\"m\",\"content\":[{\"type\":\"text\",\"text\":\"native response 🦀\"}]}}'\n").unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(fixture.0.join("hub.json"), serde_json::to_vec(&json!({"version":1,"sessions":[],"settings":{"binaries":{"claude":fake}},"future":"preserved"})).unwrap()).unwrap();
    let host = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../bin/quorum-chat-host");
    let worker = PathBuf::from(env!("CARGO_BIN_EXE_quorum-provider-worker"));
    let mut runtime = Runtime::open(&fixture.0).unwrap();
    let id = runtime
        .create_chat("claude", &fixture.0, "claude-fable-5-2")
        .unwrap();
    runtime.send(&id, "Testauftrag", &host, &worker).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !runtime.snapshot().unwrap().active.is_empty() {
        assert!(
            Instant::now() < deadline,
            "native chat completion timed out"
        );
        runtime.tick().unwrap();
        std::thread::sleep(Duration::from_millis(25));
    }
    runtime.prepare_close(false).unwrap();
    let snapshot = runtime.snapshot().unwrap();
    assert_eq!(snapshot.archive.sessions[0].messages.len(), 2);
    assert_eq!(
        snapshot.archive.sessions[0].messages[1].blocks[0]
            .text
            .as_deref(),
        Some("native response 🦀")
    );
    drop(runtime);
    let mut reopened = Runtime::open(&fixture.0).unwrap();
    reopened.tick().unwrap();
    assert!(reopened.snapshot().unwrap().active.is_empty());
    assert_eq!(
        reopened.snapshot().unwrap().archive.sessions[0]
            .messages
            .len(),
        2
    );
    let data: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.0.join("hub.json")).unwrap()).unwrap();
    assert_eq!(data["future"], "preserved");
    assert_eq!(
        data["sessions"][0]["providerSessions"]["claude"],
        "native-session"
    );
}

#[test]
#[ignore = "requires built quorum-chat-host; use npm run test:native-runtime"]
fn native_plan_generation_is_read_only_and_recovers_after_reopen() {
    let root = std::env::temp_dir().join(format!(
        "quorum-plan-pipeline-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&root).unwrap();
    let fixture = Fixture(root);
    let definition = json!({"objective":"Native integration plan","requirements":[],"constraints":[],"assumptions":[],"outOfScope":[],"phases":[{"id":"phase","title":"Implementation","order":0}],"tasks":[{"id":"task","phaseId":"phase","order":0,"title":"Task","description":"Implement the feature","dependencies":[],"priority":"normal","complexity":"simple","instructions":[],"acceptanceCriteria":[{"id":"check","description":"Works","verification":"manual"}],"expectedFiles":[],"expectedArtifacts":[],"requiresApproval":true,"maxAttempts":1}],"modelAssignments":[]});
    let response = fixture.0.join("response.jsonl");
    fs::write(&response,format!("{}\n",json!({"type":"assistant","message":{"id":"plan-output","content":[{"type":"text","text":definition.to_string()}]}}))).unwrap();
    let fake = fixture.0.join("fake-planner");
    fs::write(
        &fake,
        format!(
            "#!/bin/sh\nprintf '%s' \"$*\" > '{}'\ncat > '{}'\nsleep 0.1\ncat '{}'\n",
            fixture.0.join("args").display(),
            fixture.0.join("prompt").display(),
            response.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(
        fixture.0.join("hub.json"),
        serde_json::to_vec(
            &json!({"version":1,"sessions":[],"settings":{"binaries":{"claude":fake}}}),
        )
        .unwrap(),
    )
    .unwrap();
    let host = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../bin/quorum-chat-host");
    let worker = PathBuf::from(env!("CARGO_BIN_EXE_quorum-provider-worker"));
    let mut runtime = Runtime::open(&fixture.0).unwrap();
    let id = runtime
        .start_plan(
            &fixture.0,
            "claude",
            "claude-fable-5-2",
            "Native integration plan",
            &host,
            &worker,
        )
        .unwrap();
    runtime.prepare_close(false).unwrap();
    drop(runtime);
    let mut runtime = Runtime::open(&fixture.0).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        runtime.tick().unwrap();
        if runtime.plan_generation(&id).unwrap()["finished"] == true {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(25));
    }
    let result = runtime.plan_generation(&id).unwrap();
    assert!(result["error"].is_null(), "{result}");
    let plan_id = result["result"].as_str().unwrap();
    let store = quorum_core::plan::PlanStore::open(&fixture.0.join("plans.sqlite")).unwrap();
    assert_eq!(store.get(plan_id).unwrap().definition, definition);
    assert!(
        fs::read_to_string(fixture.0.join("args"))
            .unwrap()
            .contains("--permission-mode plan")
    );
    assert!(
        !fs::read_to_string(fixture.0.join("args"))
            .unwrap()
            .contains("dangerously")
    );
    assert!(
        fs::read_to_string(fixture.0.join("prompt"))
            .unwrap()
            .contains("Native integration plan")
    );
}
