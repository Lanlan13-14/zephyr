#![cfg_attr(doc, doc = include_str!("../README.md"))]
#![cfg_attr(
    doc,
    doc(
        html_logo_url = "https://cdnweb.devolutions.net/images/projects/devolutions/logos/devolutions-icon-shadow.svg"
    )
)]
#![allow(clippy::new_without_default)] // Default trait can’t be used by wasm consumer anyway.

// Silence the unused_crate_dependencies lint.
// These crates are added just to enable additional WASM features.
extern crate chrono as _;
extern crate getrandom as _;
extern crate getrandom2 as _;
extern crate getrandom4 as _;
extern crate time as _;

mod audio;
mod canvas;
mod drive;
mod clipboard;
mod error;
mod image;
mod input;
mod network_client;
mod printer;
mod rdp_file;
mod session;

mod wasm_bridge {
    use tracing::debug;

    struct Api;

    impl iron_remote_desktop::RemoteDesktopApi for Api {
        type Session = crate::session::Session;
        type SessionBuilder = crate::session::SessionBuilder;
        type SessionTerminationInfo = crate::session::SessionTerminationInfo;
        type DeviceEvent = crate::input::DeviceEvent;
        type InputTransaction = crate::input::InputTransaction;
        type ClipboardData = crate::clipboard::ClipboardData;
        type ClipboardItem = crate::clipboard::ClipboardItem;
        type Error = crate::error::IronError;

        fn post_setup() {
            debug!("IronRDP is ready");
        }
    }

    iron_remote_desktop::make_bridge!(Api);
}

use core::cell::RefCell;
use std::rc::Rc;
use iron_remote_desktop::{ClipboardData, DesktopSize, DeviceEvent as _, InputTransaction as _, IronError as _, RotationUnit, Session as _, SessionBuilder as _};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;

thread_local! {
    static ZEPHYR_SESSION: RefCell<Option<Rc<crate::session::Session>>> = const { RefCell::new(None) };
}

fn js_error(msg: impl core::fmt::Display) -> JsValue {
    JsValue::from_str(&msg.to_string())
}

fn with_session<F>(f: F)
where
    F: FnOnce(&crate::session::Session),
{
    ZEPHYR_SESSION.with(|cell| {
        if let Some(session) = cell.borrow().as_ref() {
            f(session);
        }
    });
}

fn send_event(event: crate::input::DeviceEvent) {
    with_session(|session| {
        let mut tx = crate::input::InputTransaction::create();
        tx.add_event(event);
        let _ = session.apply_inputs(tx);
    });
}

#[wasm_bindgen]
pub async fn rdp_connect(
    proxy_ws_url: String,
    host: String,
    port: u16,
    domain: String,
    user: String,
    password: String,
    width: u32,
    height: u32,
    _swap_alt_meta: bool,
    _mic_enabled: bool,
    _location_enabled: bool,
    _storage_enabled: bool,
    _camera_enabled: bool,
    _h264_supported: bool,
    _wallpaper: bool,
) -> Result<(), JsValue> {
    let destination = format!("{}:{}", host, port);
    let proxy_url = if proxy_ws_url.contains("/rdp-proxy") {
        proxy_ws_url
    } else {
        format!("{}/rdp-proxy?target={}", proxy_ws_url.trim_end_matches('/'), destination)
    };
    let desktop = DesktopSize::create(width as u16, height as u16);
    let session = <crate::session::SessionBuilder as iron_remote_desktop::SessionBuilder>::create()
        .username(user)
        .password(password)
        .server_domain(domain)
        .destination(destination)
        .proxy_address(proxy_url)
        .auth_token(String::new())
        .desktop_size(desktop)
        .set_cursor_style_callback(js_sys::Function::new_no_args("rdpOnCursorStyle"))
        .set_cursor_style_callback_context(JsValue::NULL)
        .remote_clipboard_changed_callback(js_sys::Function::new_no_args("rdpOnClipboard"))
        .force_clipboard_update_callback(js_sys::Function::new_no_args("rdpForceClipboardUpdate"))
        .connect()
        .await
        .map_err(|e| js_error(e.backtrace()))?;

    ZEPHYR_SESSION.with(|cell| {
        *cell.borrow_mut() = Some(Rc::new(session));
    });

    call0("rdpOnReady");
    let run_session = ZEPHYR_SESSION.with(|cell| cell.borrow().as_ref().map(Rc::clone));
    if let Some(s) = run_session {
        spawn_local(async move {
            match s.run().await {
                Ok(_) => call0("rdpOnClose"),
                Err(e) => call1("rdpOnError", &JsValue::from_str(&e.backtrace())),
            }
        });
    }
    Ok(())
}

#[wasm_bindgen]
pub fn rdp_disconnect() {
    ZEPHYR_SESSION.with(|cell| {
        if let Some(session) = cell.borrow().as_ref() {
            let _ = session.shutdown();
        }
        *cell.borrow_mut() = None;
    });
}

#[wasm_bindgen]
pub fn rdp_mouse_move(x: i32, y: i32) {
    send_event(crate::input::DeviceEvent::mouse_move(clamp_u16(x), clamp_u16(y)));
}

#[wasm_bindgen]
pub fn rdp_mouse_down(button: u8, x: i32, y: i32) {
    rdp_mouse_move(x, y);
    send_event(crate::input::DeviceEvent::mouse_button_pressed(button));
}

#[wasm_bindgen]
pub fn rdp_mouse_up(button: u8, x: i32, y: i32) {
    rdp_mouse_move(x, y);
    send_event(crate::input::DeviceEvent::mouse_button_released(button));
}

#[wasm_bindgen]
pub fn rdp_mouse_wheel(delta: i32, x: i32, y: i32) {
    rdp_mouse_move(x, y);
    let amount = delta.clamp(i16::MIN as i32, i16::MAX as i32) as i16;
    send_event(crate::input::DeviceEvent::wheel_rotations(true, amount, RotationUnit::Pixel));
}

#[wasm_bindgen]
pub fn rdp_mouse_h_scroll(delta: i32, x: i32, y: i32) {
    rdp_mouse_move(x, y);
    let amount = delta.clamp(i16::MIN as i32, i16::MAX as i32) as i16;
    send_event(crate::input::DeviceEvent::wheel_rotations(false, amount, RotationUnit::Pixel));
}

#[wasm_bindgen]
pub fn rdp_key_down(scancode: u16, _extended: bool) {
    send_event(crate::input::DeviceEvent::key_pressed(scancode));
}

#[wasm_bindgen]
pub fn rdp_key_up(scancode: u16, _extended: bool) {
    send_event(crate::input::DeviceEvent::key_released(scancode));
}

#[wasm_bindgen]
pub fn rdp_resize_display(width: u32, height: u32) {
    with_session(|session| session.resize(width, height, None, None, None));
}

#[wasm_bindgen]
pub async fn rdp_clipboard_changed(text: String) -> Result<(), JsValue> {
    let session = ZEPHYR_SESSION.with(|cell| cell.borrow().as_ref().map(Rc::clone));
    if let Some(session) = session {
        let mut data = <crate::clipboard::ClipboardData as ClipboardData>::create();
        ClipboardData::add_text(&mut data, "text/plain", &text);
        session
            .on_clipboard_paste(&data)
            .await
            .map_err(|e| js_error(e.backtrace()))?;
    }
    Ok(())
}

#[wasm_bindgen]
pub fn rdp_notify_files_changed() {}
#[wasm_bindgen]
pub fn rdp_download_server_file(_index: u32, _callback: js_sys::Function) {}
#[wasm_bindgen]
pub fn rdp_get_server_files() -> js_sys::Array { js_sys::Array::new() }
#[wasm_bindgen]
pub fn rdp_fs_attach_drive(agent_id: String, drive_name: String, read_only: bool) -> u32 {
    crate::drive::register_pending_drive(agent_id, drive_name, read_only);
    1
}
#[wasm_bindgen]
pub fn rdp_fs_detach_drive(_agent_id: String) {}
#[wasm_bindgen]
pub fn rdp_fs_list_drives() -> js_sys::Array { js_sys::Array::new() }
#[wasm_bindgen]
pub fn rdp_audin_data(_data: &[u8]) {}
#[wasm_bindgen]
pub fn rdp_location_data(_lat: f64, _lon: f64, _alt: JsValue, _accuracy: f64, _speed: JsValue, _heading: JsValue) {}
#[wasm_bindgen]
pub fn rdp_camera_frame(_data: &[u8], _is_key: bool) {}

fn clamp_u16(v: i32) -> u16 {
    v.clamp(0, u16::MAX as i32) as u16
}

fn call0(name: &str) {
    let global = js_sys::global();
    if let Ok(value) = js_sys::Reflect::get(&global, &JsValue::from_str(name)) {
        if let Ok(func) = value.dyn_into::<js_sys::Function>() {
            let _ = func.call0(&JsValue::NULL);
        }
    }
}

fn call1(name: &str, arg: &JsValue) {
    let global = js_sys::global();
    if let Ok(value) = js_sys::Reflect::get(&global, &JsValue::from_str(name)) {
        if let Ok(func) = value.dyn_into::<js_sys::Function>() {
            let _ = func.call1(&JsValue::NULL, arg);
        }
    }
}
