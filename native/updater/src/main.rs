//! Standalone update window for Quorum.
//!
//! Quorum cannot show progress while it is being replaced, and a running AppImage unmounts its own files on exit.
//! So the app copies this binary out, starts it and quits; the window stays up until the new version is in place.

mod install;
mod window;

use std::process::{Command, ExitCode, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use install::{Job, Phase};

fn main() -> ExitCode {
    let job = match Job::parse(std::env::args_os().skip(1)) {
        Ok(job) => Arc::new(job),
        Err(error) => {
            eprintln!("quorum-updater: {error}");
            return ExitCode::from(2);
        }
    };
    let phase = Arc::new(Mutex::new(Phase::WaitingForExit));
    let worker = thread::spawn({
        let job = Arc::clone(&job);
        let phase = Arc::clone(&phase);
        move || install::run(&job, |next| *phase.lock().unwrap() = next)
    });
    // Without a display the update still has to happen, so a window that fails to open is not an error.
    let _ = window::show(Arc::clone(&phase), job.language);
    let outcome = worker
        .join()
        .unwrap_or(Phase::Failed("worker crashed".into()));
    if outcome == Phase::Cancelled {
        return ExitCode::SUCCESS;
    }
    // After a failed swap the target is still the old version: starting it beats leaving the user without an app.
    restart(&job);
    if outcome == Phase::Done {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn restart(job: &Job) {
    use std::os::unix::process::CommandExt;
    let mut command = Command::new(&job.target);
    command
        .args(&job.relaunch)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    // These still point into the mount of the version that just exited.
    for variable in ["APPIMAGE", "APPDIR", "ARGV0", "OWD"] {
        command.env_remove(variable);
    }
    if let Err(error) = command.spawn() {
        eprintln!(
            "quorum-updater: could not start {}: {error}",
            job.target.display()
        );
    }
}
