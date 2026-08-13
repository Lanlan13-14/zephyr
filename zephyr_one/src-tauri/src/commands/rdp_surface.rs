//! Tauri control plane for native RDP presentation surfaces.
//!
//! FreeRDP's borrowed BGRA rectangles remain in Rust and are forwarded directly
//! to the attached platform surface. The explicit AI capture command is the
//! only exception: after owner checks it returns a bounded, encoded PNG copy.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::rdp::{self, FrameRect, FrameSink, SessionEvent};
use crate::rdp_surface::NativeRdpSurfaceRegistry;
use crate::runtime;

#[cfg(target_os = "windows")]
use crate::rdp_surface::windows::{
    create_windows_surface, CapturedBgraFrame, WindowsRdpSurface, WindowsSurfaceConfig,
};
#[cfg(target_os = "windows")]
use crate::rdp_surface::{PixelSize, SurfaceAttachment, SurfaceDpi, SurfaceMetrics};
#[cfg(target_os = "windows")]
use base64::Engine as _;
#[cfg(target_os = "windows")]
use std::ffi::c_void;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, IsWindowVisible, SetForegroundWindow, ShowWindow, SW_SHOW,
};

#[cfg(not(target_os = "windows"))]
const PLATFORM_UNSUPPORTED: &str =
    "rdp_surface_platform_unsupported: native RDP surfaces are currently supported only on Windows";
const SURFACE_MISSING: &str = "rdp_surface_missing";
const SURFACE_EXISTS: &str = "rdp_surface_exists";

#[derive(Debug, Default)]
struct SessionTelemetry {
    frames: AtomicU64,
    bytes: AtomicU64,
    events: Mutex<Vec<String>>,
}

impl SessionTelemetry {
    fn snapshot(&self) -> SessionTelemetrySnapshot {
        SessionTelemetrySnapshot {
            frames: self.frames.load(Ordering::Relaxed),
            bytes: self.bytes.load(Ordering::Relaxed),
            events: self.events.lock().clone(),
        }
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SessionTelemetrySnapshot {
    pub frames: u64,
    pub bytes: u64,
    pub events: Vec<String>,
}

/// A real native sink with low-frequency, pixel-free session observations.
///
/// The wrapper never retains `FrameRect::pixels`; it updates two counters and
/// forwards the same borrowed rectangle synchronously to the registry sink.
struct AttachedSurfaceSink {
    surface: Arc<dyn FrameSink>,
    telemetry: Arc<SessionTelemetry>,
    active: Arc<Mutex<bool>>,
    #[cfg(target_os = "windows")]
    native_surface: Arc<WindowsRdpSurface>,
}

impl FrameSink for AttachedSurfaceSink {
    fn frame(&self, rect: FrameRect<'_>) {
        let active = self.active.lock();
        if !*active {
            return;
        }
        self.telemetry.frames.fetch_add(1, Ordering::Relaxed);
        self.telemetry
            .bytes
            .fetch_add(rect.pixels.len() as u64, Ordering::Relaxed);
        self.surface.frame(rect);
    }

    fn event(&self, event: SessionEvent) {
        let active = self.active.lock();
        if !*active {
            return;
        }
        #[cfg(target_os = "windows")]
        if let SessionEvent::Clipboard(text) = &event {
            // The Win32 surface owns clipboard integration. This only stages a
            // bounded copy for its UI thread; nothing is sent through Tauri.
            let _ = self.native_surface.apply_remote_clipboard(text);
        }
        {
            let mut events = self.telemetry.events.lock();
            if events.len() < 256 {
                let label = match &event {
                    // Clipboard contents are user data, not diagnostics. The
                    // native surface consumes the payload below; telemetry may
                    // only expose the fact that an update occurred.
                    SessionEvent::Clipboard(_) => "Clipboard".to_owned(),
                    _ => format!("{event:?}"),
                };
                events.push(label);
            }
        }
        self.surface.event(event);
    }
}

#[cfg(target_os = "windows")]
struct SurfaceEntry {
    surface: Arc<WindowsRdpSurface>,
    attachment: SurfaceAttachment,
    telemetry: Option<Arc<SessionTelemetry>>,
    session_gate: Option<Arc<Mutex<bool>>>,
}

#[cfg(target_os = "windows")]
impl SurfaceEntry {
    fn unbind_session(&self) {
        if let Some(gate) = &self.session_gate {
            let mut active = gate.lock();
            *active = false;
            self.surface.unbind_session();
        } else {
            self.surface.unbind_session();
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for SurfaceEntry {
    fn drop(&mut self) {
        // A final fence for application shutdown and future early-return paths.
        self.unbind_session();
    }
}

/// Serializes surface creation/teardown with session start/stop.
///
/// This lock is the command-layer lifetime fence. A connect cannot obtain a
/// sink while close is detaching it, and disconnect first removes the session
/// before waiting for any in-flight platform paint to finish.
pub struct NativeRdpSurfaceState {
    sessions: Arc<rdp::SessionRegistry>,
    registry: Arc<NativeRdpSurfaceRegistry>,
    #[cfg(target_os = "windows")]
    surfaces: Mutex<HashMap<String, SurfaceEntry>>,
}

impl NativeRdpSurfaceState {
    pub fn new(
        sessions: Arc<rdp::SessionRegistry>,
        registry: Arc<NativeRdpSurfaceRegistry>,
    ) -> Self {
        Self {
            sessions,
            registry,
            #[cfg(target_os = "windows")]
            surfaces: Mutex::new(HashMap::new()),
        }
    }

    pub fn start_session(&self, session_id: &str, config: rdp::Config) -> Result<(), String> {
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (session_id, config);
            return Err(PLATFORM_UNSUPPORTED.to_owned());
        }

        #[cfg(target_os = "windows")]
        {
            let mut surfaces = self.surfaces.lock();
            self.remove_closed_locked(&mut surfaces, session_id);
            let entry = surfaces.get_mut(session_id).ok_or_else(|| {
                format!("{SURFACE_MISSING}: create a native surface before connecting session {session_id}")
            })?;
            validate_connect_preconditions(
                true,
                self.sessions.get(session_id).is_some(),
                session_id,
            )?;

            entry.unbind_session();
            let telemetry = Arc::new(SessionTelemetry::default());
            let active = Arc::new(Mutex::new(true));
            let sink: Arc<dyn FrameSink> = Arc::new(AttachedSurfaceSink {
                surface: self.registry.frame_sink(session_id.to_owned()),
                telemetry: telemetry.clone(),
                active: active.clone(),
                native_surface: entry.surface.clone(),
            });
            let handle = self
                .sessions
                .start(session_id, config, sink)
                .map_err(|error| format!("{}: {}", error.code(), error))?;
            entry.surface.bind_session(handle);
            entry.session_gate = Some(active);
            if let Err(error) = entry.attachment.request_full_repaint() {
                entry.unbind_session();
                self.sessions.close(session_id);
                return Err(surface_error(error));
            }
            entry.telemetry = Some(telemetry);
            Ok(())
        }
    }

    /// Stop the session and detach its surface as one serialized operation.
    pub fn disconnect_session(&self, session_id: &str) -> bool {
        #[cfg(not(target_os = "windows"))]
        {
            return self.sessions.close(session_id);
        }

        #[cfg(target_os = "windows")]
        {
            let mut surfaces = self.surfaces.lock();
            let entry = surfaces.remove(session_id);
            if let Some(entry) = &entry {
                entry.unbind_session();
            }
            let session_closed = self.sessions.close(session_id);
            if let Some(entry) = entry {
                entry.attachment.detach();
            }
            session_closed
        }
    }

    pub fn close_owner_sessions(&self, broker: &rdp::broker::NativeRdpBroker, owner_label: &str) {
        for session_id in broker.owned_ids(owner_label) {
            let _ = broker.close_owned(owner_label, &session_id, || {
                self.disconnect_session(&session_id)
            });
        }
    }

    pub fn telemetry(&self, session_id: &str) -> SessionTelemetrySnapshot {
        #[cfg(not(target_os = "windows"))]
        {
            let _ = session_id;
            SessionTelemetrySnapshot::default()
        }

        #[cfg(target_os = "windows")]
        {
            let mut surfaces = self.surfaces.lock();
            self.remove_closed_locked(&mut surfaces, session_id);
            surfaces
                .get(session_id)
                .and_then(|entry| entry.telemetry.as_ref())
                .map(|telemetry| telemetry.snapshot())
                .unwrap_or_default()
        }
    }

    /// Reconcile native windows closed directly through their OS chrome.
    pub fn reap_closed_surfaces(&self) -> usize {
        #[cfg(not(target_os = "windows"))]
        {
            0
        }

        #[cfg(target_os = "windows")]
        {
            let mut surfaces = self.surfaces.lock();
            let closed: Vec<String> = surfaces
                .iter()
                .filter(|(_, entry)| !entry.surface.is_attached())
                .map(|(session_id, _)| session_id.clone())
                .collect();
            for session_id in &closed {
                let stale = surfaces.remove(session_id);
                if let Some(stale) = &stale {
                    stale.unbind_session();
                }
                self.sessions.close(session_id);
                drop(stale);
            }
            closed.len()
        }
    }

    #[cfg(target_os = "windows")]
    fn create_surface(
        &self,
        session_id: &str,
        width: u32,
        height: u32,
        dpi: u32,
        title: Option<String>,
        visible: bool,
    ) -> Result<RdpSurfaceStatus, String> {
        let session_id = normalized_session_id(session_id)?;
        let mut surfaces = self.surfaces.lock();
        self.remove_closed_locked(&mut surfaces, &session_id);
        if surfaces.contains_key(&session_id) {
            return Err(format!(
                "{SURFACE_EXISTS}: native surface for session {session_id} already exists"
            ));
        }

        let surface = create_windows_surface(WindowsSurfaceConfig {
            title: title
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "Zephyr One Remote Desktop".to_owned()),
            visible,
        });
        let attachment = self
            .registry
            .attach(
                session_id.clone(),
                surface.clone(),
                SurfaceMetrics::new(PixelSize::new(width, height), SurfaceDpi::new(dpi, dpi)),
            )
            .map_err(surface_error)?;
        let entry = SurfaceEntry {
            surface,
            attachment,
            telemetry: None,
            session_gate: None,
        };
        let status = windows_status(&session_id, Some(&entry), String::new());
        surfaces.insert(session_id, entry);
        Ok(status)
    }

    #[cfg(target_os = "windows")]
    fn show_surface(&self, session_id: &str) -> Result<RdpSurfaceStatus, String> {
        self.with_open_surface(session_id, |entry| {
            let hwnd = window_handle(entry)?;
            let _ = unsafe { ShowWindow(hwnd, SW_SHOW) };
            entry
                .attachment
                .request_full_repaint()
                .map_err(surface_error)?;
            Ok(())
        })
    }

    #[cfg(target_os = "windows")]
    fn focus_surface(&self, session_id: &str) -> Result<RdpSurfaceStatus, String> {
        self.with_open_surface(session_id, |entry| {
            let hwnd = window_handle(entry)?;
            let _ = unsafe { ShowWindow(hwnd, SW_SHOW) };
            let focused = unsafe { SetForegroundWindow(hwnd) }.as_bool();
            if !focused {
                return Err(
                    "rdp_surface_focus_denied: Windows refused foreground activation".to_owned(),
                );
            }
            entry
                .attachment
                .request_full_repaint()
                .map_err(surface_error)?;
            Ok(())
        })
    }

    #[cfg(target_os = "windows")]
    fn resize_surface(
        &self,
        session_id: &str,
        width: u32,
        height: u32,
    ) -> Result<RdpSurfaceStatus, String> {
        self.with_open_surface(session_id, |entry| {
            entry
                .attachment
                .resize(PixelSize::new(width, height))
                .map_err(surface_error)?;
            if let Some(session) = self.sessions.get(session_id) {
                session.resize(width, height);
            }
            entry
                .attachment
                .request_full_repaint()
                .map_err(surface_error)?;
            Ok(())
        })
    }

    #[cfg(target_os = "windows")]
    fn close_surface(&self, session_id: &str) -> Result<bool, String> {
        let session_id = normalized_session_id(session_id)?;
        let mut surfaces = self.surfaces.lock();
        let entry = surfaces.remove(&session_id);
        if let Some(entry) = &entry {
            entry.unbind_session();
        }
        self.sessions.close(&session_id);
        Ok(entry
            .map(|entry| entry.attachment.detach())
            .unwrap_or(false))
    }

    #[cfg(target_os = "windows")]
    fn surface_status(&self, session_id: &str) -> RdpSurfaceStatus {
        let Ok(session_id) = normalized_session_id(session_id) else {
            return windows_status(
                session_id,
                None,
                "surface session id cannot be empty".to_owned(),
            );
        };
        let mut surfaces = self.surfaces.lock();
        if surfaces
            .get(&session_id)
            .is_some_and(|entry| !entry.surface.is_attached())
        {
            let stale = surfaces.remove(&session_id);
            if let Some(stale) = &stale {
                stale.unbind_session();
            }
            self.sessions.close(&session_id);
            drop(stale);
            return windows_status(&session_id, None, "native window was closed".to_owned());
        }
        windows_status(&session_id, surfaces.get(&session_id), String::new())
    }

    #[cfg(target_os = "windows")]
    fn capture_surface(
        &self,
        session_id: &str,
        max_width: u32,
    ) -> Result<CapturedBgraFrame, String> {
        let session_id = normalized_session_id(session_id)?;
        let mut surfaces = self.surfaces.lock();
        self.remove_closed_locked(&mut surfaces, &session_id);
        let entry = surfaces.get(&session_id).ok_or_else(|| {
            format!("{SURFACE_MISSING}: no native surface for session {session_id}")
        })?;
        entry
            .surface
            .capture_frame(max_width)
            .map_err(surface_error)
    }

    #[cfg(target_os = "windows")]
    fn with_open_surface(
        &self,
        session_id: &str,
        operation: impl FnOnce(&SurfaceEntry) -> Result<(), String>,
    ) -> Result<RdpSurfaceStatus, String> {
        let session_id = normalized_session_id(session_id)?;
        let mut surfaces = self.surfaces.lock();
        self.remove_closed_locked(&mut surfaces, &session_id);
        let entry = surfaces.get(&session_id).ok_or_else(|| {
            format!("{SURFACE_MISSING}: no native surface for session {session_id}")
        })?;
        operation(entry)?;
        Ok(windows_status(&session_id, Some(entry), String::new()))
    }

    #[cfg(target_os = "windows")]
    fn remove_closed_locked(&self, surfaces: &mut HashMap<String, SurfaceEntry>, session_id: &str) {
        if surfaces
            .get(session_id)
            .is_some_and(|entry| !entry.surface.is_attached())
        {
            let stale = surfaces.remove(session_id);
            if let Some(stale) = &stale {
                stale.unbind_session();
            }
            self.sessions.close(session_id);
            drop(stale);
        }
    }
}

fn validate_connect_preconditions(
    surface_attached: bool,
    session_exists: bool,
    session_id: &str,
) -> Result<(), String> {
    if !surface_attached {
        return Err(format!(
            "{SURFACE_MISSING}: create a native surface before connecting session {session_id}"
        ));
    }
    if session_exists {
        return Err(format!(
            "rdp_session_exists: session {session_id} already exists"
        ));
    }
    Ok(())
}

fn normalized_session_id(session_id: &str) -> Result<String, String> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        Err("rdp_surface_invalid_session: surface session id cannot be empty".to_owned())
    } else {
        Ok(session_id.to_owned())
    }
}

fn surface_error(error: crate::rdp_surface::SurfaceError) -> String {
    format!("rdp_surface_error: {error}")
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RdpSurfaceStatus {
    pub platform_supported: bool,
    pub session_id: String,
    pub created: bool,
    pub attached: bool,
    pub visible: bool,
    pub focused: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub dpi_horizontal: Option<u32>,
    pub dpi_vertical: Option<u32>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RdpSurfaceCapture {
    pub session_id: String,
    pub capture_id: String,
    pub frame_at: u64,
    pub width: u32,
    pub height: u32,
    pub original_width: u32,
    pub original_height: u32,
    pub data_url: String,
}

impl RdpSurfaceStatus {
    #[cfg(not(target_os = "windows"))]
    fn unsupported(session_id: String) -> Self {
        Self {
            platform_supported: false,
            session_id,
            created: false,
            attached: false,
            visible: false,
            focused: false,
            width: None,
            height: None,
            dpi_horizontal: None,
            dpi_vertical: None,
            reason: PLATFORM_UNSUPPORTED.to_owned(),
        }
    }
}

#[cfg(target_os = "windows")]
fn windows_status(
    session_id: &str,
    entry: Option<&SurfaceEntry>,
    reason: String,
) -> RdpSurfaceStatus {
    let metrics = entry.and_then(|entry| entry.surface.metrics());
    let hwnd = entry.and_then(|entry| entry.surface.native_window_handle());
    let (visible, focused) = hwnd
        .map(|raw| {
            let hwnd = HWND(raw as *mut c_void);
            unsafe {
                (
                    IsWindowVisible(hwnd).as_bool(),
                    GetForegroundWindow() == hwnd,
                )
            }
        })
        .unwrap_or((false, false));
    RdpSurfaceStatus {
        platform_supported: true,
        session_id: session_id.to_owned(),
        created: entry.is_some(),
        attached: hwnd.is_some(),
        visible,
        focused,
        width: metrics.map(|value| value.size.width),
        height: metrics.map(|value| value.size.height),
        dpi_horizontal: metrics.map(|value| value.dpi.horizontal),
        dpi_vertical: metrics.map(|value| value.dpi.vertical),
        reason,
    }
}

#[cfg(target_os = "windows")]
fn window_handle(entry: &SurfaceEntry) -> Result<HWND, String> {
    entry
        .surface
        .native_window_handle()
        .map(|raw| HWND(raw as *mut c_void))
        .ok_or_else(|| format!("{SURFACE_MISSING}: native window is no longer attached"))
}

#[cfg(target_os = "windows")]
fn encode_capture(session_id: &str, frame: CapturedBgraFrame) -> Result<RdpSurfaceCapture, String> {
    let original = frame.original_size;
    let width = frame.size.width;
    let height = frame.size.height;
    let rgba_len = usize::try_from(width)
        .ok()
        .and_then(|value| value.checked_mul(usize::try_from(height).ok()?))
        .and_then(|value| value.checked_mul(4))
        .ok_or_else(|| "rdp_surface_capture_too_large: capture buffer overflow".to_owned())?;
    let mut rgba = vec![0u8; rgba_len];
    if frame.pixels.len() != rgba_len {
        return Err("rdp_surface_capture_invalid: native frame length mismatch".to_owned());
    }
    for (bgra, output) in frame.pixels.chunks_exact(4).zip(rgba.chunks_exact_mut(4)) {
        output[0] = bgra[2];
        output[1] = bgra[1];
        output[2] = bgra[0];
        output[3] = 0xff;
    }

    let mut encoded = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut encoded, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|error| format!("rdp_surface_capture_encode_failed: {error}"))?;
        writer
            .write_image_data(&rgba)
            .map_err(|error| format!("rdp_surface_capture_encode_failed: {error}"))?;
    }
    let data_url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(encoded)
    );
    Ok(RdpSurfaceCapture {
        session_id: session_id.to_owned(),
        // The Node ledger already scopes this opaque id by user/run/tab. Keep
        // it below the public 160-byte schema even when session_id is maximal.
        capture_id: format!("native:{}:{width}:{height}", frame.revision),
        frame_at: frame.frame_at_ms,
        width,
        height,
        original_width: original.width,
        original_height: original.height,
        data_url,
    })
}

#[tauri::command]
pub fn rdp_native_surface_create(
    window: tauri::WebviewWindow,
    broker: State<'_, Arc<rdp::broker::NativeRdpBroker>>,
    state: State<'_, Arc<NativeRdpSurfaceState>>,
    session_id: String,
    width: u32,
    height: u32,
    dpi: Option<u32>,
    title: Option<String>,
    visible: Option<bool>,
) -> Result<RdpSurfaceStatus, String> {
    broker.claim_surface(window.label(), &session_id)?;
    #[cfg(target_os = "windows")]
    {
        let result = state.create_surface(
            &session_id,
            width,
            height,
            dpi.unwrap_or(96),
            title,
            visible.unwrap_or(true),
        );
        if result.is_err() {
            broker.release_reserved(window.label(), &session_id);
        }
        result
    }
    #[cfg(not(target_os = "windows"))]
    {
        broker.release_reserved(window.label(), &session_id);
        let _ = (state, session_id, width, height, dpi, title, visible);
        Err(PLATFORM_UNSUPPORTED.to_owned())
    }
}

#[tauri::command]
pub fn rdp_native_surface_show(
    window: tauri::WebviewWindow,
    broker: State<'_, Arc<rdp::broker::NativeRdpBroker>>,
    state: State<'_, Arc<NativeRdpSurfaceState>>,
    session_id: String,
) -> Result<RdpSurfaceStatus, String> {
    broker.assert_surface_owner(window.label(), &session_id)?;
    #[cfg(target_os = "windows")]
    {
        state.show_surface(&session_id)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (state, session_id);
        Err(PLATFORM_UNSUPPORTED.to_owned())
    }
}

#[tauri::command]
pub fn rdp_native_surface_close(
    window: tauri::WebviewWindow,
    broker: State<'_, Arc<rdp::broker::NativeRdpBroker>>,
    state: State<'_, Arc<NativeRdpSurfaceState>>,
    session_id: String,
) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        broker.close_owned(window.label(), &session_id, || {
            state.close_surface(&session_id)
        })?
    }
    #[cfg(not(target_os = "windows"))]
    {
        broker.close_owned(window.label(), &session_id, || {
            let _ = state;
            Err(PLATFORM_UNSUPPORTED.to_owned())
        })?
    }
}

#[tauri::command]
pub fn rdp_native_surface_resize(
    window: tauri::WebviewWindow,
    broker: State<'_, Arc<rdp::broker::NativeRdpBroker>>,
    state: State<'_, Arc<NativeRdpSurfaceState>>,
    session_id: String,
    width: u32,
    height: u32,
) -> Result<RdpSurfaceStatus, String> {
    broker.assert_surface_owner(window.label(), &session_id)?;
    #[cfg(target_os = "windows")]
    {
        state.resize_surface(&session_id, width, height)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (state, session_id, width, height);
        Err(PLATFORM_UNSUPPORTED.to_owned())
    }
}

#[tauri::command]
pub fn rdp_native_surface_focus(
    window: tauri::WebviewWindow,
    broker: State<'_, Arc<rdp::broker::NativeRdpBroker>>,
    state: State<'_, Arc<NativeRdpSurfaceState>>,
    session_id: String,
) -> Result<RdpSurfaceStatus, String> {
    broker.assert_surface_owner(window.label(), &session_id)?;
    #[cfg(target_os = "windows")]
    {
        state.focus_surface(&session_id)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (state, session_id);
        Err(PLATFORM_UNSUPPORTED.to_owned())
    }
}

#[tauri::command]
pub fn rdp_native_surface_status(
    window: tauri::WebviewWindow,
    broker: State<'_, Arc<rdp::broker::NativeRdpBroker>>,
    state: State<'_, Arc<NativeRdpSurfaceState>>,
    session_id: String,
) -> Result<RdpSurfaceStatus, String> {
    broker.assert_owner_or_unclaimed(window.label(), &session_id)?;
    #[cfg(target_os = "windows")]
    {
        Ok(state.surface_status(&session_id))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = state;
        Ok(RdpSurfaceStatus::unsupported(session_id))
    }
}

#[tauri::command]
pub fn rdp_native_surface_capture(
    window: tauri::WebviewWindow,
    broker: State<'_, Arc<rdp::broker::NativeRdpBroker>>,
    state: State<'_, Arc<NativeRdpSurfaceState>>,
    session_id: String,
    max_width: Option<u32>,
) -> Result<RdpSurfaceCapture, String> {
    broker.assert_active_owner(window.label(), &session_id)?;
    #[cfg(target_os = "windows")]
    {
        let frame =
            state.capture_surface(&session_id, max_width.unwrap_or(960).clamp(320, 1920))?;
        encode_capture(&session_id, frame)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (state, session_id, max_width);
        Err(PLATFORM_UNSUPPORTED.to_owned())
    }
}

const BRIDGE_CAPTURE_TTL: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct RdpBridgeState {
    captures: Mutex<HashMap<String, BridgeCaptureTicket>>,
}

impl RdpBridgeState {
    pub fn clear_owner_captures(&self, owner_label: &str) {
        let prefix = format!("{owner_label}\0");
        self.captures
            .lock()
            .retain(|key, _| !key.starts_with(&prefix));
    }
}

struct BridgeCaptureTicket {
    capture_id: String,
    original_width: u32,
    original_height: u32,
    expires_at: Instant,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RdpBridgeRequest {
    action: String,
    #[serde(default)]
    payload: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BridgeSessionRequest {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BridgeOpenRequest {
    session_id: String,
    connection_id: String,
    width: u32,
    height: u32,
    dpi: Option<u32>,
    title: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BridgeResizeRequest {
    session_id: String,
    width: u32,
    height: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BridgeCaptureRequest {
    session_id: String,
    max_width: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BridgeInputRequest {
    session_id: String,
    capture_id: String,
    control: String,
    text: Option<String>,
    x: Option<u32>,
    y: Option<u32>,
    button: Option<u8>,
}

fn bridge_payload<T: serde::de::DeserializeOwned>(payload: serde_json::Value) -> Result<T, String> {
    serde_json::from_value(payload).map_err(|error| format!("rdp_bridge_invalid_payload: {error}"))
}

fn bridge_capture_key(owner: &str, session_id: &str) -> String {
    format!("{owner}\0{session_id}")
}

fn bridge_snapshot(
    owner: &str,
    session_id: &str,
    broker: &rdp::broker::NativeRdpBroker,
    sessions: &rdp::SessionRegistry,
    state: &NativeRdpSurfaceState,
) -> Result<serde_json::Value, String> {
    broker.assert_owner_or_unclaimed(owner, session_id)?;
    #[cfg(target_os = "windows")]
    let surface = state.surface_status(session_id);
    #[cfg(not(target_os = "windows"))]
    let surface = RdpSurfaceStatus::unsupported(session_id.to_owned());
    let session = if broker.assert_active_owner(owner, session_id).is_ok() {
        sessions.get(session_id).map(|handle| {
            let telemetry = state.telemetry(session_id);
            serde_json::json!({
                "sessionId": session_id,
                "live": handle.is_live(),
                "stopping": handle.is_stopping(),
                "frames": telemetry.frames,
                "bytes": telemetry.bytes,
                "events": telemetry.events,
            })
        })
    } else {
        None
    };
    let phase = if !surface.created {
        "closed"
    } else if !surface.attached {
        "surface-detached"
    } else if session
        .as_ref()
        .and_then(|value| value.get("live"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        "connected"
    } else {
        "disconnected"
    };
    Ok(serde_json::json!({ "surface": surface, "session": session, "phase": phase }))
}

#[tauri::command]
pub fn rdp_bridge(
    app: AppHandle,
    window: tauri::WebviewWindow,
    broker: State<'_, Arc<rdp::broker::NativeRdpBroker>>,
    sessions: State<'_, Arc<rdp::SessionRegistry>>,
    surfaces: State<'_, Arc<NativeRdpSurfaceState>>,
    bridge: State<'_, RdpBridgeState>,
    request: RdpBridgeRequest,
) -> Result<serde_json::Value, String> {
    runtime::authorize_local_app_window(&window)?;
    let owner = window.label();
    match request.action.as_str() {
        "capabilities" => {
            let engine = super::rdp_native_capabilities();
            Ok(serde_json::json!({
                "available": engine.available && cfg!(target_os = "windows"),
                "platformSupported": cfg!(target_os = "windows"),
                "freerdpMajor": engine.freerdp_major,
                "clipboardAvailable": engine.clipboard_available,
                "folderMappingAvailable": false,
                "reason": engine.reason,
            }))
        }
        "open" => {
            let mut payload: BridgeOpenRequest = bridge_payload(request.payload)?;
            let dpi = payload.dpi.unwrap_or(96);
            if !(320..=8192).contains(&payload.width)
                || !(240..=8192).contains(&payload.height)
                || !(72..=480).contains(&dpi)
            {
                return Err(
                    "rdp_bridge_invalid_payload: dimensions or DPI are outside the supported range"
                        .into(),
                );
            }
            if payload
                .title
                .as_ref()
                .is_some_and(|title| title.len() > 160)
            {
                return Err("rdp_bridge_invalid_payload: title is too long".into());
            }
            payload.title = payload.title.map(|title| title.trim().to_owned());
            #[cfg(not(target_os = "windows"))]
            {
                let _ = (app, broker, sessions, surfaces, bridge, payload);
                Err(PLATFORM_UNSUPPORTED.to_owned())
            }
            #[cfg(target_os = "windows")]
            {
                broker.claim_surface(owner, &payload.session_id)?;
                let created = surfaces.create_surface(
                    &payload.session_id,
                    payload.width,
                    payload.height,
                    dpi,
                    payload.title,
                    true,
                );
                if let Err(error) = created {
                    broker.release_reserved(owner, &payload.session_id);
                    return Err(error);
                }
                let connect = super::connect_native_rdp(
                    &app,
                    owner,
                    &broker,
                    &surfaces,
                    super::RdpConnectRequest {
                        connection_id: payload.connection_id,
                        session_id: payload.session_id.clone(),
                        width: Some(payload.width),
                        height: Some(payload.height),
                    },
                );
                if let Err(error) = connect {
                    let _ = broker.close_owned(owner, &payload.session_id, || {
                        surfaces.close_surface(&payload.session_id)
                    });
                    return Err(error);
                }
                let _ = surfaces.focus_surface(&payload.session_id);
                bridge_snapshot(owner, &payload.session_id, &broker, &sessions, &surfaces)
            }
        }
        "status" => {
            let payload: BridgeSessionRequest = bridge_payload(request.payload)?;
            bridge_snapshot(owner, &payload.session_id, &broker, &sessions, &surfaces)
        }
        "show" | "focus" => {
            let payload: BridgeSessionRequest = bridge_payload(request.payload)?;
            broker.assert_surface_owner(owner, &payload.session_id)?;
            #[cfg(target_os = "windows")]
            if request.action == "show" {
                surfaces.show_surface(&payload.session_id)?;
            } else {
                surfaces.focus_surface(&payload.session_id)?;
            }
            #[cfg(not(target_os = "windows"))]
            return Err(PLATFORM_UNSUPPORTED.to_owned());
            bridge_snapshot(owner, &payload.session_id, &broker, &sessions, &surfaces)
        }
        "resize" => {
            let payload: BridgeResizeRequest = bridge_payload(request.payload)?;
            if !(320..=8192).contains(&payload.width) || !(240..=8192).contains(&payload.height) {
                return Err(
                    "rdp_bridge_invalid_payload: resize is outside the supported range".into(),
                );
            }
            broker.assert_surface_owner(owner, &payload.session_id)?;
            #[cfg(target_os = "windows")]
            surfaces.resize_surface(&payload.session_id, payload.width, payload.height)?;
            #[cfg(not(target_os = "windows"))]
            return Err(PLATFORM_UNSUPPORTED.to_owned());
            bridge_snapshot(owner, &payload.session_id, &broker, &sessions, &surfaces)
        }
        "capture" => {
            let payload: BridgeCaptureRequest = bridge_payload(request.payload)?;
            broker.assert_active_owner(owner, &payload.session_id)?;
            #[cfg(not(target_os = "windows"))]
            return Err(PLATFORM_UNSUPPORTED.to_owned());
            #[cfg(target_os = "windows")]
            {
                let frame = surfaces.capture_surface(
                    &payload.session_id,
                    payload.max_width.unwrap_or(960).clamp(320, 1920),
                )?;
                let capture = encode_capture(&payload.session_id, frame)?;
                bridge.captures.lock().insert(
                    bridge_capture_key(owner, &payload.session_id),
                    BridgeCaptureTicket {
                        capture_id: capture.capture_id.clone(),
                        original_width: capture.original_width,
                        original_height: capture.original_height,
                        expires_at: Instant::now() + BRIDGE_CAPTURE_TTL,
                    },
                );
                serde_json::to_value(capture)
                    .map_err(|error| format!("rdp_bridge_capture_encode_failed: {error}"))
            }
        }
        "input" => {
            let payload: BridgeInputRequest = bridge_payload(request.payload)?;
            broker.assert_active_owner(owner, &payload.session_id)?;
            let ticket = bridge
                .captures
                .lock()
                .remove(&bridge_capture_key(owner, &payload.session_id))
                .ok_or_else(|| {
                    "rdp_bridge_stale_capture: capture is missing or was used".to_owned()
                })?;
            if ticket.expires_at <= Instant::now() || ticket.capture_id != payload.capture_id {
                return Err("rdp_bridge_stale_capture: capture expired or does not match".into());
            }
            let handle = sessions.get(&payload.session_id).ok_or_else(|| {
                "rdp_bridge_session_missing: native session is unavailable".to_owned()
            })?;
            match payload.control.as_str() {
                "text" | "clipboard_send" => {
                    let text = payload.text.unwrap_or_default();
                    if text.is_empty() || text.len() > 32_768 {
                        return Err("rdp_bridge_invalid_input: text length is invalid".into());
                    }
                    for unit in text.encode_utf16() {
                        handle.send_unicode(0, unit);
                        handle.send_unicode(0x8000, unit);
                    }
                    Ok(
                        serde_json::json!({ "ok": true, "control": payload.control, "length": text.encode_utf16().count() }),
                    )
                }
                "mouse_click" => {
                    let (x, y) = (payload.x.unwrap_or(u32::MAX), payload.y.unwrap_or(u32::MAX));
                    if x >= ticket.original_width
                        || y >= ticket.original_height
                        || x > u16::MAX as u32
                        || y > u16::MAX as u32
                    {
                        return Err(
                            "rdp_bridge_invalid_input: click is outside the captured surface"
                                .into(),
                        );
                    }
                    let button_flag = match payload.button.unwrap_or(1) {
                        1 => 0x1000,
                        2 => 0x4000,
                        3 => 0x2000,
                        _ => return Err("rdp_bridge_invalid_input: mouse button is invalid".into()),
                    };
                    handle.send_mouse(0x0800, x as u16, y as u16);
                    handle.send_mouse(button_flag | 0x8000, x as u16, y as u16);
                    std::thread::sleep(Duration::from_millis(45));
                    handle.send_mouse(button_flag, x as u16, y as u16);
                    Ok(serde_json::json!({ "ok": true, "control": "mouse_click", "x": x, "y": y }))
                }
                _ => Err("rdp_bridge_invalid_input: unsupported input action".into()),
            }
        }
        "close" => {
            let payload: BridgeSessionRequest = bridge_payload(request.payload)?;
            bridge
                .captures
                .lock()
                .remove(&bridge_capture_key(owner, &payload.session_id));
            #[cfg(target_os = "windows")]
            let closed = broker.close_owned(owner, &payload.session_id, || {
                surfaces.close_surface(&payload.session_id)
            })??;
            #[cfg(not(target_os = "windows"))]
            let closed = broker.close_owned(owner, &payload.session_id, || {
                surfaces.disconnect_session(&payload.session_id)
            })?;
            Ok(serde_json::json!({ "closed": closed, "phase": "closed" }))
        }
        _ => Err("rdp_bridge_invalid_action: unsupported native RDP action".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_capture_cleanup_is_scoped_to_the_window_owner() {
        let bridge = RdpBridgeState::default();
        let ticket = |capture_id: &str| BridgeCaptureTicket {
            capture_id: capture_id.to_owned(),
            original_width: 1,
            original_height: 1,
            expires_at: Instant::now() + Duration::from_secs(1),
        };
        bridge
            .captures
            .lock()
            .insert(bridge_capture_key("local-app", "one"), ticket("one"));
        bridge
            .captures
            .lock()
            .insert(bridge_capture_key("other", "two"), ticket("two"));

        bridge.clear_owner_captures("local-app");

        let captures = bridge.captures.lock();
        assert!(!captures.contains_key(&bridge_capture_key("local-app", "one")));
        assert!(captures.contains_key(&bridge_capture_key("other", "two")));
    }

    #[test]
    fn connect_preconditions_reject_missing_surface_and_duplicate_session() {
        assert!(validate_connect_preconditions(false, false, "missing")
            .unwrap_err()
            .starts_with(SURFACE_MISSING));
        assert!(validate_connect_preconditions(true, true, "duplicate")
            .unwrap_err()
            .starts_with("rdp_session_exists"));
        assert!(validate_connect_preconditions(true, false, "ready").is_ok());
    }

    #[test]
    fn status_serialization_contains_metadata_but_no_frame_payload() {
        let status = RdpSurfaceStatus {
            platform_supported: true,
            session_id: "session".to_owned(),
            created: true,
            attached: true,
            visible: false,
            focused: false,
            width: Some(1280),
            height: Some(720),
            dpi_horizontal: Some(96),
            dpi_vertical: Some(96),
            reason: String::new(),
        };
        let value = serde_json::to_value(status).unwrap();
        assert_eq!(value["sessionId"], "session");
        assert_eq!(value["dpiHorizontal"], 96);
        assert!(value.get("pixels").is_none());
        assert!(value.get("frame").is_none());
        assert!(value.get("data").is_none());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn owner_capture_encoder_returns_bounded_png_metadata() {
        let capture = encode_capture(
            "session",
            CapturedBgraFrame {
                size: PixelSize::new(2, 1),
                original_size: PixelSize::new(4, 2),
                revision: 7,
                frame_at_ms: 12345,
                pixels: vec![1, 2, 3, 0, 4, 5, 6, 0],
            },
        )
        .unwrap();
        assert_eq!(capture.capture_id, "native:7:2:1");
        assert_eq!(capture.frame_at, 12345);
        assert_eq!((capture.width, capture.height), (2, 1));
        assert_eq!((capture.original_width, capture.original_height), (4, 2));
        assert!(capture.data_url.starts_with("data:image/png;base64,iVBOR"));
    }

    #[test]
    fn clipboard_event_telemetry_never_retains_or_serializes_the_payload() {
        struct NoopSink;

        impl FrameSink for NoopSink {
            fn frame(&self, _rect: FrameRect<'_>) {}

            fn event(&self, _event: SessionEvent) {}
        }

        const SECRET: &str = "clipboard-secret-must-not-cross-ipc";
        let telemetry = Arc::new(SessionTelemetry::default());
        let active = Arc::new(Mutex::new(true));
        let sink = AttachedSurfaceSink {
            surface: Arc::new(NoopSink),
            telemetry: telemetry.clone(),
            active: active.clone(),
            #[cfg(target_os = "windows")]
            native_surface: create_windows_surface(WindowsSurfaceConfig::default()),
        };
        sink.event(SessionEvent::Clipboard(SECRET.to_owned()));
        *active.lock() = false;
        sink.event(SessionEvent::Clipboard("clipboard-after-unbind".to_owned()));

        let snapshot = telemetry.snapshot();
        assert_eq!(snapshot.events, ["Clipboard"]);
        let serialized = serde_json::to_string(&snapshot.events).unwrap();
        assert!(!serialized.contains(SECRET));
        assert!(!serialized.contains("clipboard-after-unbind"));
    }

    #[cfg(target_os = "windows")]
    fn state() -> Arc<NativeRdpSurfaceState> {
        let sessions = Arc::new(rdp::SessionRegistry::new());
        let registry = Arc::new(NativeRdpSurfaceRegistry::new(sessions.clone()));
        Arc::new(NativeRdpSurfaceState::new(sessions, registry))
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn duplicate_create_is_rejected_and_missing_operations_are_explicit() {
        let state = state();
        state
            .create_surface("same", 32, 24, 96, None, false)
            .unwrap();
        assert!(state
            .create_surface("same", 32, 24, 96, None, false)
            .unwrap_err()
            .starts_with(SURFACE_EXISTS));
        assert!(state
            .resize_surface("missing", 10, 10)
            .unwrap_err()
            .starts_with(SURFACE_MISSING));
        assert!(state.close_surface("same").unwrap());
    }

    #[cfg(all(target_os = "windows", not(zephyr_native_rdp)))]
    #[test]
    fn connect_uses_an_attached_surface_before_reporting_engine_unavailable() {
        let state = state();
        let missing = state
            .start_session("missing", rdp::Config::default())
            .unwrap_err();
        assert!(missing.starts_with(SURFACE_MISSING));

        state
            .create_surface("attached", 32, 24, 96, None, false)
            .unwrap();
        let unavailable = state
            .start_session("attached", rdp::Config::default())
            .unwrap_err();
        assert!(unavailable.starts_with("native_rdp_unavailable"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn disconnect_and_surface_close_are_race_safe() {
        use std::sync::Barrier;

        let state = state();
        state
            .create_surface("race", 32, 24, 96, None, false)
            .unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let disconnect_state = state.clone();
        let disconnect_barrier = barrier.clone();
        let disconnect = std::thread::spawn(move || {
            disconnect_barrier.wait();
            disconnect_state.disconnect_session("race")
        });
        let close_state = state.clone();
        let close_barrier = barrier.clone();
        let close = std::thread::spawn(move || {
            close_barrier.wait();
            close_state.close_surface("race").unwrap()
        });
        barrier.wait();

        let _disconnected = disconnect.join().unwrap();
        let _closed = close.join().unwrap();
        let status = state.surface_status("race");
        assert!(!status.created);
        assert!(!status.attached);
        assert!(!state.registry.is_attached("race"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn os_window_close_is_reconciled_without_leaving_an_attachment() {
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{SendMessageW, WM_CLOSE};

        let state = state();
        state
            .create_surface("window-close", 32, 24, 96, None, false)
            .unwrap();
        let surface = state
            .surfaces
            .lock()
            .get("window-close")
            .unwrap()
            .surface
            .clone();
        let hwnd = HWND(surface.native_window_handle().unwrap() as *mut c_void);
        unsafe {
            SendMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0));
        }
        for _ in 0..100 {
            if !surface.is_attached() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }

        assert_eq!(state.reap_closed_surfaces(), 1);
        assert!(!state.registry.is_attached("window-close"));
        assert!(!state.surface_status("window-close").created);
    }
}
