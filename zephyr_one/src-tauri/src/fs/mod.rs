//! Native filesystem provider for integrated Agent (ZFT2 / JSON RPC).
//! Path confinement: all operations must stay under the configured share root.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;
use thiserror::Error;
use uuid::Uuid;

#[derive(Default)]
pub struct FsState {
    open: Mutex<HashMap<String, OpenHandle>>,
}

struct OpenHandle {
    #[allow(dead_code)]
    path: PathBuf,
    file: File,
    writable: bool,
}

#[derive(Debug, Error)]
pub enum FsError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl FsError {
    pub fn code(&self) -> &'static str {
        match self {
            FsError::Message(m) if m.contains("read_only") => "read_only",
            FsError::Message(m) if m.contains("not found") || m.contains("NotFound") => "not_found",
            FsError::Message(m) if m.contains("outside") || m.contains("escape") => {
                "permission_denied"
            }
            FsError::Io(e) if e.kind() == std::io::ErrorKind::NotFound => "not_found",
            FsError::Io(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                "permission_denied"
            }
            _ => "io_error",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: u64,
    pub can_read: bool,
    pub can_write: bool,
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Resolve `virtual_path` under `root`, rejecting `..` escapes.
pub fn resolve_under_root(root: &str, virtual_path: &str) -> Result<PathBuf, FsError> {
    let root_path = PathBuf::from(root)
        .canonicalize()
        .map_err(|e| FsError::Message(format!("invalid root: {e}")))?;

    let rel = virtual_path.trim();
    let rel = rel.trim_start_matches('/');
    let rel = rel.trim_start_matches('\\');

    let mut out = root_path.clone();
    if !rel.is_empty() && rel != "." {
        for comp in Path::new(rel).components() {
            match comp {
                Component::Normal(s) => out.push(s),
                Component::CurDir => {}
                Component::ParentDir => {
                    return Err(FsError::Message("path escape rejected".into()));
                }
                Component::RootDir | Component::Prefix(_) => {
                    return Err(FsError::Message("absolute path rejected".into()));
                }
            }
        }
    }

    // If path exists, canonicalize and ensure still under root.
    if out.exists() {
        let canon = out
            .canonicalize()
            .map_err(|e| FsError::Message(format!("canonicalize failed: {e}")))?;
        if !canon.starts_with(&root_path) {
            return Err(FsError::Message("path outside share root".into()));
        }
        return Ok(canon);
    }

    // For create paths: ensure parent is under root.
    if let Some(parent) = out.parent() {
        if parent.exists() {
            let parent_canon = parent
                .canonicalize()
                .map_err(|e| FsError::Message(format!("parent canonicalize failed: {e}")))?;
            if !parent_canon.starts_with(&root_path) {
                return Err(FsError::Message("path outside share root".into()));
            }
        }
    }
    Ok(out)
}

fn virtualize(root: &Path, absolute: &Path) -> String {
    if let Ok(rel) = absolute.strip_prefix(root) {
        let s = rel.to_string_lossy().replace('\\', "/");
        if s.is_empty() {
            "/".into()
        } else {
            format!("/{}", s.trim_start_matches('/'))
        }
    } else {
        "/".into()
    }
}

impl FsState {
    pub fn list(&self, root: &str, path: &str) -> Result<Vec<FileStat>, FsError> {
        let root_path = PathBuf::from(root)
            .canonicalize()
            .map_err(|e| FsError::Message(format!("invalid root: {e}")))?;
        let dir = resolve_under_root(root, path)?;
        let mut out = Vec::new();
        let rd = fs::read_dir(&dir)?;
        for entry in rd.flatten() {
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue, // skip inaccessible entries like Agent desktop provider
            };
            let abs = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            out.push(FileStat {
                name,
                path: virtualize(&root_path, &abs),
                is_dir: meta.is_dir(),
                size: meta.len(),
                mtime: mtime_ms(&meta),
                can_read: true,
                can_write: true,
            });
        }
        out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(out)
    }

    pub fn stat(&self, root: &str, path: &str) -> Result<FileStat, FsError> {
        let root_path = PathBuf::from(root)
            .canonicalize()
            .map_err(|e| FsError::Message(format!("invalid root: {e}")))?;
        let abs = resolve_under_root(root, path)?;
        let meta = fs::metadata(&abs)?;
        Ok(FileStat {
            name: abs
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "/".into()),
            path: virtualize(&root_path, &abs),
            is_dir: meta.is_dir(),
            size: meta.len(),
            mtime: mtime_ms(&meta),
            can_read: true,
            can_write: true,
        })
    }

    pub fn open(&self, root: &str, path: &str, mode: &str) -> Result<String, FsError> {
        let abs = resolve_under_root(root, path)?;
        let writable = mode == "write" || mode == "readwrite" || mode == "rw";
        let file = if writable {
            OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .open(&abs)?
        } else {
            OpenOptions::new().read(true).open(&abs)?
        };
        let handle = format!("h_{}", Uuid::new_v4().simple());
        self.open.lock().insert(
            handle.clone(),
            OpenHandle {
                path: abs,
                file,
                writable,
            },
        );
        Ok(handle)
    }

    pub fn read(&self, handle: &str, offset: u64, length: u64) -> Result<Vec<u8>, FsError> {
        let mut map = self.open.lock();
        let h = map
            .get_mut(handle)
            .ok_or_else(|| FsError::Message("handle not found".into()))?;
        h.file.seek(SeekFrom::Start(offset))?;
        let mut buf = vec![0u8; length as usize];
        let n = h.file.read(&mut buf)?;
        buf.truncate(n);
        Ok(buf)
    }

    pub fn write(&self, handle: &str, offset: u64, data: &[u8]) -> Result<u64, FsError> {
        let mut map = self.open.lock();
        let h = map
            .get_mut(handle)
            .ok_or_else(|| FsError::Message("handle not found".into()))?;
        if !h.writable {
            return Err(FsError::Message("read_only handle".into()));
        }
        h.file.seek(SeekFrom::Start(offset))?;
        h.file.write_all(data)?;
        Ok(data.len() as u64)
    }

    pub fn close(&self, handle: &str) -> Result<(), FsError> {
        let mut map = self.open.lock();
        if let Some(mut h) = map.remove(handle) {
            let _ = h.file.flush();
        }
        Ok(())
    }

    pub fn mkdir(&self, root: &str, path: &str) -> Result<(), FsError> {
        let abs = resolve_under_root(root, path)?;
        fs::create_dir_all(abs)?;
        Ok(())
    }

    pub fn delete(&self, root: &str, path: &str, recursive: bool) -> Result<(), FsError> {
        let abs = resolve_under_root(root, path)?;
        let meta = fs::metadata(&abs)?;
        if meta.is_dir() {
            if recursive {
                fs::remove_dir_all(abs)?;
            } else {
                fs::remove_dir(abs)?;
            }
        } else {
            fs::remove_file(abs)?;
        }
        Ok(())
    }

    pub fn rename(&self, root: &str, old_path: &str, new_path: &str) -> Result<(), FsError> {
        let from = resolve_under_root(root, old_path)?;
        let to = resolve_under_root(root, new_path)?;
        fs::rename(from, to)?;
        Ok(())
    }

    pub fn truncate(&self, root: &str, path: &str, size: u64) -> Result<(), FsError> {
        let abs = resolve_under_root(root, path)?;
        let f = OpenOptions::new().write(true).open(abs)?;
        f.set_len(size)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn rejects_parent_escape() {
        let dir = tempfile_dir();
        let err = resolve_under_root(dir.to_str().unwrap(), "../etc/passwd").unwrap_err();
        assert!(err.to_string().contains("escape") || err.to_string().contains("outside"));
    }

    #[test]
    fn allows_nested_relative() {
        let dir = tempfile_dir();
        let nested = dir.join("a");
        fs::create_dir_all(&nested).unwrap();
        let p = resolve_under_root(dir.to_str().unwrap(), "a").unwrap();
        assert!(p.ends_with("a"));
    }

    #[test]
    fn list_and_read_roundtrip() {
        let dir = tempfile_dir();
        let file = dir.join("hello.txt");
        {
            let mut f = File::create(&file).unwrap();
            f.write_all(b"zephyr-one").unwrap();
        }
        let state = FsState::default();
        let root = dir.to_string_lossy().to_string();
        let entries = state.list(&root, "/").unwrap();
        assert!(entries.iter().any(|e| e.name == "hello.txt"));
        let handle = state.open(&root, "/hello.txt", "read").unwrap();
        let bytes = state.read(&handle, 0, 64).unwrap();
        assert_eq!(&bytes, b"zephyr-one");
        state.close(&handle).unwrap();
    }

    fn tempfile_dir() -> PathBuf {
        let mut d = std::env::temp_dir();
        d.push(format!("zephyr_one_fs_test_{}", Uuid::new_v4().simple()));
        fs::create_dir_all(&d).unwrap();
        d
    }
}

pub fn default_share_path() -> (String, String) {
    #[cfg(target_os = "windows")]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            let name = Path::new(&profile)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "User".into());
            return (profile, name);
        }
        let tmp = std::env::temp_dir();
        return (tmp.to_string_lossy().to_string(), "Temp".into());
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        if let Ok(home) = std::env::var("HOME") {
            let name = Path::new(&home)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "Home".into());
            return (home, name);
        }
        let tmp = std::env::temp_dir();
        return (tmp.to_string_lossy().to_string(), "Temp".into());
    }

    // Other / unknown targets
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let tmp = std::env::temp_dir();
        (tmp.to_string_lossy().to_string(), "Temp".into())
    }
}
