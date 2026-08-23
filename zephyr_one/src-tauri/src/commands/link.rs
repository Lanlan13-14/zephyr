//! Tauri commands that drive the embedded Zephyr Link (ZSL/2) core.
//!
//! The desktop UI owns WHAT to sync; the embedded Go process owns the wire. Rust only shuts the
//! bytes between the webview and the loopback Go service and never re-implements ZSL/2, so the
//! desktop speaks the byte-identical protocol the server and mobile ends use. This is how the
//! desktop joins the same encrypted owned-sync channel instead of the old pull-only HTTPS path.

use crate::link_runtime;
use serde_json::{json, Value};
use tauri::AppHandle;

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(35))
        .build()
}

fn post(base: &str, path: &str, body: Value) -> Result<Value, String> {
    let url = format!("{base}{path}");
    let resp = agent()
        .post(&url)
        .set("Content-Type", "application/json")
        .send_json(body)
        .map_err(|e| format!("Link 请求失败: {e}"))?;
    resp.into_json::<Value>().map_err(|e| format!("Link 响应解析失败: {e}"))
}

/// Start the embedded Link core and report its loopback URL.
#[tauri::command]
pub fn link_info(app: AppHandle) -> Result<link_runtime::LinkInfo, String> {
    tauri::async_runtime::block_on(async {
        tauri::async_runtime::spawn_blocking(move || link_runtime::ensure_started(&app))
            .await
            .map_err(|e| e.to_string())?
    })
}

/// Establish a ZSL/2 session to the remote main end and return the session id + exporter.
#[tauri::command]
pub fn link_dial(app: AppHandle, server_url: String) -> Result<Value, String> {
    let info = link_runtime::ensure_started(&app)?;
    let resp = post(
        &info.base_url,
        "/link/dial",
        json!({ "url": server_url, "deviceId": Value::Null }),
    )?;
    if resp.get("ok").and_then(Value::as_bool) != Some(true) {
        let msg = resp
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("拨号失败");
        return Err(msg.to_string());
    }
    Ok(resp)
}

/// Push one owned-sync business frame on an established session and return the sealed ack body.
#[tauri::command]
pub fn link_push(
    app: AppHandle,
    server_url: String,
    session_id: String,
    kind: i64,
    body: Value,
    secret: bool,
) -> Result<Value, String> {
    let info = link_runtime::ensure_started(&app)?;
    let resp = post(
        &info.base_url,
        "/link/push",
        json!({
            "sessionId": session_id,
            "peerUrl": server_url,
            "kind": kind,
            "body": body,
            "secret": secret,
        }),
    )?;
    if resp.get("ok").and_then(Value::as_bool) != Some(true) {
        let msg = resp
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("推送失败");
        return Err(msg.to_string());
    }
    Ok(resp)
}

/// Stop the embedded Link core (app teardown).
#[tauri::command]
pub fn link_stop() -> Result<(), String> {
    link_runtime::stop();
    Ok(())
}
