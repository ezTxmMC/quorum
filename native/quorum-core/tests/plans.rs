use quorum_core::plan::{PlanStore, hash, parse_generated};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "quorum-plans-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn definition() -> Value {
    json!({"objective":"Testplan","requirements":[],"constraints":[],"assumptions":[],"outOfScope":[],"phases":[{"id":"phase","title":"Umsetzung","order":0}],"tasks":[{"id":"one","phaseId":"phase","order":0,"title":"Aufgabe","description":"Beschreibung","dependencies":[],"priority":"normal","complexity":"simple","instructions":[],"acceptanceCriteria":[{"id":"criterion","description":"Funktioniert","verification":"manual"}],"expectedFiles":["src/main.rs"],"expectedArtifacts":[],"requiresApproval":true,"maxAttempts":1}],"modelAssignments":[]})
}
#[test]
fn native_plans_reopen_preserve_revisions_and_reject_stale_approval() {
    let fixture = Fixture::new();
    let path = fixture.0.join("plans.sqlite");
    let mut store = PlanStore::open(&path).unwrap();
    let plan = store
        .save(None, None, &fixture.0, "Plan", &definition())
        .unwrap();
    assert_eq!(plan.revision, 1);
    assert!(store.approve(&plan.summary.id, "stale").is_err());
    let approved = store.approve(&plan.summary.id, &plan.revision_id).unwrap();
    assert_eq!(approved.summary.status, "approved");
    let mut changed = definition();
    changed["tasks"][0]["description"] = json!("Geändert");
    let revision = store
        .save(
            Some(&plan.summary.id),
            Some(&plan.revision_id),
            &fixture.0,
            "Plan",
            &changed,
        )
        .unwrap();
    assert_eq!(revision.revision, 2);
    assert_eq!(revision.summary.status, "draft");
    assert!(
        store
            .save(
                Some(&plan.summary.id),
                Some(&plan.revision_id),
                &fixture.0,
                "Stale",
                &definition()
            )
            .is_err()
    );
    assert!(store.approve(&plan.summary.id, &plan.revision_id).is_err());
    drop(store);
    let reopened = PlanStore::open(&path).unwrap();
    assert_eq!(reopened.list().unwrap().len(), 1);
    assert_eq!(reopened.get(&plan.summary.id).unwrap().definition, changed);
    let connection = rusqlite::Connection::open(path).unwrap();
    let revisions: u32 = connection
        .query_row("SELECT count(*) FROM plan_revisions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(revisions, 2);
    let approvals: u32 = connection
        .query_row("SELECT count(*) FROM plan_approvals", [], |row| row.get(0))
        .unwrap();
    assert_eq!(approvals, 1);
}
#[test]
fn generated_plans_reject_cycles_unknown_dependencies_and_escaping_paths() {
    let mut value = definition();
    assert!(parse_generated(&format!("```json\n{}\n```", value)).is_ok());
    value["tasks"][0]["dependencies"] = json!(["one"]);
    assert!(parse_generated(&value.to_string()).is_err());
    value["tasks"][0]["dependencies"] = json!(["unknown"]);
    assert!(parse_generated(&value.to_string()).is_err());
    value["tasks"][0]["dependencies"] = json!([]);
    value["tasks"][0]["expectedFiles"] = json!(["../outside"]);
    assert!(parse_generated(&value.to_string()).is_err());
    value["tasks"][0]["expectedFiles"] = json!(["C:\\outside"]);
    assert!(parse_generated(&value.to_string()).is_err());
}
#[test]
fn hashes_match_legacy_sorted_json_and_tampering_is_detected() {
    let fixture = Fixture::new();
    let path = fixture.0.join("plans.sqlite");
    assert_eq!(
        hash(&json!({"b":2,"a":1})).unwrap(),
        "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
    );
    let mut store = PlanStore::open(&path).unwrap();
    let plan = store
        .save(None, None, &fixture.0, "Plan", &definition())
        .unwrap();
    let connection = rusqlite::Connection::open(path).unwrap();
    connection
        .execute("UPDATE plan_revisions SET definition_json='{}'", [])
        .unwrap();
    assert!(store.get(&plan.summary.id).is_err());
}
#[test]
fn completed_planning_chat_is_imported_once_after_restart() {
    let fixture = Fixture::new();
    let definition = definition();
    let profile = json!({"version":1,"settings":{},"sessions":[{"id":"planning","title":"Plan","provider":"claude","cwd":fixture.0,"options":{},"nativePlan":{"planId":"plan-planning","objective":"Testplan","finished":false},"messages":[{"id":"assistant","role":"assistant","workerDone":true,"blocks":[{"kind":"text","text":definition.to_string()}]}]}]});
    fs::write(
        fixture.0.join("hub.json"),
        serde_json::to_vec(&profile).unwrap(),
    )
    .unwrap();
    let runtime = quorum_core::jobs::Runtime::open(&fixture.0).unwrap();
    assert_eq!(
        runtime.plan_generation("planning").unwrap()["result"],
        "plan-planning"
    );
    drop(runtime);
    let mut stale = profile;
    stale["sessions"][0]["nativePlan"]["finished"] = json!(false);
    fs::write(
        fixture.0.join("hub.json"),
        serde_json::to_vec(&stale).unwrap(),
    )
    .unwrap();
    let _runtime = quorum_core::jobs::Runtime::open(&fixture.0).unwrap();
    let store = PlanStore::open(&fixture.0.join("plans.sqlite")).unwrap();
    assert_eq!(store.list().unwrap().len(), 1);
    assert_eq!(store.get("plan-planning").unwrap().revision, 1);
}
