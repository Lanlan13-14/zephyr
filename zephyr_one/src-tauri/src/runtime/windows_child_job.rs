use std::mem::size_of_val;
use std::os::windows::io::AsRawHandle;
use std::process::Child;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub(super) struct ChildJob(HANDLE);

unsafe impl Send for ChildJob {}

impl ChildJob {
    pub(super) fn assign(child: &Child) -> Result<Self, String> {
        let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
            .map(Self)
            .map_err(|error| format!("job creation failed: {error}"))?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of_val(&info) as u32,
            )
        }
        .map_err(|error| format!("job configuration failed: {error}"))?;
        unsafe { AssignProcessToJobObject(job.0, HANDLE(child.as_raw_handle())) }
            .map_err(|error| format!("child assignment failed: {error}"))?;
        Ok(job)
    }
}

impl Drop for ChildJob {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
