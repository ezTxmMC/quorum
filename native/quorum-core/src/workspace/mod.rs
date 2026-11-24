use serde::Serialize;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
}

pub struct Workspace {
    root: PathBuf,
}

impl Workspace {
    pub fn open(root: &Path) -> io::Result<Self> {
        let root = root.canonicalize()?;
        if !root.is_dir() {
            return Err(io::Error::other("Workspace is not a directory"));
        }
        Ok(Self { root })
    }

    fn resolve(&self, relative: &Path) -> io::Result<PathBuf> {
        if relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
        {
            return Err(io::Error::other("Path must be relative to the workspace"));
        }
        let path = self.root.join(relative).canonicalize()?;
        if !path.starts_with(&self.root) {
            return Err(io::Error::other("Path escapes workspace through a symlink"));
        }
        Ok(path)
    }

    pub fn list(&self, relative: &Path) -> io::Result<Vec<Entry>> {
        let directory = self.resolve(relative)?;
        let mut entries = Vec::new();
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            let Ok(resolved) = path.canonicalize() else {
                continue;
            };
            if !resolved.starts_with(&self.root) {
                continue;
            }
            let kind = fs::metadata(&resolved)?;
            if !kind.is_dir() && !kind.is_file() {
                continue;
            }
            entries.push(Entry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: path
                    .strip_prefix(&self.root)
                    .map_err(io::Error::other)?
                    .to_string_lossy()
                    .replace('\\', "/"),
                is_directory: kind.is_dir(),
            });
        }
        entries.sort_by(|left, right| {
            right
                .is_directory
                .cmp(&left.is_directory)
                .then_with(|| left.name.cmp(&right.name))
        });
        Ok(entries)
    }

    pub fn read(&self, relative: &Path) -> io::Result<String> {
        let path = self.resolve(relative)?;
        let file = File::open(path)?;
        if !file.metadata()?.is_file() {
            return Err(io::Error::other("Not a regular file"));
        }
        let mut bytes = Vec::new();
        file.take(MAX_TEXT_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_TEXT_BYTES {
            return Err(io::Error::other("File exceeds 2 MiB editor limit"));
        }
        if bytes.contains(&0) {
            return Err(io::Error::other("Binary files cannot be edited as text"));
        }
        String::from_utf8(bytes).map_err(io::Error::other)
    }

    pub fn create(&self, relative: &Path, text: &str) -> io::Result<()> {
        if text.len() as u64 > MAX_TEXT_BYTES {
            return Err(io::Error::other("File exceeds 2 MiB editor limit"));
        }
        let path = self.new_path(relative)?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()
    }
    pub fn create_directory(&self, relative: &Path) -> io::Result<()> {
        fs::create_dir(self.new_path(relative)?)
    }
    fn new_path(&self, relative: &Path) -> io::Result<PathBuf> {
        if relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
        {
            return Err(io::Error::other("Path must be relative to the workspace"));
        }
        let name = relative
            .file_name()
            .ok_or_else(|| io::Error::other("Dateiname fehlt"))?;
        let parent = self.resolve(relative.parent().unwrap_or_else(|| Path::new("")))?;
        Ok(parent.join(name))
    }

    /// Existing-file save with optimistic concurrency; refuses stale buffers and symlink escapes.
    pub fn save(&self, relative: &Path, expected: &str, text: &str) -> io::Result<()> {
        if text.len() as u64 > MAX_TEXT_BYTES {
            return Err(io::Error::other("File exceeds 2 MiB editor limit"));
        }
        let path = self.resolve(relative)?;
        if self.read(relative)? != expected {
            return Err(io::Error::other(
                "File changed on disk; reload or merge before saving",
            ));
        }
        let temporary = path.with_file_name(format!(".quorum-save-{}", std::process::id()));
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let result = (|| {
            output.set_permissions(fs::metadata(&path)?.permissions())?;
            output.write_all(text.as_bytes())?;
            output.sync_all()?;
            if self.read(relative)? != expected {
                return Err(io::Error::other("File changed during save"));
            }
            fs::rename(&temporary, &path)
        })();
        drop(output);
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

pub mod buffer;

pub mod attachments;

pub mod git;
pub mod search;

pub mod syntax;

pub mod lsp;
