use serde_json::Value;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

const MAX_PROFILE: u64 = 256 * 1024 * 1024;

/// Preserves all Electron fields, including unknown future settings and attachments.
/// The native process must have exclusive profile ownership before writing.
pub struct Profile {
    path: PathBuf,
    _ownership: File,
    saved: Vec<u8>,
    pub data: Value,
}

impl Profile {
    pub fn open(directory: &Path) -> io::Result<Self> {
        fs::create_dir_all(directory)?;
        let lock = directory.join("native-profile.lock");
        let ownership = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock)?;
        ownership.try_lock().map_err(io::Error::other)?;
        let path = directory.join("hub.json");
        let saved = read_profile(&path)?;
        let data: Value = serde_json::from_slice(&saved)?;
        if data.get("version").and_then(Value::as_u64) != Some(1)
            || !data.get("sessions").is_some_and(Value::is_array)
        {
            return Err(io::Error::other("Unsupported Quorum profile schema"));
        }
        Ok(Self {
            path,
            _ownership: ownership,
            saved,
            data,
        })
    }

    pub fn save(&mut self) -> io::Result<()> {
        if self.data.get("version").and_then(Value::as_u64) != Some(1)
            || !self.data.get("sessions").is_some_and(Value::is_array)
        {
            return Err(io::Error::other("Unsupported Quorum profile schema"));
        }
        if read_profile(&self.path)? != self.saved {
            return Err(io::Error::other(
                "Profile changed externally; native save refused",
            ));
        }
        let bytes = serde_json::to_vec(&self.data)?;
        if bytes.len() as u64 > MAX_PROFILE {
            return Err(io::Error::other("Profile exceeds 256 MiB limit"));
        }
        let temporary = self.path.with_extension("native.tmp");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let result = (|| {
            file.set_permissions(fs::metadata(&self.path)?.permissions())?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            if read_profile(&self.path)? != self.saved {
                return Err(io::Error::other("Profile changed during save"));
            }
            fs::rename(&temporary, &self.path)
        })();
        drop(file);
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result?;
        self.saved = bytes;
        Ok(())
    }
}

impl Drop for Profile {
    fn drop(&mut self) {
        // Other threads may fork a child which briefly inherits this descriptor before exec.
        // Release ownership explicitly rather than waiting for every inherited fd to close.
        let _ = self._ownership.unlock();
    }
}

fn read_profile(path: &Path) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(MAX_PROFILE + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_PROFILE {
        return Err(io::Error::other("Profile exceeds 256 MiB limit"));
    }
    Ok(bytes)
}
