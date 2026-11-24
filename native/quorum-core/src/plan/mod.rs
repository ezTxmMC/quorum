mod validation;
use crate::jobs::identifier;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{io, path::Path, time::Duration};

#[derive(Clone, Debug)]
pub struct Summary {
    pub id: String,
    pub title: String,
    pub root: String,
    pub status: String,
}
#[derive(Clone, Debug)]
pub struct Plan {
    pub summary: Summary,
    pub revision_id: String,
    pub revision: u32,
    pub definition: Value,
    pub content_hash: String,
}
pub struct PlanStore {
    db: Connection,
}
fn db<T>(result: rusqlite::Result<T>) -> io::Result<T> {
    result.map_err(io::Error::other)
}
pub fn hash(definition: &Value) -> io::Result<String> {
    fn canonical(value: &Value, output: &mut String) -> io::Result<()> {
        match value {
            Value::Object(object) => {
                output.push('{');
                let mut keys: Vec<_> = object.keys().collect();
                keys.sort();
                for (index, key) in keys.into_iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    output.push_str(&serde_json::to_string(key)?);
                    output.push(':');
                    canonical(&object[key], output)?;
                }
                output.push('}');
            }
            Value::Array(values) => {
                output.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    canonical(value, output)?;
                }
                output.push(']');
            }
            value => output.push_str(&serde_json::to_string(value)?),
        }
        Ok(())
    }
    let mut json = String::new();
    canonical(definition, &mut json)?;
    Ok(format!("{:x}", Sha256::digest(json.as_bytes())))
}

impl PlanStore {
    pub fn open(path: &Path) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut connection = db(Connection::open(path))?;
        db(connection.busy_timeout(Duration::from_secs(5)))?;
        db(connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;"))?;
        let version: u32 = db(connection.query_row("PRAGMA user_version", [], |row| row.get(0)))?;
        if version > 1 {
            return Err(io::Error::other(
                "Plan-Datenbank stammt aus einer neueren Quorum-Version",
            ));
        }
        if version == 0 {
            let tx = db(connection.transaction())?;
            db(tx.execute_batch(include_str!("schema.sql")))?;
            db(tx.commit())?;
        }
        Ok(Self { db: connection })
    }
    pub fn list(&self) -> io::Result<Vec<Summary>> {
        let mut query=db(self.db.prepare("SELECT p.id,p.title,w.root,p.status FROM plans p JOIN workspaces w ON w.id=p.workspace_id ORDER BY p.updated_at DESC"))?;
        db(query.query_map([], |row| {
            Ok(Summary {
                id: row.get(0)?,
                title: row.get(1)?,
                root: row.get(2)?,
                status: row.get(3)?,
            })
        }))?
        .map(db)
        .collect()
    }
    pub fn get(&self, id: &str) -> io::Result<Plan> {
        let (summary,revision_id,revision,definition,content_hash):(Summary,String,u32,String,String)=db(self.db.query_row("SELECT p.title,w.root,p.status,r.id,r.revision,r.definition_json,r.content_hash FROM plans p JOIN workspaces w ON w.id=p.workspace_id JOIN plan_revisions r ON r.id=p.current_revision_id WHERE p.id=?",[id],|row|Ok((Summary{id:id.into(),title:row.get(0)?,root:row.get(1)?,status:row.get(2)?},row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?))))?;
        let definition: Value = serde_json::from_str(&definition)?;
        if hash(&definition)? != content_hash {
            return Err(io::Error::other("Plan-Integritätsprüfung fehlgeschlagen"));
        }
        Ok(Plan {
            summary,
            revision_id,
            revision,
            definition,
            content_hash,
        })
    }
    pub fn save(
        &mut self,
        id: Option<&str>,
        expected: Option<&str>,
        root: &Path,
        title: &str,
        definition: &Value,
    ) -> io::Result<Plan> {
        validation::validate(definition)?;
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 200 {
            return Err(io::Error::other("Plantitel muss 1–200 Zeichen enthalten"));
        }
        let root = root.canonicalize()?;
        if !root.is_dir() {
            return Err(io::Error::other("Projektordner fehlt"));
        }
        let root = root.to_string_lossy();
        let id = id.map(str::to_owned).unwrap_or_else(identifier);
        let content_hash = hash(definition)?;
        let revision_id = identifier();
        let tx = db(self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
        let existing:Option<(String,String,u32)>=db(tx.query_row("SELECT p.current_revision_id,w.root,r.revision FROM plans p JOIN workspaces w ON w.id=p.workspace_id JOIN plan_revisions r ON r.id=p.current_revision_id WHERE p.id=?",[&id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional())?;
        let revision = match existing {
            Some((current, workspace, number)) => {
                if Some(current.as_str()) != expected || workspace != root {
                    return Err(io::Error::other(
                        "Plan wurde geändert; vor dem Speichern neu laden",
                    ));
                }
                number + 1
            }
            None => {
                if expected.is_some() {
                    return Err(io::Error::other("Plan existiert nicht mehr"));
                }
                db(tx.execute(
                    "INSERT OR IGNORE INTO workspaces VALUES (?,?)",
                    params![identifier(), root.as_ref()],
                ))?;
                db(tx.execute("INSERT INTO plans VALUES (?,(SELECT id FROM workspaces WHERE root=?),?,NULL,'draft',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))",params![id,root.as_ref(),title]))?;
                1
            }
        };
        db(tx.execute(
            "INSERT INTO plan_revisions VALUES (?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            params![
                revision_id,
                id,
                revision,
                serde_json::to_string(definition)?,
                content_hash
            ],
        ))?;
        db(tx.execute("UPDATE plans SET title=?,current_revision_id=?,status='draft',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",params![title,revision_id,id]))?;
        event(
            &tx,
            &id,
            "revision.created",
            &json!({"revisionId":revision_id}),
        )?;
        db(tx.commit())?;
        self.get(&id)
    }
    /// Approval is bound to the current immutable revision, never to a mutable editor buffer.
    pub fn approve(&mut self, id: &str, revision_id: &str) -> io::Result<Plan> {
        let plan = self.get(id)?;
        validation::validate(&plan.definition)?;
        if plan.revision_id != revision_id || plan.summary.status == "archived" {
            return Err(io::Error::other(
                "Nur die aktuelle Revision kann freigegeben werden",
            ));
        }
        let tx = db(self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
        let current: String = db(tx.query_row(
            "SELECT current_revision_id FROM plans WHERE id=?",
            [id],
            |row| row.get(0),
        ))?;
        let questions:u32=db(tx.query_row("SELECT count(*) FROM plan_questions WHERE plan_id=? AND revision_id=? AND answered_at IS NULL",params![id,revision_id],|row|row.get(0)))?;
        if current != revision_id || questions > 0 {
            return Err(io::Error::other(
                "Plan wurde geändert oder enthält offene Rückfragen",
            ));
        }
        let scope = json!({"workspaceRoot":plan.summary.root,"allowedPaths":["."],"allowedTools":["Read","Glob","Grep"],"allowShell":false,"allowNetwork":false});
        db(tx.execute("INSERT INTO plan_approvals VALUES (?,?,?,?, 'user',strftime('%Y-%m-%dT%H:%M:%fZ','now'),?,NULL)",params![identifier(),id,revision_id,plan.content_hash,serde_json::to_string(&scope)?]))?;
        db(tx.execute("UPDATE plans SET status='approved',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",[id]))?;
        event(
            &tx,
            id,
            "revision.approved",
            &json!({"revisionId":revision_id,"contentHash":plan.content_hash,"scope":scope}),
        )?;
        db(tx.commit())?;
        self.get(id)
    }
}
fn event(tx: &rusqlite::Transaction<'_>, id: &str, kind: &str, payload: &Value) -> io::Result<()> {
    db(tx.execute("INSERT INTO plan_events VALUES (?, ?, (SELECT COALESCE(MAX(sequence),0)+1 FROM plan_events WHERE plan_id=?), ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",params![identifier(),id,id,kind,serde_json::to_string(payload)?]))?;
    Ok(())
}

pub fn planning_prompt(objective: &str) -> String {
    format!(
        "Erstelle einen umsetzbaren Plan für dieses Projekt. Nur lesen, keine Dateien ändern und keine Befehle ausführen. Antworte ausschließlich mit einem JSON-Objekt (ohne Markdown). Schema: {{\"objective\":\"...\",\"requirements\":[],\"constraints\":[],\"assumptions\":[],\"outOfScope\":[],\"phases\":[{{\"id\":\"implementation\",\"title\":\"Umsetzung\",\"order\":0}}],\"tasks\":[{{\"id\":\"task-1\",\"phaseId\":\"implementation\",\"order\":0,\"title\":\"...\",\"description\":\"...\",\"dependencies\":[],\"priority\":\"normal\",\"complexity\":\"moderate\",\"instructions\":[],\"acceptanceCriteria\":[{{\"id\":\"criterion-1\",\"description\":\"...\",\"verification\":\"manual\"}}],\"expectedFiles\":[],\"expectedArtifacts\":[],\"requiresApproval\":true,\"maxAttempts\":1}}],\"modelAssignments\":[]}}. IDs müssen eindeutig sein, Abhängigkeiten müssen existieren und azyklisch sein. Nutze relative Dateipfade. Auftrag:\n{objective}"
    )
}
pub fn parse_generated(text: &str) -> io::Result<Value> {
    let text = text.trim();
    let text = if text.starts_with("```") {
        text.split_once('\n')
            .map(|(_, rest)| rest.strip_suffix("```").unwrap_or(rest).trim())
            .unwrap_or(text)
    } else {
        text
    };
    let value: Value = serde_json::from_str(text)?;
    validation::validate(&value)?;
    Ok(value)
}
