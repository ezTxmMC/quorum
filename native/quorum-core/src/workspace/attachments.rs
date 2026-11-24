use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatFile {
    pub name: String,
    #[serde(default)]
    pub path: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
}
impl ChatFile {
    pub fn is_image(&self) -> bool {
        self.mime
            .as_ref()
            .is_some_and(|mime| mime.starts_with("image/"))
    }
}
pub fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}
pub fn stage(data: &Path, path: &Path) -> io::Result<ChatFile> {
    let file = fs::File::open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("Anhänge müssen reguläre Dateien sein"));
    }
    let mut bytes = Vec::new();
    file.take(10 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err(io::Error::other("Anhang ist größer als 10 MiB"));
    }
    stage_bytes(data, path, bytes)
}

pub fn stage_inline(data: &Path, name: &str, mime: &str, encoded: &str) -> io::Result<ChatFile> {
    use base64::Engine;
    if encoded.len() > 14 * 1024 * 1024 {
        return Err(io::Error::other("Bildanhang zu groß"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(io::Error::other)?;
    if image_mime(&bytes) != Some(mime) {
        return Err(io::Error::other(
            "Bildformat stimmt nicht mit dem gespeicherten Typ überein",
        ));
    }
    stage_bytes(data, Path::new(name), bytes)
}

fn stage_bytes(data: &Path, path: &Path, bytes: Vec<u8>) -> io::Result<ChatFile> {
    if bytes.len() > 10 * 1024 * 1024 {
        return Err(io::Error::other("Bildanhang zu groß"));
    }
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::other("Dateiname fehlt"))?
        .to_string_lossy()
        .into_owned();
    if let Some(mime) = image_mime(&bytes) {
        let directory = data.join("attachments");
        fs::create_dir_all(&directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        }
        let suffix = match mime {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/gif" => "gif",
            _ => "webp",
        };
        let target = directory.join(format!("{}.{}", crate::jobs::identifier(), suffix));
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            output.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        output.write_all(&bytes)?;
        output.sync_all()?;
        return Ok(ChatFile {
            name,
            path: target,
            text: None,
            mime: Some(mime.into()),
        });
    }
    if bytes.len() > 2 * 1024 * 1024 || bytes.contains(&0) {
        return Err(io::Error::other(
            "Textanhänge dürfen maximal 2 MiB groß sein; unterstützte Bilder: PNG, JPEG, GIF, WebP",
        ));
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| io::Error::other("Datei ist kein UTF-8-Text und kein unterstütztes Bild"))?;
    Ok(ChatFile {
        name,
        path: path.to_owned(),
        text: Some(text),
        mime: None,
    })
}
