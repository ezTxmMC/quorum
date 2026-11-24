//! Starts the updated app the way the desktop would: outside the old instance's control group and without its environment.

use std::ffi::OsString;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::Duration;

/// Set by the AppImage runtime, AppImageLauncher, Electron and the desktop launcher for the instance that just exited.
/// Inherited by the new instance they point at a mount that is going away; AppImageLauncher then fails to start it.
const STALE_VARIABLES: [&str; 16] = [
    "APPDIR",
    "APPIMAGE",
    "ARGV0",
    "OWD",
    "TARGET_APPIMAGE",
    "REDIRECT_APPIMAGE",
    "CHROME_DESKTOP",
    "ELECTRON_RUN_AS_NODE",
    "GIO_LAUNCHED_DESKTOP_FILE",
    "GIO_LAUNCHED_DESKTOP_FILE_PID",
    "INVOCATION_ID",
    "JOURNAL_STREAM",
    "MEMORY_PRESSURE_WATCH",
    "MEMORY_PRESSURE_WRITE",
    "SYSTEMD_EXEC_PID",
    "QUORUM_DETACHED",
];
const MOUNT_PREFIX: &[u8] = b"/tmp/.mount_";

/// Drops everything that refers to the old instance. Path lists keep their other entries.
pub fn clean_environment(
    variables: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    let variables: Vec<(OsString, OsString)> = variables.into_iter().collect();
    let mount = variables
        .iter()
        .find(|(name, _)| name == "APPDIR")
        .map(|(_, value)| value.as_bytes().to_vec())
        .filter(|value| !value.is_empty());
    let stale = |entry: &[u8]| {
        entry.starts_with(MOUNT_PREFIX)
            || mount.as_ref().is_some_and(|mount| entry.starts_with(mount))
    };
    variables
        .into_iter()
        .filter(|(name, _)| !STALE_VARIABLES.iter().any(|stale| name == stale))
        .filter_map(|(name, value)| {
            let kept: Vec<&[u8]> = value
                .as_bytes()
                .split(|byte| *byte == b':')
                .filter(|entry| !stale(entry))
                .collect();
            if kept.is_empty() && !value.is_empty() {
                return None;
            }
            Some((name, OsString::from_vec(kept.join(&b':'))))
        })
        .collect()
}

/// Starts the app detached. Returns false when it could not be started at all.
pub fn start(target: &Path, arguments: &[OsString]) -> bool {
    let environment = clean_environment(std::env::vars_os());
    // A process started from here would stay in the control group of the instance that just exited.
    // A scope of its own is what the desktop gives every app it launches.
    let mut scoped = Command::new("systemd-run");
    scoped
        .args(["--user", "--scope", "--quiet", "--collect", "--"])
        .arg(target)
        .args(arguments);
    if let Some(mut child) = spawn(scoped, &environment) {
        thread::sleep(Duration::from_millis(600));
        if !matches!(child.try_wait(), Ok(Some(status)) if !status.success()) {
            return true;
        }
    }
    let mut direct = Command::new(target);
    direct.args(arguments);
    spawn(direct, &environment).is_some()
}

fn spawn(mut command: Command, environment: &[(OsString, OsString)]) -> Option<Child> {
    command
        .env_clear()
        .envs(environment.iter().map(|(name, value)| (name, value)))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    command.spawn().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn variables(list: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        list.iter()
            .map(|(name, value)| (name.into(), value.into()))
            .collect()
    }

    fn text(value: &std::ffi::OsStr) -> String {
        value.to_string_lossy().into_owned()
    }

    fn lookup(cleaned: &[(OsString, OsString)], name: &str) -> Option<String> {
        cleaned
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| text(value))
    }

    #[test]
    fn removes_everything_that_points_at_the_old_instance() {
        let cleaned = clean_environment(variables(&[
            ("APPDIR", "/tmp/.mount_QuorumOld"),
            ("APPIMAGE", "/apps/Quorum.AppImage"),
            ("TARGET_APPIMAGE", "/apps/Quorum.AppImage"),
            ("REDIRECT_APPIMAGE", "/apps/Quorum.AppImage"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_QuorumOld/usr/lib"),
            (
                "GSETTINGS_SCHEMA_DIR",
                "/tmp/.mount_QuorumOld/usr/share/glib-2.0/schemas",
            ),
            (
                "PATH",
                "/tmp/.mount_QuorumOld:/tmp/.mount_QuorumOld/usr/sbin:/usr/local/bin:/usr/bin",
            ),
            (
                "XDG_DATA_DIRS",
                "/tmp/.mount_QuorumOld/usr/share/:/usr/share",
            ),
            ("HOME", "/home/user"),
            ("WAYLAND_DISPLAY", "wayland-0"),
            ("EMPTY", ""),
        ]));
        for gone in [
            "APPDIR",
            "APPIMAGE",
            "TARGET_APPIMAGE",
            "REDIRECT_APPIMAGE",
            "LD_LIBRARY_PATH",
            "GSETTINGS_SCHEMA_DIR",
        ] {
            assert_eq!(lookup(&cleaned, gone), None, "{gone} must be removed");
        }
        assert_eq!(
            lookup(&cleaned, "PATH").as_deref(),
            Some("/usr/local/bin:/usr/bin")
        );
        assert_eq!(
            lookup(&cleaned, "XDG_DATA_DIRS").as_deref(),
            Some("/usr/share")
        );
        assert_eq!(lookup(&cleaned, "HOME").as_deref(), Some("/home/user"));
        assert_eq!(
            lookup(&cleaned, "WAYLAND_DISPLAY").as_deref(),
            Some("wayland-0")
        );
        assert_eq!(lookup(&cleaned, "EMPTY").as_deref(), Some(""));
    }

    #[test]
    fn drops_mount_entries_even_without_appdir() {
        let cleaned = clean_environment(variables(&[(
            "LD_LIBRARY_PATH",
            "/tmp/.mount_QuorumX/usr/lib:/opt/lib",
        )]));
        assert_eq!(
            lookup(&cleaned, "LD_LIBRARY_PATH").as_deref(),
            Some("/opt/lib")
        );
    }
}
