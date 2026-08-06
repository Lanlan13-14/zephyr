//! Agent integration notes.
//!
//! Protocol ownership lives in the webview (`src/js/agent/*`) so it stays
//! aligned with the Flutter Zephyr Agent and Node file-agent-manager.
//! Native side only provides:
//! - confined filesystem IO (`crate::fs`)
//! - directory picker / default share path
//! - platform identity
//!
//! Future: optional pure-Rust websocket agent daemon for headless desktop
//! service mode without a visible window.

#![allow(dead_code)]

pub const PROTOCOL_VERSION: u32 = 2;
pub const WS_PATH: &str = "/agent/files";
