use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    io,
    path::Path,
};

fn error(message: &str) -> io::Error {
    io::Error::other(message)
}
fn text(value: &Value) -> io::Result<&str> {
    value
        .as_str()
        .filter(|text| !text.trim().is_empty() && text.len() <= 100_000)
        .ok_or_else(|| error("Leerer oder zu langer Plantext"))
}
fn array(value: &Value, maximum: usize) -> io::Result<&Vec<Value>> {
    value
        .as_array()
        .filter(|values| values.len() <= maximum)
        .ok_or_else(|| error("Ungültige Planliste"))
}
fn strings(value: &Value) -> io::Result<Vec<&str>> {
    array(value, 1000)?.iter().map(text).collect()
}
pub fn relative(path: &str) -> io::Result<()> {
    if path.is_empty()
        || path.contains('\0')
        || path.starts_with(['/', '\\'])
        || path.as_bytes().get(1) == Some(&b':')
        || path.split(['/', '\\']).any(|part| part == "..")
        || Path::new(path).is_absolute()
    {
        return Err(error("Planpfade müssen im Projekt bleiben"));
    }
    Ok(())
}
pub fn validate(definition: &Value) -> io::Result<()> {
    if serde_json::to_vec(definition)?.len() > 2_000_000 {
        return Err(error("Plan ist größer als 2 MB"));
    }
    text(&definition["objective"])?;
    for field in ["requirements", "constraints", "assumptions", "outOfScope"] {
        strings(&definition[field])?;
    }
    let mut phases = HashSet::new();
    let phase_values = array(&definition["phases"], 500)?;
    if phase_values.is_empty() {
        return Err(error("Plan benötigt mindestens eine Phase"));
    }
    for phase in phase_values {
        if !phases.insert(text(&phase["id"])?) || phase["order"].as_i64().is_none() {
            return Err(error("Doppelte Phase oder ungültige Reihenfolge"));
        }
        text(&phase["title"])?;
    }
    let mut assignments = HashSet::new();
    for assignment in array(&definition["modelAssignments"], 500)? {
        if !assignments.insert(text(&assignment["id"])?) {
            return Err(error("Doppelte Modellzuweisung"));
        }
        for key in ["role", "providerId", "modelId"] {
            text(&assignment[key])?;
        }
        strings(&assignment["fallbackModelIds"])?;
    }
    let mut graph = HashMap::new();
    let tasks = array(&definition["tasks"], 500)?;
    if tasks.is_empty() {
        return Err(error("Plan benötigt mindestens eine Aufgabe"));
    }
    for task in tasks {
        let id = text(&task["id"])?;
        if graph.contains_key(id)
            || !phases.contains(text(&task["phaseId"])?)
            || task["order"].as_i64().is_none()
        {
            return Err(error("Doppelte Aufgabe oder ungültige Phase"));
        }
        for key in ["title", "description"] {
            text(&task[key])?;
        }
        for key in ["instructions", "expectedArtifacts"] {
            strings(&task[key])?;
        }
        for path in strings(&task["expectedFiles"])? {
            relative(path)?;
        }
        if !matches!(
            task["priority"].as_str(),
            Some("low" | "normal" | "high" | "critical")
        ) || !matches!(
            task["complexity"].as_str(),
            Some("simple" | "moderate" | "complex")
        ) || task["requiresApproval"].as_bool().is_none()
            || !task["maxAttempts"]
                .as_u64()
                .is_some_and(|number| (1..=10).contains(&number))
        {
            return Err(error("Ungültige Aufgabenoptionen"));
        }
        if let Some(assignment) = task.get("modelAssignmentId")
            && !assignments.contains(text(assignment)?)
        {
            return Err(error("Unbekannte Modellzuweisung"));
        }
        if let Some(role) = task.get("assignedRole") {
            text(role)?;
        }
        let criteria = array(&task["acceptanceCriteria"], 100)?;
        if criteria.is_empty() {
            return Err(error("Aufgaben benötigen Abnahmekriterien"));
        }
        let mut seen = HashSet::new();
        for criterion in criteria {
            if !seen.insert(text(&criterion["id"])?) {
                return Err(error("Doppeltes Abnahmekriterium"));
            }
            text(&criterion["description"])?;
            if !matches!(
                criterion["verification"].as_str(),
                Some("manual" | "test" | "command" | "model_review")
            ) {
                return Err(error("Ungültige Prüfung"));
            }
            if criterion["verification"] == "command" || criterion.get("command").is_some() {
                text(&criterion["command"])?;
            }
        }
        let dependencies = strings(&task["dependencies"])?;
        if dependencies.iter().collect::<HashSet<_>>().len() != dependencies.len() {
            return Err(error("Doppelte Abhängigkeit"));
        }
        graph.insert(id, dependencies);
    }
    fn visit<'a>(
        id: &'a str,
        graph: &HashMap<&'a str, Vec<&'a str>>,
        visiting: &mut HashSet<&'a str>,
        done: &mut HashSet<&'a str>,
    ) -> io::Result<()> {
        if done.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id) {
            return Err(error("Zyklische Aufgabenabhängigkeiten"));
        }
        let dependencies = graph
            .get(id)
            .ok_or_else(|| error("Unbekannte Aufgabenabhängigkeit"))?;
        for dependency in dependencies {
            visit(dependency, graph, visiting, done)?;
        }
        visiting.remove(id);
        done.insert(id);
        Ok(())
    }
    let mut done = HashSet::new();
    for id in graph.keys() {
        visit(id, &graph, &mut HashSet::new(), &mut done)?;
    }
    Ok(())
}
