//! Installs the downloaded AppImage: wait for the running app to exit, swap the file, wait for the desktop integration.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

const EXIT_TIMEOUT: Duration = Duration::from_secs(90);
const INTEGRATION_TIMEOUT: Duration = Duration::from_secs(30);
const POLL: Duration = Duration::from_millis(100);
/// The kernel truncates process names to 15 characters, so this is all that is left of `appimagelauncherd`.
const INTEGRATION_DAEMON: &str = "appimagelaunche";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Phase {
    WaitingForExit,
    Installing,
    Integrating,
    Done,
    /// The app never exited (for example the user cancelled its quit dialog): nothing was changed.
    Cancelled,
    Failed(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Language {
    German,
    English,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Job {
    pub source: PathBuf,
    pub target: PathBuf,
    pub pid: u32,
    pub link: Option<PathBuf>,
    pub language: Language,
    /// Switches the app is restarted with, everything after `--`.
    pub relaunch: Vec<OsString>,
}

impl Job {
    pub fn parse(arguments: impl IntoIterator<Item = OsString>) -> Result<Self, String> {
        let mut source = None;
        let mut target = None;
        let mut pid = None;
        let mut link = None;
        let mut language = Language::English;
        let mut arguments = arguments.into_iter();
        while let Some(argument) = arguments.next() {
            let name = argument.to_string_lossy().into_owned();
            if name == "--" {
                break;
            }
            let value = arguments
                .next()
                .ok_or_else(|| format!("missing value for {name}"))?;
            match name.as_str() {
                "--source" => source = Some(PathBuf::from(value)),
                "--target" => target = Some(PathBuf::from(value)),
                "--link" => link = Some(PathBuf::from(value)),
                "--pid" => {
                    pid = Some(
                        value
                            .to_string_lossy()
                            .parse::<u32>()
                            .map_err(|_| "invalid --pid".to_string())?,
                    );
                }
                "--lang" => {
                    if value == "de" {
                        language = Language::German;
                    }
                }
                _ => return Err(format!("unknown argument {name}")),
            }
        }
        Ok(Self {
            source: source.ok_or("missing --source")?,
            target: target.ok_or("missing --target")?,
            pid: pid.ok_or("missing --pid")?,
            link,
            language,
            relaunch: arguments.collect(),
        })
    }
}

/// Runs the whole update and reports each phase. Returns the final phase.
pub fn run(job: &Job, report: impl Fn(Phase)) -> Phase {
    report(Phase::WaitingForExit);
    if !wait_for_exit(job.pid, EXIT_TIMEOUT) {
        report(Phase::Cancelled);
        return Phase::Cancelled;
    }
    report(Phase::Installing);
    let started = SystemTime::now();
    if let Err(error) = swap(&job.source, &job.target) {
        let failed = Phase::Failed(error.to_string());
        report(failed.clone());
        return failed;
    }
    if let Some(link) = &job.link {
        relink(link, &job.target);
    }
    report(Phase::Integrating);
    if let Some(directory) = starters_directory() {
        wait_for_integration(&directory, &job.target, started, INTEGRATION_TIMEOUT);
    }
    let _ = fs::remove_file(&job.source);
    report(Phase::Done);
    Phase::Done
}

fn wait_for_exit(pid: u32, timeout: Duration) -> bool {
    let process = PathBuf::from(format!("/proc/{pid}"));
    let deadline = Instant::now() + timeout;
    while process.exists() {
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(POLL);
    }
    true
}

/// Copies next to the target and renames, so the target is never a half-written file.
pub fn swap(source: &Path, target: &Path) -> io::Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut staged = target.as_os_str().to_owned();
    staged.push(".new");
    let staged = PathBuf::from(staged);
    let result = fs::copy(source, &staged)
        .and_then(|_| fs::set_permissions(&staged, fs::Permissions::from_mode(0o755)))
        .and_then(|()| fs::rename(&staged, target));
    if result.is_err() {
        let _ = fs::remove_file(&staged);
    }
    result
}

/// The command-line shortcut is a convenience: failing to refresh it must not fail the update.
fn relink(link: &Path, target: &Path) {
    if let Some(parent) = link.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::remove_file(link);
    let _ = std::os::unix::fs::symlink(target, link);
}

fn starters_directory() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".local/share/applications"))
}

/// Starters that AppImageLauncher wrote for this AppImage.
pub fn integration_starters(directory: &Path, target: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let needle = target.to_string_lossy();
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned());
            name.is_some_and(|name| name.starts_with("appimagekit_") && name.ends_with(".desktop"))
        })
        .filter(|path| fs::read_to_string(path).is_ok_and(|text| text.contains(needle.as_ref())))
        .collect()
}

fn integration_daemon_runs() -> bool {
    let Ok(entries) = fs::read_dir("/proc") else {
        return false;
    };
    entries.filter_map(Result::ok).any(|entry| {
        fs::read_to_string(entry.path().join("comm"))
            .is_ok_and(|name| name.trim() == INTEGRATION_DAEMON)
    })
}

/// AppImageLauncher rewrites its starter a few seconds after the swap. Restarting before that runs into the change.
fn wait_for_integration(directory: &Path, target: &Path, since: SystemTime, timeout: Duration) {
    let starters = integration_starters(directory, target);
    if starters.is_empty() || !integration_daemon_runs() {
        return;
    }
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if starters.iter().any(|starter| rewritten(starter, since)) {
            return;
        }
        thread::sleep(POLL * 4);
    }
}

fn rewritten(starter: &Path, since: SystemTime) -> bool {
    fs::metadata(starter)
        .and_then(|metadata| metadata.modified())
        .is_ok_and(|modified| modified >= since)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("quorum-updater-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn arguments(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_all_arguments() {
        let job = Job::parse(arguments(&[
            "--source",
            "/tmp/new",
            "--target",
            "/apps/q",
            "--pid",
            "42",
            "--link",
            "/bin/q",
            "--lang",
            "de",
            "--",
            "--no-sandbox",
        ]))
        .unwrap();
        assert_eq!(job.source, PathBuf::from("/tmp/new"));
        assert_eq!(job.target, PathBuf::from("/apps/q"));
        assert_eq!(job.pid, 42);
        assert_eq!(job.link, Some(PathBuf::from("/bin/q")));
        assert_eq!(job.language, Language::German);
        assert_eq!(job.relaunch, arguments(&["--no-sandbox"]));
    }

    #[test]
    fn rejects_incomplete_arguments() {
        assert!(Job::parse(arguments(&["--source", "/tmp/new", "--pid", "1"])).is_err());
        assert!(Job::parse(arguments(&["--source"])).is_err());
        assert!(Job::parse(arguments(&["--bogus", "x"])).is_err());
    }

    #[test]
    fn swap_replaces_the_target_and_makes_it_executable() {
        let directory = scratch("swap");
        let source = directory.join("download");
        let target = directory.join("apps/Quorum.AppImage");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&source, b"new").unwrap();
        fs::write(&target, b"old").unwrap();
        swap(&source, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o755
        );
        assert!(!directory.join("apps/Quorum.AppImage.new").exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_swap_keeps_the_old_target() {
        let directory = scratch("failed-swap");
        let target = directory.join("Quorum.AppImage");
        fs::write(&target, b"old").unwrap();
        assert!(swap(&directory.join("missing"), &target).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"old");
        assert!(!directory.join("Quorum.AppImage.new").exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn finds_only_starters_of_this_app_image() {
        let directory = scratch("starters");
        let target = Path::new("/home/user/Applications/Quorum.AppImage");
        fs::write(
            directory.join("appimagekit_1-Quorum.desktop"),
            format!("Exec={} %U", target.display()),
        )
        .unwrap();
        fs::write(
            directory.join("appimagekit_2-Other.desktop"),
            "Exec=/other.AppImage",
        )
        .unwrap();
        fs::write(
            directory.join("quorum.desktop"),
            format!("Exec={}", target.display()),
        )
        .unwrap();
        let starters = integration_starters(&directory, target);
        assert_eq!(
            starters,
            vec![directory.join("appimagekit_1-Quorum.desktop")]
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_vanished_process_counts_as_exited() {
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(wait_for_exit(pid, Duration::from_secs(2)));
        assert!(!wait_for_exit(
            std::process::id(),
            Duration::from_millis(250)
        ));
    }
}
