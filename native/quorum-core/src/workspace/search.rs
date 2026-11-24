use super::Workspace;
use std::{
    collections::{HashSet, VecDeque},
    io,
    path::Path,
};
#[derive(Clone, Debug)]
pub struct Match {
    pub path: String,
    pub line: usize,
    pub excerpt: String,
}
pub fn search(root: &Path, query: &str) -> io::Result<Vec<Match>> {
    if query.trim().is_empty() || query.len() > 1000 {
        return Err(io::Error::other("Suchbegriff muss 1–1000 Bytes enthalten"));
    }
    let workspace = Workspace::open(root)?;
    let mut queue = VecDeque::from([String::new()]);
    let mut results = Vec::new();
    let mut files = 0;
    let mut bytes = 0;
    let mut visited = HashSet::new();
    while let Some(directory) = queue.pop_front() {
        let canonical = workspace.resolve(Path::new(&directory))?;
        if !visited.insert(canonical) {
            continue;
        }
        if visited.len() > 5000 {
            return Ok(results);
        }
        for entry in workspace.list(Path::new(&directory))? {
            if entry.is_directory {
                if ![
                    ".git",
                    "node_modules",
                    "target",
                    "dist",
                    "dist-electron",
                    ".ai-hub",
                ]
                .contains(&entry.name.as_str())
                {
                    queue.push_back(entry.path);
                }
                continue;
            }
            files += 1;
            if files > 20_000 || bytes > 32 * 1024 * 1024 {
                return Ok(results);
            }
            let path = workspace.resolve(Path::new(&entry.path))?;
            bytes += std::fs::metadata(path)?.len().min(2 * 1024 * 1024 + 1) as usize;
            if bytes > 32 * 1024 * 1024 {
                return Ok(results);
            }
            let Ok(text) = workspace.read(Path::new(&entry.path)) else {
                continue;
            };
            for (index, line) in text.lines().enumerate() {
                if !line.contains(query) {
                    continue;
                }
                results.push(Match {
                    path: entry.path.clone(),
                    line: index + 1,
                    excerpt: line.trim().chars().take(220).collect(),
                });
                if results.len() >= 200 {
                    return Ok(results);
                }
            }
        }
    }
    Ok(results)
}
