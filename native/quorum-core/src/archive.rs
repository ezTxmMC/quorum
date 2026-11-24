use serde::Deserialize;
use std::fs::File;
use std::io::{self, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
const ROW_CHARACTERS: usize = 140;

#[derive(Debug, Default, Deserialize)]
pub struct Archive {
    #[serde(default)]
    pub sessions: Vec<Session>,
}

#[derive(Debug, Deserialize)]
pub struct Session {
    pub id: String,
    pub title: String,
    #[serde(default, rename = "updatedAt")]
    pub updated_at: u64,
    #[serde(default)]
    pub cwd: String,
    pub provider: String,
    #[serde(default)]
    pub options: serde_json::Value,
    #[serde(default, rename = "nativePlan")]
    pub native_plan: serde_json::Value,
    #[serde(default, rename = "nativeGroup")]
    pub native_group: serde_json::Value,
    #[serde(default)]
    pub messages: Vec<Message>,
}

#[derive(Debug, Deserialize)]
pub struct Message {
    pub role: String,
    #[serde(default)]
    pub images: Vec<String>,
    #[serde(default)]
    pub files: Vec<crate::workspace::attachments::ChatFile>,
    #[serde(default)]
    pub attachments: Vec<InlineImage>,
    #[serde(default)]
    pub blocks: Vec<Block>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct InlineImage {
    pub name: String,
    pub mime: String,
    pub data: String,
}

#[derive(Debug, Deserialize)]
pub struct Block {
    pub kind: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub input: serde_json::Value,
}

/// Explicitly read-only until migrations and native writes preserve every legacy field.
pub fn load(path: &Path) -> io::Result<Archive> {
    let file = File::open(path)?;
    if file.metadata()?.len() > MAX_ARCHIVE_BYTES {
        return Err(io::Error::other(
            "hub.json exceeds the 256 MiB import limit",
        ));
    }
    serde_json::from_reader(BufReader::new(file)).map_err(io::Error::other)
}

pub fn data_directory() -> io::Result<PathBuf> {
    if let Some(directory) = std::env::var_os("QUORUM_DATA_DIR") {
        return Ok(PathBuf::from(directory));
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    let home =
        home.ok_or_else(|| io::Error::other("Home directory unavailable; set QUORUM_DATA_DIR"))?;
    if cfg!(target_os = "macos") {
        return Ok(PathBuf::from(home).join("Library/Application Support/ai-hub"));
    }
    if cfg!(target_os = "windows") {
        return Ok(std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(&home).join("AppData/Roaming"))
            .join("ai-hub"));
    }
    Ok(std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(home).join(".config"))
        .join("ai-hub"))
}

/// Rows are prepared off-thread once per selection; the GPU list only requests visible rows.
pub fn transcript(session: &Session) -> Vec<Arc<str>> {
    let mut rows = Vec::new();
    for message in &session.messages {
        rows.push(Arc::from(format!("── {} ──", message.role)));
        for block in &message.blocks {
            if let Some(text) = &block.text {
                wrap_rows(text, &mut rows);
                continue;
            }
            if let Some(name) = &block.name {
                rows.push(Arc::from(format!("[{}] {name}", block.kind)));
            }
        }
        if let Some(error) = &message.error {
            wrap_rows(&format!("Fehler: {error}"), &mut rows);
        }
        rows.push(Arc::from(""));
    }
    rows
}

fn wrap_rows(text: &str, rows: &mut Vec<Arc<str>>) {
    for line in text.split('\n') {
        let mut start = 0;
        for (count, (offset, _)) in line.char_indices().enumerate() {
            if count > 0 && count % ROW_CHARACTERS == 0 {
                rows.push(Arc::from(&line[start..offset]));
                start = offset;
            }
        }
        rows.push(Arc::from(&line[start..]));
    }
}
