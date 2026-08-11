//! Native system-unlock handoff for Zephyr One's security switch.
//!
//! Why this exists, and why it is a polled handoff rather than an `invoke`:
//!   `src-tauri/src/auth/mod.rs` has implemented Windows Hello / Touch ID since
//!   the first desktop build, but the only caller was the Tauri shell's own boot
//!   screen. The *product* UI - Settings, connections, SSH keys - is served by
//!   the embedded core over `http://127.0.0.1:PORT`, which to Tauri is a remote
//!   origin, so those pages cannot invoke a command. Granting IPC to a loopback
//!   origin would hand it to any process that can bind a local port.
//!
//!   So the page files an unlock request with the core, this watcher claims it,
//!   runs the real OS prompt in the shell process where it is possible, and
//!   posts the verdict back. The core then mints a short-lived grant that the
//!   reveal routes check. Identical shape to `rdp_picker`, deliberately: one
//!   proven handoff pattern beats two half-proven ones.
//!
//! What this module does *not* do:
//!   It never sees a secret, never reads a stored password or key, and never
//!   decides policy. It answers exactly one question - "did the human at this
//!   desktop just satisfy the OS authenticator?" - and the core decides what
//!   that is worth.

use hmac::{Hmac, Mac};
use once_cell::sync::Lazy;
use serde::Deserialize;
use sha2::Sha256;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Runtime};
use uuid::Uuid;

/// Same cadence as the folder picker: fast enough that a reveal prompt feels
/// immediate, cheap enough to be invisible when idle.
const POLL_INTERVAL: Duration = Duration::from_millis(300);
const SHELL_AUTH_NAMESPACE: &str = "one-shell-unlock-v1";

static WATCHER_STARTED: AtomicBool = AtomicBool::new(false);

struct ShellIdentity {
    secret: String,
    instance: String,
}

#[derive(Deserialize)]
struct UnlockClaim {
    id: String,
    username: String,
    purpose: String,
    reason: String,
}

/* Created once per Tauri process. Two UUIDv4 values provide 244 random bits for
 * the MAC key; the independent instance id prevents a request captured from a
 * prior shell process from naming the current claimant. */
static SHELL_IDENTITY: Lazy<ShellIdentity> = Lazy::new(|| ShellIdentity {
    secret: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
    instance: Uuid::new_v4().simple().to_string(),
});

/// Values the runtime passes only to its Node child. They must never be exposed
/// through RuntimeInfo, command output, logs, a URL, or the WebView environment.
pub(crate) fn shell_identity_env() -> (&'static str, &'static str) {
    (&SHELL_IDENTITY.secret, &SHELL_IDENTITY.instance)
}

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
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts keys of any size");
    mac.update(message);
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn signed_request(
    request: ureq::Request,
    action: &str,
    fields: &[&str],
) -> ureq::Request {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string();
    let nonce = Uuid::new_v4().simple().to_string();
    let identity = &*SHELL_IDENTITY;
    let message = signed_message(action, &timestamp, &nonce, &identity.instance, fields);
    let mac = hmac_sha256_hex(identity.secret.as_bytes(), message.as_bytes());

    request
        .set("X-Zephyr-One-Shell-Instance", &identity.instance)
        .set("X-Zephyr-One-Shell-Timestamp", &timestamp)
        .set("X-Zephyr-One-Shell-Nonce", &nonce)
        .set("X-Zephyr-One-Shell-Mac", &mac)
}

/// Extract a flat JSON string field.
///
/// Duplicated deliberately from `rdp_picker` rather than shared: making one of
/// these modules depend on the other's private helper couples two independent
/// handoffs, and the function is eleven lines. Both copies are tested.
#[cfg(test)]
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
                'u' => return Some(out),
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

/// Tell the core what this platform's authenticator can do.
///
/// Published once at startup so the settings page can render an honest control
/// before anyone presses anything: on Linux the switch is disabled with the
/// reason shown, rather than offered and then failing at the first prompt.
fn publish_capabilities<R: Runtime>(app: &AppHandle<R>, base: &str) {
    let caps = crate::auth::capabilities(app);
    let body = format!(
        "{{\"available\":{},\"biometry\":{},\"reason\":\"{}\"}}",
        caps.available,
        caps.biometry,
        json_escape(&caps.reason)
    );
    let available = if caps.available { "1" } else { "0" };
    let biometry = if caps.biometry { "1" } else { "0" };
    let request = signed_request(
        ureq::post(&format!("{base}/api/one/security/capabilities")),
        "capabilities",
        &[available, biometry, &caps.reason],
    );
    if let Err(error) = request
        .timeout(Duration::from_secs(3))
        .set("Content-Type", "application/json")
        .send_string(&body)
    {
        eprintln!("zephyr-one: unlock capabilities not published: {error}");
    }
}

/// Start the watcher. Idempotent for the same reason as the picker watcher:
/// `runtime_start` may be retried, and two watchers would race for one request.
pub fn spawn_unlock_watcher<R: Runtime>(app: &AppHandle<R>) {
    if WATCHER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        let mut published = false;

        loop {
            std::thread::sleep(POLL_INTERVAL);

            let base_url = crate::runtime::info().base_url;
            if base_url.is_empty() {
                continue; // core not running yet
            }
            let base = base_url.trim_end_matches('/').to_string();

            /* Published on the first iteration that finds a live core, not at
             * spawn time: the runtime may still be booting when the watcher
             * starts, and a POST to a dead port would be silently lost. */
            if !published {
                publish_capabilities(&app, &base);
                published = true;
            }

            let claim_request = signed_request(
                ureq::get(&format!("{base}/api/one/security/unlock-queue")),
                "unlock.claim",
                &[],
            );
            let claim = match claim_request.timeout(Duration::from_secs(3)).call() {
                Ok(resp) if resp.status() == 200 => match resp.into_string() {
                    Ok(text) => text,
                    Err(_) => continue,
                },
                _ => continue,
            };

            let Ok(claim) = serde_json::from_str::<UnlockClaim>(&claim) else {
                continue;
            };
            if claim.id.is_empty() {
                continue;
            }
            let id = claim.id;
            let username = claim.username;
            let purpose = claim.purpose;
            let reason = Some(claim.reason)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "\u{67e5}\u{770b}\u{654f}\u{611f}\u{4fe1}\u{606f}\u{9700}\u{8981}\u{7cfb}\u{7edf}\u{89e3}\u{9501}".to_string());

            /* Blocks this thread while the OS prompt is up, which is correct:
             * claiming a second request mid-prompt would stack two system
             * dialogs on one another. */
            let verdict = crate::auth::unlock(&app, &reason);
            let (ok, method, error) = if verdict.ok {
                (
                    true,
                    verdict.method.as_deref().unwrap_or("system").to_string(),
                    String::new(),
                )
            } else {
                /* Cancellation and failure are both reported, never left to time
                 * out: the page restores its button immediately instead of
                 * spinning until the request TTL expires. */
                (
                    false,
                    String::new(),
                    verdict
                        .error
                        .as_deref()
                        .unwrap_or("\u{7cfb}\u{7edf}\u{89e3}\u{9501}\u{5931}\u{8d25}\u{6216}\u{5df2}\u{53d6}\u{6d88}")
                        .to_string(),
                )
            };
            let body = serde_json::json!({
                "username": &username,
                "purpose": &purpose,
                "ok": ok,
                "method": &method,
                "error": &error,
            })
            .to_string();

            let url = format!("{base}/api/one/security/unlock-queue/{id}");
            let ok_field = if ok { "1" } else { "0" };
            let request = signed_request(
                ureq::post(&url),
                "unlock.resolve",
                &[&id, &username, &purpose, ok_field, &method, &error],
            );
            if let Err(error) = request
                .timeout(Duration::from_secs(3))
                .set("Content-Type", "application/json")
                .send_string(&body)
            {
                eprintln!("zephyr-one: unlock result not delivered: {error}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_claim_fields() {
        let body = r#"{"id":"unlock-1-2","username":"root","purpose":"reveal_secret","reason":"reveal a secret"}"#;
        assert_eq!(json_string_field(body, "id").as_deref(), Some("unlock-1-2"));
        assert_eq!(json_string_field(body, "username").as_deref(), Some("root"));
        assert_eq!(
            json_string_field(body, "purpose").as_deref(),
            Some("reveal_secret")
        );
        assert_eq!(
            json_string_field(body, "reason").as_deref(),
            Some("reveal a secret")
        );
    }

    #[test]
    fn an_empty_claim_is_not_a_request() {
        // What the core returns when nothing is pending. Must read as idle.
        let body = r#"{"id":"","username":"","reason":""}"#;
        assert_eq!(json_string_field(body, "id").as_deref(), Some(""));
    }

    #[test]
    fn a_reason_with_quotes_round_trips() {
        // The reason is user-visible text that reaches an OS dialog; a quote in
        // it must not truncate the JSON the shell parses.
        let reason = "open \"my key\" now";
        let body = format!("{{\"reason\":\"{}\"}}", json_escape(reason));
        assert_eq!(json_string_field(&body, "reason").as_deref(), Some(reason));
    }

    #[test]
    fn capability_body_is_valid_json_for_each_platform_shape() {
        // Linux reports unavailable with a reason; Windows/macOS report true.
        let unavailable = format!(
            "{{\"available\":{},\"biometry\":{},\"reason\":\"{}\"}}",
            false,
            false,
            json_escape("Linux has no unified system unlock API")
        );
        assert_eq!(
            json_string_field(&unavailable, "reason").as_deref(),
            Some("Linux has no unified system unlock API")
        );
        assert!(unavailable.contains("\"available\":false"));

        let available = format!(
            "{{\"available\":{},\"biometry\":{},\"reason\":\"{}\"}}",
            true,
            true,
            json_escape("Windows Hello / device PIN")
        );
        assert!(available.contains("\"available\":true"));
        assert!(available.contains("\"biometry\":true"));
    }

    #[test]
    fn hmac_matches_the_rfc_4231_sha256_vector() {
        assert_eq!(
            hmac_sha256_hex(&[0x0b; 20], b"Hi There"),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
    }

    #[test]
    fn signed_message_binds_instance_action_and_fields() {
        let message = signed_message(
            "unlock.resolve",
            "1723000000000",
            "0123456789abcdef0123456789abcdef",
            "shell-instance",
            &["request-1", "alice", "reveal_secret", "1"],
        );
        assert!(message.contains("one-shell-unlock-v1\nunlock.resolve"));
        assert!(message.contains("\nshell-instance\n9:request-1"));
        assert!(message.ends_with("1:1"));
    }
}
