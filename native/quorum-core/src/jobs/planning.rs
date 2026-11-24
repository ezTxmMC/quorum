use super::*;
use crate::plan::{PlanStore, parse_generated, planning_prompt};

impl Runtime {
    pub fn start_team(
        &mut self,
        root: &Path,
        objective: &str,
        claude_model: &str,
        codex_model: &str,
        host: &Path,
        worker: &Path,
    ) -> io::Result<()> {
        if objective.trim().is_empty() || objective.len() > 100_000 {
            return Err(io::Error::other("Ungültige Team-Aufgabe"));
        }
        let group = identifier();
        for (provider, model, role) in [
            ("claude", claude_model, "Architektur und Umsetzung"),
            ("codex", codex_model, "Risiken und Tests"),
        ] {
            let id = self.create_chat(provider, root, model)?;
            self.set_access(&id, true)?;
            if let Some(session) = self.profile.data["sessions"]
                .as_array_mut()
                .and_then(|sessions| sessions.iter_mut().find(|session| session["id"] == id))
            {
                session["nativeGroup"] = json!({"id":group,"role":role,"objective":objective});
            }
            self.flush()?;
            self.send(&id,&format!("Du bist Teil eines parallelen Analyse-Teams. Deine Rolle: {role}. Nur lesend untersuchen, keine Dateien ändern. Liefere konkrete Befunde mit Dateiverweisen und prüfbaren Empfehlungen. Auftrag:\n{objective}"),host,worker)?;
            self.rename_chat(
                &id,
                &format!(
                    "{role}: {}",
                    objective.chars().take(100).collect::<String>()
                ),
            )?;
        }
        Ok(())
    }
    pub fn plan_generation(&self, id: &str) -> io::Result<Value> {
        self.sessions()
            .iter()
            .find(|session| session["id"] == id)
            .map(|session| session["nativePlan"].clone())
            .ok_or_else(|| io::Error::other("Plan-Chat wurde entfernt"))
    }

    pub fn start_plan(
        &mut self,
        root: &Path,
        provider: &str,
        model: &str,
        objective: &str,
        host: &Path,
        worker: &Path,
    ) -> io::Result<String> {
        if objective.trim().is_empty() || objective.len() > 100_000 {
            return Err(io::Error::other(
                "Beschreibe ein Ziel für den Plan (maximal 100 KB)",
            ));
        }
        let id = self.create_chat(provider, root, model)?;
        let session = self.profile.data["sessions"]
            .as_array_mut()
            .and_then(|sessions| sessions.iter_mut().find(|session| session["id"] == id))
            .ok_or_else(|| io::Error::other("Plan-Chat fehlt"))?;
        session["options"] = json!({"model":model,"chatMode":"coding","permission":"plan","sandbox":"read-only","fullAccess":false});
        session["nativePlan"] =
            json!({"planId":format!("plan-{id}"),"objective":objective,"finished":false});
        self.flush()?;
        self.send(&id, &planning_prompt(objective), host, worker)?;
        if let Some(session) = self.profile.data["sessions"]
            .as_array_mut()
            .and_then(|sessions| sessions.iter_mut().find(|session| session["id"] == id))
        {
            session["title"] = json!(format!(
                "Plan: {}",
                objective.chars().take(54).collect::<String>()
            ));
        }
        self.flush()?;
        Ok(id)
    }
    pub(super) fn finish_plans(&mut self) -> io::Result<bool> {
        let pending: Vec<_> = self
            .sessions()
            .iter()
            .enumerate()
            .filter_map(|(index, session)| {
                if !session["nativePlan"].is_object() || session["nativePlan"]["finished"] == true {
                    return None;
                }
                let message = session["messages"].as_array()?.last()?;
                if message["workerDone"] != true {
                    return None;
                }
                Some((
                    index,
                    session["cwd"].as_str()?.to_owned(),
                    session["nativePlan"].clone(),
                    message.clone(),
                ))
            })
            .collect();
        if pending.is_empty() {
            return Ok(false);
        }
        let mut store = PlanStore::open(&self.root.join("plans.sqlite"))?;
        for (index, root, metadata, message) in pending {
            let result = (|| {
                let plan_id = metadata["planId"]
                    .as_str()
                    .ok_or_else(|| io::Error::other("Plan-ID fehlt"))?;
                if let Ok(plan) = store.get(plan_id) {
                    return Ok(plan.summary.id);
                }
                if let Some(error) = message["error"].as_str() {
                    return Err(io::Error::other(error));
                }
                let text = message["blocks"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|block| block["kind"] == "text")
                    .filter_map(|block| block["text"].as_str())
                    .collect::<String>();
                let definition = parse_generated(&text)?;
                let title = metadata["objective"]
                    .as_str()
                    .unwrap_or("KI-Plan")
                    .chars()
                    .take(200)
                    .collect::<String>();
                let plan =
                    store.save(Some(plan_id), None, Path::new(&root), &title, &definition)?;
                Ok::<_, io::Error>(plan.summary.id)
            })();
            let metadata = &mut self.profile.data["sessions"][index]["nativePlan"];
            metadata["finished"] = json!(true);
            match result {
                Ok(id) => metadata["result"] = json!(id),
                Err(error) => metadata["error"] = json!(error.to_string()),
            }
        }
        self.dirty = true;
        self.revision += 1;
        Ok(true)
    }
}
