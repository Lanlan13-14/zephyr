//! Native folder picker for RDP folder mapping.
//!
//! Why this indirection exists at all:
//!   The RDP settings UI lives in app.html, which the WebView loads from the
//!   embedded core over `http://127.0.0.1:PORT`. To Tauri that is a *remote*
//!   origin, so the page cannot `invoke()` a command — and granting IPC to a
//!   loopback origin would hand it to any process that can bind a port.
//!
//!   The browser alternative, `showDirectoryPicker()`, returns an opaque handle
//!   with no filesystem path. FreeRDP's drive redirection needs a real path, so
//!   a handle is useless here.
//!
//!   So the page files a request with the core, and this watcher — running in
//!   the shell process, which *can* open a native dialog — claims it, shows the
//!   OS folder chooser, and posts the chosen path back. Same shape as the theme
//!   watcher already in `icon`, and it reuses the core's own session adoption
//!   (`adoptEmbeddedLocalSession` is global middleware, so a cookieless request
//!   from this process authenticates as the local account).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;

/// Poll cadence. Fast enough that tapping 选择文件夹 feels immediate, slow
/// enough to be invisible on idle: an empty claim is a single loopback GET
/// returning a 30-byte body.
const POLL_INTERVAL: Duration = Duration::from_millis(300);

static WATCHER_STARTED: AtomicBool = AtomicBool::new(false);

/// Extract a JSON string field. Hand-rolled rather than pulling in a full parse
/// because the two payloads involved are one and two flat string fields; the
/// escape handling below is what keeps a path containing `\"` honest.
fn json_string_field(body: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let start = body.find(&needle)? + needle.len();
    let rest = &body[start..];
    let colon = rest.find(':')?;
    let after = rest[colon + 1..].trim_start();
    let mut chars = after.chars();
    if chars.next()? != '"' {
        return None;
    }
    let mut out = String::new();
    let mut escaped = false;
    for ch in chars {
        if escaped {
            match ch {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                'r' => out.push('\r'),
                'u' => return Some(out), // not expected in a path; stop rather than mangle
                other => out.push(other),
            }
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '"' => return Some(out),
            other => out.push(other),
        }
    }
    None
}

/// Minimal JSON string escaping for the path we post back.
fn json_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Start the watcher. Idempotent: `runtime_start` may be retried after a
/// failure, and a second watcher would race the first for the same request id.
pub fn spawn_picker_watcher<R: Runtime>(app: &AppHandle<R>) {
    if WATCHER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL_INTERVAL);

        let base_url = crate::runtime::info().base_url;
        if base_url.is_empty() {
            continue; // core not running
        }
        let base = base_url.trim_end_matches('/').to_string();

        let claim = match ureq::get(&format!("{base}/api/one/rdp/picker-queue"))
            .timeout(Duration::from_secs(3))
            .call()
        {
            Ok(resp) if resp.status() == 200 => match resp.into_string() {
                Ok(text) => text,
                Err(_) => continue,
            },
            _ => continue,
        };

        let Some(id) = json_string_field(&claim, "id") else {
            continue;
        };
        if id.is_empty() {
            continue;
        }

        /* The dialog blocks this thread, which is correct: while a chooser is
         * open there is nothing else for the watcher to do, and claiming a
         * second request mid-dialog would show two choosers at once. */
        let picked = app.dialog().file().blocking_pick_folder();
        let body = match picked {
            Some(folder) => {
                let path = match folder.into_path() {
                    Ok(path) => path.to_string_lossy().into_owned(),
                    Err(raw) => raw.to_string(),
                };
                format!("{{\"path\":\"{}\"}}", json_escape(&path))
            }
            /* Cancelled. Reported explicitly rather than left to time out, so
             * the page can restore the button instead of spinning for two
             * minutes. */
            None => "{\"error\":\"cancelled\"}".to_string(),
        };

        let url = format!("{base}/api/one/rdp/picker-queue/{id}");
        if let Err(error) = ureq::post(&url)
            .timeout(Duration::from_secs(3))
            .set("Content-Type", "application/json")
            .send_string(&body)
        {
            eprintln!("zephyr-one: folder picker result not delivered: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_flat_string_field() {
        let body = r#"{"id":"7f3a-1","username":"root"}"#;
        assert_eq!(json_string_field(body, "id").as_deref(), Some("7f3a-1"));
        assert_eq!(
            json_string_field(body, "username").as_deref(),
            Some("root")
        );
        assert_eq!(json_string_field(body, "missing"), None);
    }

    #[test]
    fn empty_claim_yields_an_empty_id() {
        // What the core returns when no request is pending. The watcher must
        // read this as "nothing to do" rather than as a request named "".
        let body = r#"{"id":"","username":""}"#;
        assert_eq!(json_string_field(body, "id").as_deref(), Some(""));
    }

    #[test]
    fn windows_paths_survive_escaping_both_ways() {
        // A Windows path is the case that breaks naive JSON handling: every
        // separator is a backslash, which is also JSON's escape character.
        let path = r"C:\Users\Test User\共享文件夹";
        let body = format!("{{\"path\":\"{}\"}}", json_escape(path));
        assert_eq!(json_string_field(&body, "path").as_deref(), Some(path));
    }

    #[test]
    fn quotes_in_a_path_round_trip() {
        let path = "/home/me/it\"s odd";
        let body = format!("{{\"path\":\"{}\"}}", json_escape(path));
        assert_eq!(json_string_field(&body, "path").as_deref(), Some(path));
    }

    #[test]
    fn a_key_that_is_a_prefix_of_another_is_not_confused() {
        /*
         * "id" must resolve to the `id` field, not to the `id` inside `uid`.
         * This matters concretely: the picker-queue response carries both
         * `id` and `username`, and a `drivePath`/`path` pair appears in the
         * mapping payloads. Matching a suffix would hand the watcher the wrong
         * request id and it would resolve a request that was never claimed.
         *
         * Both orderings are asserted because a scan that merely takes the
         * first match would pass one and fail the other.
         */
        let uid_first = r#"{"uid":"nope","id":"yes"}"#;
        assert_eq!(json_string_field(uid_first, "id").as_deref(), Some("yes"));

        let id_first = r#"{"id":"yes","uid":"nope"}"#;
        assert_eq!(json_string_field(id_first, "id").as_deref(), Some("yes"));

        // Same shape as the mapping payload: `path` must not match `drivePath`.
        let paths = r#"{"drivePath":"nope","path":"yes"}"#;
        assert_eq!(json_string_field(paths, "path").as_deref(), Some("yes"));
    }
}
