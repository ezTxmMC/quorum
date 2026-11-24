use super::Workspace;
use std::{
    io::{self, Read},
    path::Path,
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};
#[derive(Clone, Debug)]
pub struct Change {
    pub path: String,
    pub status: String,
}
struct GitChild(std::process::Child);
impl Drop for GitChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn run(root: &Path, args: &[&str]) -> io::Result<String> {
    let root = Workspace::open(root)?.root;
    let mut child = GitChild(
        Command::new("git")
            .arg("--no-pager")
            .arg("-C")
            .arg(root)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?,
    );
    let stdout = child
        .0
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("Git stdout fehlt"))?;
    let stderr = child
        .0
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("Git stderr fehlt"))?;
    let (sender, output) = mpsc::channel();
    for (kind, reader) in [
        (true, Box::new(stdout) as Box<dyn Read + Send>),
        (false, Box::new(stderr) as Box<dyn Read + Send>),
    ] {
        let sender = sender.clone();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = reader
                .take(2 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map(|_| bytes);
            let _ = sender.send((kind, result));
        });
    }
    drop(sender);
    let deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        match child.0.try_wait()? {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                let _ = child.0.kill();
                let _ = child.0.wait();
                return Err(io::Error::other("Git-Zeitlimit überschritten"));
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    let mut text = String::new();
    let mut errors = String::new();
    for _ in 0..2 {
        let (stdout, bytes) = output
            .recv_timeout(Duration::from_secs(1))
            .map_err(io::Error::other)?;
        let bytes = bytes?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err(io::Error::other("Git-Ausgabe überschreitet 2 MiB"));
        }
        if stdout {
            text = String::from_utf8(bytes).map_err(io::Error::other)?;
        } else {
            errors = String::from_utf8_lossy(&bytes).into_owned();
        }
    }
    if !status.success() {
        return Err(io::Error::other(if errors.trim().is_empty() {
            "Git-Befehl fehlgeschlagen".into()
        } else {
            errors
        }));
    }
    Ok(text)
}
pub fn status(root: &Path) -> io::Result<Vec<Change>> {
    let text = run(
        root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--",
            ".",
        ],
    )?;
    let prefix = run(root, &["rev-parse", "--show-prefix"])?;
    let prefix = prefix.trim_end_matches(['\r', '\n']);
    let mut paths = text.split('\0');
    let mut changes = Vec::new();
    while let Some(entry) = paths.next() {
        if entry.is_empty() {
            continue;
        }
        let bytes = entry.as_bytes();
        if bytes.len() < 4 {
            return Err(io::Error::other("Ungültige Git-Statusausgabe"));
        }
        let status = String::from_utf8_lossy(&bytes[..2]).into_owned();
        let path = entry
            .get(3..)
            .ok_or_else(|| io::Error::other("Ungültiger Git-Dateiname"))?
            .to_owned();
        if status.contains(['R', 'C']) {
            paths.next();
        }
        let Some(path) = path.strip_prefix(prefix) else {
            continue;
        };
        changes.push(Change {
            path: path.to_owned(),
            status,
        });
    }
    Ok(changes)
}
pub fn diff(root: &Path, path: &str) -> io::Result<String> {
    relative(path)?;
    let changes = status(root)?;
    if changes
        .iter()
        .any(|change| change.path == path && change.status == "??")
    {
        return Workspace::open(root)?
            .read(Path::new(path))
            .map(|text| format!("Neue Datei: {path}\n\n{text}"));
    }
    let staged = run(root, &["diff", "--no-ext-diff", "--cached", "--", path])?;
    let unstaged = run(root, &["diff", "--no-ext-diff", "--", path])?;
    Ok(format!("{staged}{unstaged}"))
}
pub fn stage(root: &Path, path: &str) -> io::Result<()> {
    relative(path)?;
    run(root, &["add", "--", path]).map(|_| ())
}

fn relative(path: &str) -> io::Result<()> {
    if path.is_empty()
        || path.starts_with('-')
        || Path::new(path).is_absolute()
        || path.split(['/', '\\']).any(|part| part == "..")
        || path.contains('\0')
    {
        return Err(io::Error::other("Git-Pfad muss im Projekt liegen"));
    }
    Ok(())
}
