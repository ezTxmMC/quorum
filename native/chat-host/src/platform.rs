use std::io;
use std::process::Command;

#[cfg(unix)]
pub fn configure(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
    #[cfg(target_os = "linux")]
    // SAFETY: pre_exec only performs async-signal-safe libc calls and returns an OS error.
    unsafe {
        command.pre_exec(|| {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                return Err(io::Error::last_os_error());
            }
            if libc::getppid() == 1 {
                return Err(io::Error::other("Chat supervisor exited during spawn"));
            }
            Ok(())
        });
    }
}

#[cfg(windows)]
pub fn configure(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);
}

#[cfg(unix)]
pub struct ProcessGroup {
    pid: i32,
}

#[cfg(unix)]
impl ProcessGroup {
    pub fn new(pid: u32) -> io::Result<Self> {
        Ok(Self { pid: pid as i32 })
    }

    pub fn terminate(&self) {
        // SAFETY: the child was created as leader of this owned process group.
        unsafe { libc::kill(-self.pid, libc::SIGTERM) };
    }
}

#[cfg(unix)]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        // SAFETY: only the owned child process group is addressed, never the app's group.
        unsafe { libc::kill(-self.pid, libc::SIGKILL) };
    }
}

#[cfg(windows)]
pub struct ProcessGroup {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl ProcessGroup {
    pub fn new(pid: u32) -> io::Result<Self> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::*;
        use windows_sys::Win32::System::Threading::*;
        // SAFETY: handles are checked, configured, assigned once, and closed on every failure path.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            );
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if configured == 0 || process.is_null() {
                let error = io::Error::last_os_error();
                if !process.is_null() {
                    CloseHandle(process);
                }
                CloseHandle(job);
                return Err(error);
            }
            let assigned = AssignProcessToJobObject(job, process);
            CloseHandle(process);
            if assigned == 0 {
                let error = io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }
            Ok(Self { handle: job })
        }
    }

    pub fn terminate(&self) {
        // SAFETY: this handle exclusively owns this chat's process tree.
        unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.handle, 1) };
    }
}

#[cfg(windows)]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        // SAFETY: this is the sole owner; closing also terminates any remaining descendants.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
    }
}
