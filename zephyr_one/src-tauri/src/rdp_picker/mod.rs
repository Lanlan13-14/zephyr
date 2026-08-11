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
//!   OS folder chooser, and posts the chosen path back. Session adoption selects
//!   the local account, while the per-process shell MAC proves the caller is the
//!   native shell rather than JavaScript running in that adopted WebView session.

use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

/// Poll cadence. Fast enough that tapping 选择文件夹 feels immediate, slow
/// enough to be invisible on idle: an empty claim is a single loopback GET
/// returning a 30-byte body.
const POLL_INTERVAL: Duration = Duration::from_millis(300);
const SHELL_AUTH_NAMESPACE: &str = "one-shell-unlock-v1";

static WATCHER_STARTED: AtomicBool = AtomicBool::new(false);

fn signed_message(
    action: &str,
    timestamp: &str,
    nonce: &str,
    shell_instance: &str,
    fields: &[&str],
) -> String {
    let mut parts = vec![
        SHELL_AUTH_NAMESPACE.to_string(),
        action.to_string(),
        timestamp.to_string(),
        nonce.to_string(),
        shell_instance.to_string(),
    ];
    parts.extend(
        fields
            .iter()
            .map(|value| format!("{}:{}", value.len(), value)),
    );
    parts.join("\n")
}

fn hmac_sha256_hex(key: &[u8], message: &[u8]) -> String {
    const BLOCK_SIZE: usize = 64;
    let mut key_block = [0_u8; BLOCK_SIZE];
    if key.len() > BLOCK_SIZE {
        let digest = Sha256::digest(key);
        key_block[..digest.len()].copy_from_slice(&digest);
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }

    let mut inner_pad = [0x36_u8; BLOCK_SIZE];
    let mut outer_pad = [0x5c_u8; BLOCK_SIZE];
    for index in 0..BLOCK_SIZE {
        inner_pad[index] ^= key_block[index];
        outer_pad[index] ^= key_block[index];
    }

    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(message);
    let inner_digest = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_digest);
    outer
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Authenticate a loopback request as this Tauri shell process. The identity
/// is shared with the Node child by `runtime`; it must not be copied into a
/// picker-specific secret or exposed through the request body.
fn signed_request(request: ureq::Request, action: &str, fields: &[&str]) -> ureq::Request {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string();
    let nonce = Uuid::new_v4().simple().to_string();
    let (secret, shell_instance) = crate::unlock_bridge::shell_identity_env();
    let message = signed_message(action, &timestamp, &nonce, shell_instance, fields);
    let mac = hmac_sha256_hex(secret.as_bytes(), message.as_bytes());

    request
        .set("X-Zephyr-One-Shell-Instance", shell_instance)
        .set("X-Zephyr-One-Shell-Timestamp", &timestamp)
        .set("X-Zephyr-One-Shell-Nonce", &nonce)
        .set("X-Zephyr-One-Shell-Mac", &mac)
}

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

        let claim_request = signed_request(
            ureq::get(&format!("{base}/api/one/rdp/picker-queue")),
            "rdp_picker.claim",
            &[],
        );
        let claim = match claim_request.timeout(Duration::from_secs(3)).call() {
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
        let (path, error) = match picked {
            Some(folder) => {
                let path = match folder.into_path() {
                    Ok(path) => path.to_string_lossy().into_owned(),
                    Err(raw) => raw.to_string(),
                };
                (path, String::new())
            }
            /* Cancelled. Reported explicitly rather than left to time out, so
             * the page can restore the button instead of spinning for two
             * minutes. */
            None => (String::new(), "cancelled".to_string()),
        };
        let body = format!(
            "{{\"path\":\"{}\",\"error\":\"{}\"}}",
            json_escape(&path),
            json_escape(&error)
        );

        let url = format!("{base}/api/one/rdp/picker-queue/{id}");
        let request = signed_request(
            ureq::post(&url),
            "rdp_picker.resolve",
            &[&id, &path, &error],
        );
        if let Err(delivery_error) = request
            .timeout(Duration::from_secs(3))
            .set("Content-Type", "application/json")
            .send_string(&body)
        {
            eprintln!("zephyr-one: folder picker result not delivered: {delivery_error}");
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
        assert_eq!(json_string_field(body, "username").as_deref(), Some("root"));
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

    #[test]
    fn hmac_matches_the_rfc_4231_sha256_vector() {
        assert_eq!(
            hmac_sha256_hex(&[0x0b; 20], b"Hi There"),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
    }

    #[test]
    fn resolve_signature_binds_id_path_and_error_in_order() {
        let message = signed_message(
            "rdp_picker.resolve",
            "1723000000000",
            "0123456789abcdef0123456789abcdef",
            "shell-instance",
            &["pick-1", "C:\\Users\\Alice\\Share", ""],
        );
        assert_eq!(
            message,
            "one-shell-unlock-v1\nrdp_picker.resolve\n1723000000000\n0123456789abcdef0123456789abcdef\nshell-instance\n6:pick-1\n20:C:\\Users\\Alice\\Share\n0:"
        );

        let unicode_path = "C:\\\u{5171}\u{4eab}";
        let unicode_message = signed_message(
            "rdp_picker.resolve",
            "1723000000000",
            "0123456789abcdef0123456789abcdef",
            "shell-instance",
            &["pick-1", unicode_path, ""],
        );
        assert!(unicode_message.ends_with("\n6:pick-1\n9:C:\\\u{5171}\u{4eab}\n0:"));
    }

    #[test]
    fn claim_signature_has_no_mutable_fields() {
        assert_eq!(
            signed_message(
                "rdp_picker.claim",
                "1723000000000",
                "0123456789abcdef0123456789abcdef",
                "shell-instance",
                &[],
            ),
            "one-shell-unlock-v1\nrdp_picker.claim\n1723000000000\n0123456789abcdef0123456789abcdef\nshell-instance"
        );
    }
}
