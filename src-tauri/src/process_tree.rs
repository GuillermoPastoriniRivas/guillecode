// One non-inheritable job handle per owned process tree. Windows closes these
// handles even after a crash/TerminateProcess; user apps and the updater are
// never assigned to these jobs.
#[cfg(windows)]
pub struct ProcessTree(windows::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for ProcessTree {}
#[cfg(windows)]
unsafe impl Sync for ProcessTree {}

#[cfg(windows)]
impl ProcessTree {
    pub fn attach(pid: u32) -> Result<Self, String> {
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::JobObjects::*;
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};
        unsafe {
            let job = Self(CreateJobObjectW(None, PCWSTR::null()).map_err(|e| e.to_string())?);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, &limits as *const _ as _, std::mem::size_of_val(&limits) as u32)
                .map_err(|e| e.to_string())?;
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid).map_err(|e| e.to_string())?;
            let result = AssignProcessToJobObject(job.0, process);
            let _ = CloseHandle(process);
            result.map_err(|e| format!("no se pudo supervisar el árbol del proceso {}: {}", pid, e))?;
            Ok(job)
        }
    }

    pub fn terminate(&self) {
        unsafe { let _ = windows::Win32::System::JobObjects::TerminateJobObject(self.0, 1); }
    }

    pub fn active_processes(&self) -> Option<u32> {
        use windows::Win32::System::JobObjects::*;
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        unsafe { QueryInformationJobObject(Some(self.0), JobObjectBasicAccountingInformation, &mut info as *mut _ as _, std::mem::size_of_val(&info) as u32, None).ok()?; }
        Some(info.ActiveProcesses)
    }
}

#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        unsafe { let _ = windows::Win32::Foundation::CloseHandle(self.0); }
    }
}

#[cfg(not(windows))]
pub struct ProcessTree;
#[cfg(not(windows))]
impl ProcessTree {
    pub fn attach(_pid: u32) -> Result<Self, String> { Ok(Self) }
    pub fn terminate(&self) {}
    pub fn active_processes(&self) -> Option<u32> { None }
}
