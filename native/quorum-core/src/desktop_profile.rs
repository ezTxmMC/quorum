//! Tauri's profile snapshot. The original Electron JSON is imported on first use.
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
use std::{
    fs::{self, File, OpenOptions},
    io,
    path::Path,
    time::Duration,
};

pub struct DesktopProfile {
    connection: Connection,
    _owner: File,
}

impl DesktopProfile {
    pub fn open(root: &Path) -> io::Result<Self> {
        fs::create_dir_all(root)?;
        let owner = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join("native-profile.lock"))?;
        owner.try_lock().map_err(io::Error::other)?;
        let connection = Connection::open(root.join("quorum.sqlite")).map_err(io::Error::other)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(io::Error::other)?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS desktop_profile (
                id INTEGER PRIMARY KEY CHECK(id = 1), document TEXT NOT NULL
            );",
            )
            .map_err(io::Error::other)?;
        Ok(Self {
            connection,
            _owner: owner,
        })
    }

    pub fn load(&self) -> io::Result<Option<Value>> {
        let saved: Option<String> = self
            .connection
            .query_row(
                "SELECT document FROM desktop_profile WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(io::Error::other)?;
        saved
            .map(|text| serde_json::from_str(&text).map_err(io::Error::other))
            .transpose()
    }

    pub fn save(&self, value: &Value) -> io::Result<()> {
        if value["version"] != 1 || !value["sessions"].is_array() || !value["settings"].is_object()
        {
            return Err(io::Error::other("Ungültiges Quorum-Profil"));
        }
        self.connection
            .execute(
                "INSERT INTO desktop_profile(id, document) VALUES (1, ?)
            ON CONFLICT(id) DO UPDATE SET document = excluded.document",
                [serde_json::to_string(value)?],
            )
            .map_err(io::Error::other)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn snapshot_survives_reopen_and_invalid_save() {
        let root = std::env::temp_dir().join(format!("quorum-db-test-{}", std::process::id()));
        let db = DesktopProfile::open(&root).unwrap();
        assert!(DesktopProfile::open(&root).is_err());
        assert!(db.load().unwrap().is_none());
        let value = json!({"version":1,"settings":{},"sessions":[],"future":42});
        db.save(&value).unwrap();
        assert!(db.save(&Value::Null).is_err());
        drop(db);
        assert_eq!(
            DesktopProfile::open(&root).unwrap().load().unwrap(),
            Some(value)
        );
        fs::remove_dir_all(root).unwrap();
    }
}
