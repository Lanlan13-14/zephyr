use getrandom::fill as fill_random;
use serde::{Deserialize, Serialize};
use std::ffi::{OsStr, OsString};
use std::mem::size_of;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, LocalFree, ERROR_ALREADY_EXISTS, ERROR_IO_PENDING, ERROR_PIPE_CONNECTED,
    GENERIC_READ, HANDLE, HLOCAL, WAIT_OBJECT_0,
};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
    SetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT,
};
use windows::Win32::Security::{
    AclSizeInformation, EqualSid, GetAce, GetAclInformation, GetLengthSid,
    GetSecurityDescriptorControl, GetSecurityDescriptorDacl, GetTokenInformation,
    SetTokenInformation, TokenOwner, TokenUser, ACCESS_ALLOWED_ACE, ACL_SIZE_INFORMATION,
    CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, OBJECT_INHERIT_ACE,
    OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSID, SECURITY_ATTRIBUTES,
    SE_DACL_PROTECTED, TOKEN_ADJUST_DEFAULT, TOKEN_OWNER, TOKEN_QUERY, TOKEN_USER,
};
use windows::Win32::Storage::FileSystem::{
    CreateDirectoryW, CreateFileW, FlushFileBuffers, GetFileInformationByHandle, ReadFile,
    WriteFile, BY_HANDLE_FILE_INFORMATION, FILE_ALL_ACCESS, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAG_OVERLAPPED,
    FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, PIPE_ACCESS_OUTBOUND,
    READ_CONTROL, WRITE_DAC,
};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId, GetNamedPipeServerProcessId,
    PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows::Win32::System::SystemInformation::GetWindowsDirectoryW;
use windows::Win32::System::Threading::{
    CreateEventW, GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken,
    QueryFullProcessImageNameW, WaitForMultipleObjects, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows::Win32::UI::Shell::{
    FOLDERID_LocalAppData, FOLDERID_Profile, FOLDERID_ProgramData, FOLDERID_RoamingAppData,
    SHGetKnownFolderPath, KF_FLAG_DEFAULT, KNOWN_FOLDER_FLAG,
};

pub(crate) const FLAG: &str = "--zephyr-one-private-runtime-launcher-v2";
const PIPE_PREFIX: &str = r"\\.\pipe\zephyr-one-runtime-v2-";
const PIPE_TIMEOUT_MS: u32 = 15_000;
const MAX_CONFIG_BYTES: usize = 16 * 1024;

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

struct LocalAllocation(HLOCAL);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        unsafe {
            let _ = LocalFree(self.0);
        }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
struct FileIdentity {
    volume: u32,
    index_high: u32,
    index_low: u32,
}

struct OpenedPath {
    path: PathBuf,
    directory: bool,
    share_write: bool,
    handle: OwnedHandle,
    identity: FileIdentity,
}

struct AlignedBuffer(Vec<usize>);

impl AlignedBuffer {
    fn new(bytes: u32) -> Self {
        Self(vec![
            0;
            (bytes as usize).div_ceil(size_of::<usize>()).max(1)
        ])
    }

    fn ptr(&mut self) -> *mut core::ffi::c_void {
        self.0.as_mut_ptr().cast()
    }
}

#[derive(Serialize, Deserialize)]
pub(crate) struct LaunchConfig {
    pub(crate) port: u16,
    pub(crate) startup_challenge: String,
    pub(crate) shell_secret: String,
    pub(crate) shell_instance: String,
}

pub(crate) struct LauncherAuth {
    pipe_name: String,
    pipe: OwnedHandle,
    _descriptor: LocalAllocation,
}

impl LauncherAuth {
    pub(crate) fn new() -> Result<Self, String> {
        let mut random = [0_u8; 32];
        fill_random(&mut random)
            .map_err(|error| format!("launcher pipe random failed: {error}"))?;
        let pipe_name = format!("{PIPE_PREFIX}{}", encode_hex(&random));
        let mut sid = current_user_sid()?;
        let (descriptor, attributes) = private_security_attributes(&mut sid, false)?;
        let name_wide = wide(OsStr::new(&pipe_name));
        let pipe = unsafe {
            CreateNamedPipeW(
                PCWSTR(name_wide.as_ptr()),
                PIPE_ACCESS_OUTBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                MAX_CONFIG_BYTES as u32 + 4,
                0,
                PIPE_TIMEOUT_MS,
                Some(&attributes),
            )
        };
        if pipe.is_invalid() {
            return Err(format!(
                "private launcher pipe creation failed: {}",
                windows::core::Error::from_win32()
            ));
        }
        Ok(Self {
            pipe_name,
            pipe: OwnedHandle(pipe),
            _descriptor: descriptor,
        })
    }

    pub(crate) fn command_arg(&self) -> &str {
        &self.pipe_name
    }

    pub(crate) fn authenticate_and_send(
        &self,
        child: &Child,
        config: &LaunchConfig,
    ) -> Result<(), String> {
        let child_handle = HANDLE(child.as_raw_handle());
        let event = unsafe { CreateEventW(None, true, false, PCWSTR::null()) }
            .map(OwnedHandle)
            .map_err(|error| format!("launcher pipe event creation failed: {error}"))?;
        let mut overlapped = OVERLAPPED {
            hEvent: event.0,
            ..Default::default()
        };
        let connected = match unsafe { ConnectNamedPipe(self.pipe.0, Some(&mut overlapped)) } {
            Ok(()) => true,
            Err(error) if error.code() == ERROR_PIPE_CONNECTED.to_hresult() => true,
            Err(error) if error.code() == ERROR_IO_PENDING.to_hresult() => false,
            Err(error) => return Err(format!("launcher pipe connect failed: {error}")),
        };
        if !connected {
            let result =
                unsafe { WaitForMultipleObjects(&[event.0, child_handle], false, PIPE_TIMEOUT_MS) };
            if result != WAIT_OBJECT_0 {
                unsafe {
                    let _ = CancelIoEx(self.pipe.0, Some(&overlapped));
                }
                return Err(if result.0 == WAIT_OBJECT_0.0 + 1 {
                    "runtime launcher exited before pipe authentication".into()
                } else {
                    "runtime launcher pipe authentication timed out".into()
                });
            }
            let mut transferred = 0;
            unsafe {
                GetOverlappedResult(self.pipe.0, &overlapped, &mut transferred, false)
                    .map_err(|error| format!("launcher pipe connect completion failed: {error}"))?;
            }
        }
        let mut client_pid = 0;
        unsafe { GetNamedPipeClientProcessId(self.pipe.0, &mut client_pid) }
            .map_err(|error| format!("launcher pipe client PID query failed: {error}"))?;
        if client_pid != child.id() {
            return Err(
                "launcher pipe connected by a process other than the spawned launcher".into(),
            );
        }
        let payload = serde_json::to_vec(config)
            .map_err(|error| format!("launcher configuration serialization failed: {error}"))?;
        if payload.is_empty() || payload.len() > MAX_CONFIG_BYTES {
            return Err("launcher configuration has an invalid size".into());
        }
        let mut framed = Vec::with_capacity(payload.len() + 4);
        framed.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        framed.extend_from_slice(&payload);
        write_pipe_overlapped(self.pipe.0, child_handle, &framed)?;
        unsafe { FlushFileBuffers(self.pipe.0) }
            .map_err(|error| format!("launcher pipe flush failed: {error}"))?;
        Ok(())
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn write_pipe_overlapped(pipe: HANDLE, child: HANDLE, value: &[u8]) -> Result<(), String> {
    let event = unsafe { CreateEventW(None, true, false, PCWSTR::null()) }
        .map(OwnedHandle)
        .map_err(|error| format!("launcher pipe write event creation failed: {error}"))?;
    let mut overlapped = OVERLAPPED {
        hEvent: event.0,
        ..Default::default()
    };
    let mut immediate = 0;
    let completed = match unsafe {
        WriteFile(
            pipe,
            Some(value),
            Some(&mut immediate),
            Some(&mut overlapped),
        )
    } {
        Ok(()) => true,
        Err(error) if error.code() == ERROR_IO_PENDING.to_hresult() => false,
        Err(error) => return Err(format!("launcher pipe write failed: {error}")),
    };
    let written = if completed {
        immediate
    } else {
        let result = unsafe { WaitForMultipleObjects(&[event.0, child], false, PIPE_TIMEOUT_MS) };
        if result != WAIT_OBJECT_0 {
            unsafe {
                let _ = CancelIoEx(pipe, Some(&overlapped));
            }
            return Err(if result.0 == WAIT_OBJECT_0.0 + 1 {
                "runtime launcher exited during configuration transfer".into()
            } else {
                "runtime launcher configuration transfer timed out".into()
            });
        }
        let mut transferred = 0;
        unsafe {
            GetOverlappedResult(pipe, &overlapped, &mut transferred, false)
                .map_err(|error| format!("launcher pipe write completion failed: {error}"))?;
        }
        transferred
    };
    if written as usize != value.len() {
        return Err("launcher pipe configuration transfer was truncated".into());
    }
    Ok(())
}

fn read_exact(handle: HANDLE, value: &mut [u8]) -> Result<(), String> {
    let mut offset = 0;
    while offset < value.len() {
        let mut read = 0;
        unsafe { ReadFile(handle, Some(&mut value[offset..]), Some(&mut read), None) }
            .map_err(|error| format!("launcher pipe read failed: {error}"))?;
        if read == 0 {
            return Err("launcher pipe closed before configuration completed".into());
        }
        offset += read as usize;
    }
    Ok(())
}

fn receive_authenticated_config(pipe_name: &str, parent_pid: u32) -> Result<LaunchConfig, String> {
    if !valid_pipe_name(pipe_name) {
        return Err("runtime launcher pipe name is invalid".into());
    }
    let name_wide = wide(OsStr::new(pipe_name));
    let pipe = unsafe {
        CreateFileW(
            PCWSTR(name_wide.as_ptr()),
            GENERIC_READ.0,
            FILE_SHARE_READ,
            None,
            OPEN_EXISTING,
            Default::default(),
            None,
        )
    }
    .map(OwnedHandle)
    .map_err(|error| format!("private launcher pipe open failed: {error}"))?;
    let mut server_pid = 0;
    unsafe { GetNamedPipeServerProcessId(pipe.0, &mut server_pid) }
        .map_err(|error| format!("launcher pipe server PID query failed: {error}"))?;
    if server_pid != parent_pid {
        return Err("launcher pipe is not hosted by the verified parent process".into());
    }
    let mut length = [0_u8; 4];
    read_exact(pipe.0, &mut length)?;
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > MAX_CONFIG_BYTES {
        return Err("launcher configuration length is invalid".into());
    }
    let mut payload = vec![0_u8; length];
    read_exact(pipe.0, &mut payload)?;
    let config: LaunchConfig = serde_json::from_slice(&payload)
        .map_err(|error| format!("launcher configuration is invalid: {error}"))?;
    validate_config(&config)?;
    Ok(config)
}

fn valid_pipe_name(value: &str) -> bool {
    value.len() == PIPE_PREFIX.len() + 64
        && value.starts_with(PIPE_PREFIX)
        && value[PIPE_PREFIX.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_config(config: &LaunchConfig) -> Result<(), String> {
    let lower_hex = |value: &str, length: usize| {
        value.len() == length
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    };
    if config.port < 1024
        || !lower_hex(&config.startup_challenge, 64)
        || !lower_hex(&config.shell_secret, 64)
        || !lower_hex(&config.shell_instance, 32)
    {
        return Err("launcher configuration failed strict validation".into());
    }
    Ok(())
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

fn query_token(
    token: HANDLE,
    class: windows::Win32::Security::TOKEN_INFORMATION_CLASS,
) -> Result<AlignedBuffer, String> {
    let mut required = 0;
    unsafe {
        let _ = GetTokenInformation(token, class, None, 0, &mut required);
    }
    if required == 0 {
        return Err(format!("token information {} has no size", class.0));
    }
    let mut buffer = AlignedBuffer::new(required);
    unsafe {
        GetTokenInformation(token, class, Some(buffer.ptr()), required, &mut required)
            .map_err(|error| format!("GetTokenInformation({}) failed: {error}", class.0))?;
    }
    Ok(buffer)
}

fn current_user_sid() -> Result<Vec<usize>, String> {
    let mut token = HANDLE::default();
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }
        .map_err(|error| format!("OpenProcessToken failed: {error}"))?;
    let token = OwnedHandle(token);
    let mut user = query_token(token.0, TokenUser)?;
    let token_user = unsafe { &*(user.ptr().cast::<TOKEN_USER>()) };
    let sid_len = unsafe { GetLengthSid(token_user.User.Sid) } as usize;
    if sid_len == 0 {
        return Err("current token user SID is invalid".into());
    }
    let mut sid_words = vec![0usize; sid_len.div_ceil(size_of::<usize>())];
    unsafe {
        std::ptr::copy_nonoverlapping(
            token_user.User.Sid.0.cast::<u8>(),
            sid_words.as_mut_ptr().cast(),
            sid_len,
        );
    }
    Ok(sid_words)
}

fn set_process_default_owner_to_user() -> Result<Vec<usize>, String> {
    let mut token = HANDLE::default();
    unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_QUERY | TOKEN_ADJUST_DEFAULT,
            &mut token,
        )
    }
    .map_err(|error| format!("OpenProcessToken failed: {error}"))?;
    let token = OwnedHandle(token);
    let mut sid_words = current_user_sid()?;
    let owner = TOKEN_OWNER {
        Owner: PSID(sid_words.as_mut_ptr().cast()),
    };
    unsafe {
        SetTokenInformation(
            token.0,
            TokenOwner,
            (&owner as *const TOKEN_OWNER).cast(),
            size_of::<TOKEN_OWNER>() as u32,
        )
        .map_err(|error| format!("SetTokenInformation(TokenOwner) failed: {error}"))?;
    }
    let mut verified = query_token(token.0, TokenOwner)?;
    let verified_owner = unsafe { &*(verified.ptr().cast::<TOKEN_OWNER>()) };
    unsafe { EqualSid(verified_owner.Owner, owner.Owner) }
        .map_err(|_| "launcher TokenOwner did not become TokenUser".to_string())?;
    Ok(sid_words)
}

fn private_security_attributes(
    user_sid: &mut [usize],
    directory: bool,
) -> Result<(LocalAllocation, SECURITY_ATTRIBUTES), String> {
    let expected_sid = PSID(user_sid.as_mut_ptr().cast());
    let mut sid_string = PWSTR::null();
    unsafe { ConvertSidToStringSidW(expected_sid, &mut sid_string) }
        .map_err(|error| format!("TokenUser SID string conversion failed: {error}"))?;
    let sid_text = unsafe { sid_string.to_string() }
        .map_err(|error| format!("TokenUser SID is invalid UTF-16: {error}"))?;
    let _sid_string = LocalAllocation(HLOCAL(sid_string.as_ptr().cast()));
    let ace = if directory { "A;OICI;FA" } else { "A;;FA" };
    let sddl = format!("O:{sid_text}D:P({ace};;;{sid_text})");
    let sddl_wide = wide(OsStr::new(&sddl));
    let mut descriptor = windows::Win32::Security::PSECURITY_DESCRIPTOR::default();
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(sddl_wide.as_ptr()),
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
    }
    .map_err(|error| format!("private security descriptor conversion failed: {error}"))?;
    let allocation = LocalAllocation(HLOCAL(descriptor.0));
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: false.into(),
    };
    Ok((allocation, attributes))
}

fn open_identity(
    path: &Path,
    directory: bool,
    desired_access: u32,
    share_write: bool,
) -> Result<(OwnedHandle, FileIdentity, BY_HANDLE_FILE_INFORMATION), String> {
    let path_wide = wide(path.as_os_str());
    let flags = FILE_FLAG_OPEN_REPARSE_POINT
        | if directory {
            FILE_FLAG_BACKUP_SEMANTICS
        } else {
            Default::default()
        };
    let share = FILE_SHARE_READ
        | if share_write {
            FILE_SHARE_WRITE
        } else {
            Default::default()
        };
    let handle = unsafe {
        CreateFileW(
            PCWSTR(path_wide.as_ptr()),
            desired_access,
            share,
            None,
            OPEN_EXISTING,
            flags,
            None,
        )
    }
    .map(OwnedHandle)
    .map_err(|error| format!("secure open failed for {}: {error}", path.display()))?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(handle.0, &mut info) }
        .map_err(|error| format!("identity read failed for {}: {error}", path.display()))?;
    const REPARSE: u32 = 0x400;
    const DIRECTORY: u32 = 0x10;
    if info.dwFileAttributes & REPARSE != 0 || (info.dwFileAttributes & DIRECTORY != 0) != directory
    {
        return Err(format!(
            "runtime path is a reparse point or wrong type: {}",
            path.display()
        ));
    }
    Ok((
        handle,
        FileIdentity {
            volume: info.dwVolumeSerialNumber,
            index_high: info.nFileIndexHigh,
            index_low: info.nFileIndexLow,
        },
        info,
    ))
}

fn hold_path(path: &Path, directory: bool, share_write: bool) -> Result<OpenedPath, String> {
    let (handle, identity, _) =
        open_identity(path, directory, FILE_READ_ATTRIBUTES.0, share_write)?;
    Ok(OpenedPath {
        path: path.to_path_buf(),
        directory,
        share_write,
        handle,
        identity,
    })
}

fn hold_directory_chain(path: &Path) -> Result<Vec<OpenedPath>, String> {
    let mut components = path
        .ancestors()
        .filter(|ancestor| !ancestor.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .collect::<Vec<_>>();
    components.reverse();
    components
        .into_iter()
        .map(|component| hold_path(&component, true, true))
        .collect()
}

fn verify_held_paths(paths: &[OpenedPath]) -> Result<(), String> {
    for held in paths {
        let (_, identity, _) = open_identity(
            &held.path,
            held.directory,
            FILE_READ_ATTRIBUTES.0,
            held.share_write,
        )?;
        if identity != held.identity {
            return Err(format!(
                "held runtime path changed during validation: {}",
                held.path.display()
            ));
        }
        if held.handle.0.is_invalid() {
            return Err("held runtime path handle became invalid".into());
        }
    }
    Ok(())
}

fn hold_resource_tree(root: &Path) -> Result<Vec<OpenedPath>, String> {
    fn walk(path: &Path, held: &mut Vec<OpenedPath>) -> Result<(), String> {
        held.push(hold_path(path, true, false)?);
        let entries = std::fs::read_dir(path).map_err(|error| {
            format!(
                "resource enumeration failed for {}: {error}",
                path.display()
            )
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("resource enumeration failed: {error}"))?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("resource type read failed: {error}"))?;
            let child = entry.path();
            if file_type.is_symlink() {
                return Err(format!(
                    "resource tree contains a link: {}",
                    child.display()
                ));
            }
            if file_type.is_dir() {
                walk(&child, held)?;
            } else if file_type.is_file() {
                held.push(hold_path(&child, false, false)?);
            } else {
                return Err(format!(
                    "resource tree contains a special file: {}",
                    child.display()
                ));
            }
        }
        Ok(())
    }
    let mut held = Vec::new();
    walk(root, &mut held)?;
    verify_held_paths(&held)?;
    Ok(held)
}

fn parent_pid() -> Result<u32, String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
        .map(OwnedHandle)
        .map_err(|error| format!("process snapshot failed: {error}"))?;
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    unsafe { Process32FirstW(snapshot.0, &mut entry) }
        .map_err(|error| format!("process snapshot enumeration failed: {error}"))?;
    loop {
        if entry.th32ProcessID == unsafe { GetCurrentProcessId() } {
            return Ok(entry.th32ParentProcessID);
        }
        if unsafe { Process32NextW(snapshot.0, &mut entry) }.is_err() {
            break;
        }
    }
    Err("launcher parent process was not found".into())
}

fn process_image(pid: u32) -> Result<(OwnedHandle, PathBuf), String> {
    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            false,
            pid,
        )
    }
    .map(OwnedHandle)
    .map_err(|error| format!("launcher parent cannot be opened: {error}"))?;
    let mut buffer = vec![0u16; 32768];
    let mut len = buffer.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            process.0,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut len,
        )
    }
    .map_err(|error| format!("launcher parent image cannot be read: {error}"))?;
    Ok((
        process,
        PathBuf::from(String::from_utf16_lossy(&buffer[..len as usize])),
    ))
}

fn verify_same_executable_parent(
    current_exe: &Path,
) -> Result<(u32, OwnedHandle, OpenedPath), String> {
    let (_, current, _) = open_identity(current_exe, false, FILE_READ_ATTRIBUTES.0, false)?;
    let pid = parent_pid()?;
    let (parent_process, parent_path) = process_image(pid)?;
    let parent_image = hold_path(&parent_path, false, false)?;
    if current != parent_image.identity {
        return Err("runtime launcher parent is not this Zephyr One executable".into());
    }
    Ok((pid, parent_process, parent_image))
}

fn descriptor_dacl(
    descriptor: windows::Win32::Security::PSECURITY_DESCRIPTOR,
) -> Result<*mut windows::Win32::Security::ACL, String> {
    let mut present = windows::Win32::Foundation::BOOL::default();
    let mut defaulted = windows::Win32::Foundation::BOOL::default();
    let mut dacl = std::ptr::null_mut();
    unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) }
        .map_err(|error| format!("private descriptor DACL query failed: {error}"))?;
    if !present.as_bool() || dacl.is_null() {
        return Err("private descriptor has no DACL".into());
    }
    Ok(dacl)
}

fn verify_private_acl(handle: HANDLE, expected_sid: PSID, directory: bool) -> Result<bool, String> {
    let mut owner = PSID::default();
    let mut dacl = std::ptr::null_mut();
    let mut descriptor = windows::Win32::Security::PSECURITY_DESCRIPTOR::default();
    let code = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            Some(&mut owner),
            None,
            Some(&mut dacl),
            None,
            Some(&mut descriptor),
        )
    };
    if code.0 != 0 {
        return Err(format!(
            "private path security query failed: win32={}",
            code.0
        ));
    }
    let _descriptor = LocalAllocation(HLOCAL(descriptor.0));
    unsafe { EqualSid(owner, expected_sid) }
        .map_err(|_| "existing private path is not owned by the current user".to_string())?;
    if dacl.is_null() {
        return Ok(false);
    }
    let mut control = 0_u16;
    let mut revision = 0_u32;
    unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) }
        .map_err(|error| format!("private path descriptor control failed: {error}"))?;
    if control & SE_DACL_PROTECTED.0 == 0 {
        return Ok(false);
    }
    let mut size = ACL_SIZE_INFORMATION::default();
    unsafe {
        GetAclInformation(
            dacl,
            (&mut size as *mut ACL_SIZE_INFORMATION).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    }
    .map_err(|error| format!("private path ACL query failed: {error}"))?;
    if size.AceCount != 1 {
        return Ok(false);
    }
    let mut ace_ptr = std::ptr::null_mut();
    unsafe { GetAce(dacl, 0, &mut ace_ptr) }
        .map_err(|error| format!("private path ACE query failed: {error}"))?;
    let ace = unsafe { &*(ace_ptr.cast::<ACCESS_ALLOWED_ACE>()) };
    let expected_flags = if directory {
        (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE).0 as u8
    } else {
        0
    };
    if ace.Header.AceType != 0
        || ace.Header.AceFlags != expected_flags
        || ace.Mask != FILE_ALL_ACCESS.0
    {
        return Ok(false);
    }
    let ace_sid = PSID((&ace.SidStart as *const u32).cast_mut().cast());
    Ok(unsafe { EqualSid(ace_sid, expected_sid) }.is_ok())
}

fn create_or_normalize_private_path(
    path: &Path,
    directory: bool,
    user_sid: &mut [usize],
) -> Result<OpenedPath, String> {
    let (create_descriptor, attributes) = private_security_attributes(user_sid, directory)?;
    if directory {
        let path_wide = wide(path.as_os_str());
        match unsafe { CreateDirectoryW(PCWSTR(path_wide.as_ptr()), Some(&attributes)) } {
            Ok(()) => {}
            Err(error) if error.code() == ERROR_ALREADY_EXISTS.to_hresult() => {}
            Err(error) => {
                return Err(format!(
                    "private directory creation failed for {}: {error}",
                    path.display()
                ))
            }
        }
    }
    let (handle, identity, info) = open_identity(
        path,
        directory,
        FILE_READ_ATTRIBUTES.0 | READ_CONTROL.0 | WRITE_DAC.0,
        true,
    )?;
    if !directory && info.nNumberOfLinks != 1 {
        return Err(format!(
            "private file has another hard link: {}",
            path.display()
        ));
    }
    let expected_sid = PSID(user_sid.as_mut_ptr().cast());
    if !verify_private_acl(handle.0, expected_sid, directory)? {
        let dacl = descriptor_dacl(windows::Win32::Security::PSECURITY_DESCRIPTOR(
            attributes.lpSecurityDescriptor,
        ))?;
        let code = unsafe {
            SetSecurityInfo(
                handle.0,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                PSID::default(),
                PSID::default(),
                Some(dacl),
                None,
            )
        };
        if code.0 != 0 {
            return Err(format!(
                "private path ACL normalization failed for {}: win32={}",
                path.display(),
                code.0
            ));
        }
        if !verify_private_acl(handle.0, expected_sid, directory)? {
            return Err(format!(
                "private path ACL verification failed after normalization: {}",
                path.display()
            ));
        }
    }
    drop(create_descriptor);
    Ok(OpenedPath {
        path: path.to_path_buf(),
        directory,
        share_write: true,
        handle,
        identity,
    })
}

fn normalize_existing_data_tree(root: &Path, user_sid: &mut [usize]) -> Result<(), String> {
    fn walk(path: &Path, user_sid: &mut [usize]) -> Result<(), String> {
        for entry in std::fs::read_dir(path).map_err(|error| {
            format!(
                "private data enumeration failed for {}: {error}",
                path.display()
            )
        })? {
            let entry =
                entry.map_err(|error| format!("private data enumeration failed: {error}"))?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("private data type read failed: {error}"))?;
            let child = entry.path();
            if file_type.is_symlink() {
                return Err(format!("private data contains a link: {}", child.display()));
            }
            if file_type.is_dir() {
                let held = create_or_normalize_private_path(&child, true, user_sid)?;
                walk(&child, user_sid)?;
                let (_, identity, _) = open_identity(&child, true, FILE_READ_ATTRIBUTES.0, true)?;
                if identity != held.identity {
                    return Err(format!(
                        "private data directory changed: {}",
                        child.display()
                    ));
                }
            } else if file_type.is_file() {
                let held = create_or_normalize_private_path(&child, false, user_sid)?;
                let (_, identity, info) =
                    open_identity(&child, false, FILE_READ_ATTRIBUTES.0, true)?;
                if identity != held.identity || info.nNumberOfLinks != 1 {
                    return Err(format!(
                        "private data file changed or linked: {}",
                        child.display()
                    ));
                }
            } else {
                return Err(format!(
                    "private data contains a special file: {}",
                    child.display()
                ));
            }
        }
        Ok(())
    }
    walk(root, user_sid)
}

fn known_folder(
    id: &windows::core::GUID,
    label: &str,
    flags: KNOWN_FOLDER_FLAG,
) -> Result<PathBuf, String> {
    let value = unsafe {
        SHGetKnownFolderPath(id, flags, None)
            .map_err(|error| format!("{label} resolution failed: {error}"))?
    };
    let path = unsafe { value.to_string() }
        .map(PathBuf::from)
        .map_err(|error| format!("{label} path is invalid UTF-16: {error}"));
    unsafe {
        CoTaskMemFree(Some(value.as_ptr().cast()));
    }
    validate_known_folder_path(path?, label)
}

fn validate_known_folder_path(path: PathBuf, label: &str) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || path
            .as_os_str()
            .encode_wide()
            .any(|unit| unit == b'%' as u16)
    {
        return Err(format!(
            "{label} resolution returned a non-absolute or unexpanded path"
        ));
    }
    Ok(path)
}

fn program_data_folder() -> Result<PathBuf, String> {
    known_folder(&FOLDERID_ProgramData, "ProgramData", KF_FLAG_DEFAULT)
}

fn windows_directory() -> Result<PathBuf, String> {
    let mut buffer = vec![0_u16; 32768];
    let length = unsafe { GetWindowsDirectoryW(Some(&mut buffer)) } as usize;
    if length == 0 || length >= buffer.len() {
        return Err("Windows directory resolution failed".into());
    }
    Ok(PathBuf::from(OsString::from_wide(&buffer[..length])))
}

pub(crate) fn trusted_system_drive() -> Result<OsString, String> {
    use std::path::{Component, Prefix};

    let windows = windows_directory()?;
    match windows.components().next() {
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)) =>
        {
            Ok(prefix.as_os_str().to_os_string())
        }
        _ => Err("Windows directory is not on an absolute DOS drive".into()),
    }
}

fn configure_kill_job() -> Result<OwnedHandle, String> {
    let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
        .map(OwnedHandle)
        .map_err(|error| format!("runtime job creation failed: {error}"))?;
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
    .map_err(|error| format!("runtime job configuration failed: {error}"))?;
    Ok(job)
}

fn wait_for_parent_or_node(parent: HANDLE, child: &mut Child, job: HANDLE) -> Result<i32, String> {
    let child_handle = HANDLE(child.as_raw_handle());
    let result = unsafe { WaitForMultipleObjects(&[parent, child_handle], false, u32::MAX) };
    if result == WAIT_OBJECT_0 {
        unsafe { TerminateJobObject(job, 1) }.map_err(|error| {
            format!("runtime job termination after parent exit failed: {error}")
        })?;
    } else if result.0 != WAIT_OBJECT_0.0 + 1 {
        unsafe {
            let _ = TerminateJobObject(job, 1);
        }
        return Err(format!("runtime process wait failed: win32={}", result.0));
    }
    let status = child
        .wait()
        .map_err(|error| format!("embedded Node wait failed: {error}"))?;
    Ok(status.code().unwrap_or(1))
}

fn run(pipe_name: &str) -> Result<i32, String> {
    let current_exe =
        std::env::current_exe().map_err(|error| format!("current exe unavailable: {error}"))?;
    let (parent_pid, parent_process, parent_image) = verify_same_executable_parent(&current_exe)?;
    let config = receive_authenticated_config(pipe_name, parent_pid)?;
    let mut user_sid = set_process_default_owner_to_user()?;

    let install = current_exe
        .parent()
        .ok_or("launcher executable has no directory")?;
    let install_chain = hold_directory_chain(install)?;
    let resources = install.join("_up_");
    let node_root = resources.join("desktop-runtime");
    let node = node_root.join("node.exe");
    let core = resources.join("zephyr-core");
    let server = core.join("server.js");
    let mut held_resources = vec![hold_path(&resources, true, false)?];
    held_resources.extend(hold_resource_tree(&node_root)?);
    held_resources.extend(hold_resource_tree(&core)?);
    if !held_resources
        .iter()
        .any(|path| path.path == node && !path.directory)
        || !held_resources
            .iter()
            .any(|path| path.path == server && !path.directory)
    {
        return Err("installed runtime is missing its fixed Node or server entry point".into());
    }
    verify_held_paths(&install_chain)?;
    verify_held_paths(&held_resources)?;

    let roaming = known_folder(&FOLDERID_RoamingAppData, "RoamingAppData", KF_FLAG_DEFAULT)?;
    let roaming_chain = hold_directory_chain(&roaming)?;
    let app_parent = roaming.join("com.zephyr.one");
    let app_parent_handle = create_or_normalize_private_path(&app_parent, true, &mut user_sid)?;
    verify_held_paths(&roaming_chain)?;
    let data_dir = app_parent.join("zephyr-data");
    let data_handle = create_or_normalize_private_path(&data_dir, true, &mut user_sid)?;
    normalize_existing_data_tree(&data_dir, &mut user_sid)?;
    let held_data = vec![app_parent_handle, data_handle];
    verify_held_paths(&held_data)?;
    verify_held_paths(&roaming_chain)?;

    let windows = windows_directory()?;
    let profile = known_folder(&FOLDERID_Profile, "Profile", KF_FLAG_DEFAULT)?;
    let local_app_data = known_folder(&FOLDERID_LocalAppData, "LocalAppData", KF_FLAG_DEFAULT)?;
    let program_data = program_data_folder()?;
    let public_origin = format!("http://127.0.0.1:{}", config.port);
    let system32 = windows.join("System32");
    let path = [
        system32.clone(),
        windows.clone(),
        system32.join("Wbem"),
        system32.join("WindowsPowerShell").join("v1.0"),
    ]
    .into_iter()
    .map(|part| part.as_os_str().to_owned())
    .collect::<Vec<_>>()
    .join(OsStr::new(";"));

    let job = configure_kill_job()?;
    verify_held_paths(&install_chain)?;
    verify_held_paths(&held_resources)?;
    verify_held_paths(&held_data)?;
    let mut command = Command::new(&node);
    command
        .current_dir(&core)
        .arg(&server)
        .env_clear()
        .env("SystemRoot", &windows)
        .env("WINDIR", &windows)
        .env("ComSpec", system32.join("cmd.exe"))
        .env("PATH", path)
        .env("PATHEXT", ".COM;.EXE;.BAT;.CMD")
        .env("USERPROFILE", profile)
        .env("APPDATA", &roaming)
        .env("LOCALAPPDATA", local_app_data)
        .env("ProgramData", program_data)
        .env("TEMP", &data_dir)
        .env("TMP", &data_dir)
        .env("ZEPHYR_DATA_DIR", &data_dir)
        .env("HTTP_ENABLED", "true")
        .env("HTTPS_ENABLED", "false")
        .env("PORT", config.port.to_string())
        .env("PUBLIC_ORIGIN", public_origin)
        .env("TRUST_PROXY", "false")
        .env("ZEPHYR_ONE_EMBEDDED", "1")
        .env("ZEPHYR_ONE_STARTUP_CHALLENGE", config.startup_challenge)
        .env("ZEPHYR_ONE_SHELL_SECRET", config.shell_secret)
        .env("ZEPHYR_ONE_SHELL_INSTANCE", config.shell_instance)
        .env("ZEPHYR_VERSION", env!("CARGO_PKG_VERSION"))
        .env("ZEPHYR_ONE_USE_BUILTIN_SQLITE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000);
    let mut child = command
        .spawn()
        .map_err(|error| format!("embedded Node spawn failed: {error}"))?;
    if let Err(error) = unsafe { AssignProcessToJobObject(job.0, HANDLE(child.as_raw_handle())) } {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!(
            "embedded Node cannot enter kill-on-close job: {error}"
        ));
    }
    verify_held_paths(&held_resources)?;
    verify_held_paths(&held_data)?;
    let status = wait_for_parent_or_node(parent_process.0, &mut child, job.0)?;
    drop(parent_image);
    drop(held_resources);
    drop(install_chain);
    drop(held_data);
    Ok(status)
}

pub(crate) fn try_run() -> Option<i32> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.first().is_none() || args.get(1) != Some(&OsString::from(FLAG)) {
        return None;
    }
    Some(if args.len() != 3 {
        eprintln!("zephyr runtime launcher refused: invalid private launcher arguments");
        70
    } else {
        match args[2].to_str().ok_or("launcher pipe name is not UTF-8") {
            Ok(pipe_name) => match run(pipe_name) {
                Ok(code) => code,
                Err(error) => {
                    eprintln!("zephyr runtime launcher refused: {error}");
                    70
                }
            },
            Err(error) => {
                eprintln!("zephyr runtime launcher refused: {error}");
                70
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_pipe_names_are_fixed_and_unambiguous() {
        assert!(valid_pipe_name(&format!("{PIPE_PREFIX}{}", "a".repeat(64))));
        assert!(!valid_pipe_name(&format!(
            "{PIPE_PREFIX}{}",
            "A".repeat(64)
        )));
        assert!(!valid_pipe_name(&format!(
            "{PIPE_PREFIX}{}",
            "a".repeat(63)
        )));
        assert!(!valid_pipe_name(r"\\.\pipe\other-aabb"));
    }

    #[test]
    fn launcher_config_rejects_weak_or_ambiguous_secrets() {
        let valid = LaunchConfig {
            port: 49152,
            startup_challenge: "a".repeat(64),
            shell_secret: "b".repeat(64),
            shell_instance: "c".repeat(32),
        };
        assert!(validate_config(&valid).is_ok());
        assert!(validate_config(&LaunchConfig {
            startup_challenge: "A".repeat(64),
            ..valid
        })
        .is_err());
    }

    #[test]
    fn known_folder_paths_must_be_absolute_and_expanded() {
        assert!(validate_known_folder_path(PathBuf::from(r"C:\ProgramData"), "test").is_ok());
        assert!(
            validate_known_folder_path(PathBuf::from(r"%SystemDrive%\ProgramData"), "test")
                .is_err()
        );
        assert!(validate_known_folder_path(PathBuf::from("ProgramData"), "test").is_err());
    }

    #[test]
    fn trusted_system_drive_comes_from_the_windows_directory() {
        let drive = trusted_system_drive().unwrap();
        let drive = drive.to_string_lossy();
        assert_eq!(drive.len(), 2);
        assert_eq!(&drive[1..], ":");
    }
}
