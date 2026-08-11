//! Win32 CPU presentation surface for in-process FreeRDP frames.
//!
//! Each surface owns a small Win32 UI thread. FreeRDP callbacks only copy BGRA
//! rows into the Rust backing store and invalidate the corresponding client
//! area; `WM_PAINT` is the sole path that reads pixels into GDI. Keeping the
//! backing store after paint is what makes exposure and occlusion repainting
//! correct without asking JavaScript or the remote host for cached pixels.

use std::ffi::c_void;
use std::mem::size_of;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use windows::core::{w, Error as WindowsError, PCWSTR};
use windows::Win32::Foundation::{BOOL, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, EndPaint, InvalidateRect, StretchDIBits, UpdateWindow, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, PAINTSTRUCT, SRCCOPY,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::AdjustWindowRectExForDpi;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect, GetMessageW,
    GetWindowLongPtrW, LoadCursorW, PostQuitMessage, RegisterClassExW, SendMessageW,
    SetWindowLongPtrW, SetWindowPos, ShowWindow, TranslateMessage, CREATESTRUCTW, CS_HREDRAW,
    CS_VREDRAW, CW_USEDEFAULT, GWLP_USERDATA, IDC_ARROW, MSG, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOZORDER, SW_SHOW, WINDOW_EX_STYLE, WM_APP, WM_CLOSE, WM_DESTROY, WM_DPICHANGED,
    WM_ERASEBKGND, WM_NCCREATE, WM_NCDESTROY, WM_PAINT, WM_SIZE, WNDCLASSEXW, WS_OVERLAPPEDWINDOW,
};

use super::windows_input::{WindowsInputBridge, WindowsWindowInput};
use super::{
    validate_dpi, validate_frame, validate_metrics, validate_size, DirtyRect, NativeRdpSurface,
    PixelSize, SurfaceDpi, SurfaceError, SurfaceFrame, SurfaceMetrics, SurfaceResult,
};
use crate::rdp::SessionHandle;

const WINDOW_CLASS: PCWSTR = w!("ZephyrOne.NativeRdpSurface");
const BGRA_BYTES_PER_PIXEL: usize = 4;
const WM_ZEPHYR_DESTROY: u32 = WM_APP + 0x5a;

/// Configuration for the independent native RDP window.
///
/// The window is created lazily by [`NativeRdpSurface::attached`], when the
/// registry has supplied the remote framebuffer dimensions. Keeping creation
/// behind this small type gives commands a stable seam without exposing Win32
/// types or pixels at the Tauri/JavaScript boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsSurfaceConfig {
    pub title: String,
    pub visible: bool,
}

impl Default for WindowsSurfaceConfig {
    fn default() -> Self {
        Self {
            title: "Zephyr One Remote Desktop".to_owned(),
            visible: true,
        }
    }
}

/// Construct a native surface suitable for
/// [`super::NativeRdpSurfaceRegistry::attach`].
///
/// This function does not create a WebView, serialize pixels, or start any RDP
/// engine. The registry's `attached` callback creates the Win32 window and its
/// dedicated message thread.
pub fn create_windows_surface(config: WindowsSurfaceConfig) -> Arc<WindowsRdpSurface> {
    Arc::new(WindowsRdpSurface::new(config))
}

/// A standalone Win32 RDP surface backed by a top-down 32-bit DIB.
pub struct WindowsRdpSurface {
    config: WindowsSurfaceConfig,
    framebuffer: Arc<Mutex<Framebuffer>>,
    input: Arc<WindowsInputBridge>,
    lifecycle: Mutex<Option<SurfaceThread>>,
    alive: Arc<AtomicBool>,
    hwnd: AtomicIsize,
}

/// An owner-authorized copy of the current native FreeRDP backing store.
///
/// This type stays inside Rust. The Tauri command encodes it before crossing
/// IPC, so JavaScript never receives mutable/native framebuffer memory.
pub struct CapturedBgraFrame {
    pub size: PixelSize,
    pub original_size: PixelSize,
    pub revision: u64,
    pub frame_at_ms: u64,
    pub pixels: Vec<u8>,
}

struct SurfaceThread {
    hwnd: isize,
    shutdown_token: usize,
    join: JoinHandle<()>,
}

impl WindowsRdpSurface {
    pub fn new(config: WindowsSurfaceConfig) -> Self {
        Self {
            config,
            framebuffer: Arc::new(Mutex::new(Framebuffer::empty())),
            input: Arc::new(WindowsInputBridge::new()),
            lifecycle: Mutex::new(None),
            alive: Arc::new(AtomicBool::new(false)),
            hwnd: AtomicIsize::new(0),
        }
    }

    /// The current HWND as an opaque integer, or `None` while detached.
    ///
    /// The value is only a borrowed observation. Callers must not destroy it
    /// and must not retain it beyond the surface attachment lifetime.
    pub fn native_window_handle(&self) -> Option<isize> {
        let hwnd = self.hwnd.load(Ordering::Acquire);
        (hwnd != 0 && self.alive.load(Ordering::Acquire)).then_some(hwnd)
    }

    pub fn is_attached(&self) -> bool {
        self.native_window_handle().is_some()
    }

    pub fn metrics(&self) -> Option<SurfaceMetrics> {
        let framebuffer = self.framebuffer.lock();
        framebuffer.metrics()
    }

    pub fn capture_frame(&self, max_width: u32) -> SurfaceResult<CapturedBgraFrame> {
        self.with_running(|_| self.framebuffer.lock().capture(max_width))
    }

    /// Connect Win32 input after the FreeRDP session has been started.
    pub fn bind_session(&self, session: SessionHandle) {
        self.input.bind_session(session);
    }

    /// Immediately stop forwarding input and discard staged clipboard text.
    pub fn unbind_session(&self) {
        self.input.unbind_session();
    }

    /// Queue remote clipboard text for the surface's Win32 UI thread.
    pub fn apply_remote_clipboard(&self, text: &str) -> SurfaceResult {
        self.input.apply_remote_clipboard(text)
    }

    fn start(&self, metrics: SurfaceMetrics) -> SurfaceResult {
        validate_metrics(metrics)?;
        let mut lifecycle = self.lifecycle.lock();
        if lifecycle.is_some() {
            return Err(SurfaceError::Platform(
                "Win32 surface is already attached".to_owned(),
            ));
        }

        *self.framebuffer.lock() = Framebuffer::new(metrics)?;
        self.alive.store(false, Ordering::Release);
        self.hwnd.store(0, Ordering::Release);

        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let framebuffer = self.framebuffer.clone();
        let input = self.input.clone();
        let alive = self.alive.clone();
        let config = self.config.clone();
        let join = thread::Builder::new()
            .name("zephyr-rdp-win32".to_owned())
            .spawn(move || run_window(config, metrics, framebuffer, input, alive, ready_tx))
            .map_err(|error| {
                SurfaceError::Platform(format!("failed to start Win32 surface thread: {error}"))
            })?;

        let (raw_hwnd, shutdown_token) = match ready_rx.recv() {
            Ok(Ok(created)) => created,
            Ok(Err(error)) => {
                let _ = join.join();
                return Err(SurfaceError::Platform(error));
            }
            Err(_) => {
                let _ = join.join();
                return Err(SurfaceError::Platform(
                    "Win32 surface thread exited before creating its window".to_owned(),
                ));
            }
        };

        self.hwnd.store(raw_hwnd, Ordering::Release);
        *lifecycle = Some(SurfaceThread {
            hwnd: raw_hwnd,
            shutdown_token,
            join,
        });
        Ok(())
    }

    fn stop(&self) {
        let mut lifecycle = self.lifecycle.lock();
        let Some(surface_thread) = lifecycle.take() else {
            self.input.unbind_session();
            return;
        };

        // Clear the public handle before shutdown starts. The join below is the
        // destruction fence: after `detached` returns WM_NCDESTROY has run and
        // no paint callback can still be using the framebuffer.
        self.hwnd.store(0, Ordering::Release);
        let hwnd = hwnd_from_raw(surface_thread.hwnd);
        // The token prevents a stale, OS-reused HWND from closing an unrelated
        // window if the user closed this one just before detach got here.
        unsafe {
            SendMessageW(
                hwnd,
                WM_ZEPHYR_DESTROY,
                WPARAM(surface_thread.shutdown_token),
                LPARAM(0),
            );
        }
        let _ = surface_thread.join.join();
        self.alive.store(false, Ordering::Release);
        self.input.unbind_session();
    }

    fn with_running<T>(&self, callback: impl FnOnce(HWND) -> SurfaceResult<T>) -> SurfaceResult<T> {
        let lifecycle = self.lifecycle.lock();
        let surface_thread = lifecycle.as_ref().ok_or(SurfaceError::Detached)?;
        if !self.alive.load(Ordering::Acquire) {
            return Err(SurfaceError::Detached);
        }
        callback(hwnd_from_raw(surface_thread.hwnd))
    }
}

impl NativeRdpSurface for WindowsRdpSurface {
    fn attached(&self, metrics: SurfaceMetrics) -> SurfaceResult {
        self.start(metrics)
    }

    fn detached(&self) {
        self.stop();
    }

    fn resized(&self, size: PixelSize) -> SurfaceResult {
        validate_size(size)?;
        self.with_running(|hwnd| {
            let dpi = self
                .framebuffer
                .lock()
                .metrics()
                .ok_or(SurfaceError::Detached)?
                .dpi;
            resize_native_window(hwnd, size, dpi)?;
            self.framebuffer.lock().resize(size)?;
            self.input.set_remote_size(size);
            invalidate_all(hwnd)
        })
    }

    fn dpi_changed(&self, dpi: SurfaceDpi) -> SurfaceResult {
        validate_dpi(dpi)?;
        self.with_running(|hwnd| {
            let size = self
                .framebuffer
                .lock()
                .metrics()
                .ok_or(SurfaceError::Detached)?
                .size;
            resize_native_window(hwnd, size, dpi)?;
            self.framebuffer.lock().set_dpi(dpi)?;
            invalidate_all(hwnd)
        })
    }

    fn present(&self, frame: SurfaceFrame<'_>) -> SurfaceResult {
        self.with_running(|hwnd| {
            let rect = self.framebuffer.lock().write(frame)?;
            invalidate_dirty(hwnd, rect, self.framebuffer.lock().size())
        })
    }

    fn request_full_repaint(&self) -> SurfaceResult {
        self.with_running(invalidate_all)
    }
}

impl Drop for WindowsRdpSurface {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Debug)]
struct Framebuffer {
    metrics: Option<SurfaceMetrics>,
    pixels: Vec<u8>,
    revision: u64,
    frame_at_ms: u64,
}

impl Framebuffer {
    fn empty() -> Self {
        Self {
            metrics: None,
            pixels: Vec::new(),
            revision: 0,
            frame_at_ms: 0,
        }
    }

    fn new(metrics: SurfaceMetrics) -> SurfaceResult<Self> {
        validate_metrics(metrics)?;
        Ok(Self {
            metrics: Some(metrics),
            pixels: zeroed_bgra(metrics.size)?,
            revision: 0,
            frame_at_ms: 0,
        })
    }

    fn metrics(&self) -> Option<SurfaceMetrics> {
        self.metrics
    }

    fn size(&self) -> PixelSize {
        self.metrics
            .map(|metrics| metrics.size)
            .unwrap_or(PixelSize::new(0, 0))
    }

    fn resize(&mut self, size: PixelSize) -> SurfaceResult {
        validate_size(size)?;
        let metrics = self.metrics.as_mut().ok_or(SurfaceError::Detached)?;
        let pixels = zeroed_bgra(size)?;
        metrics.size = size;
        self.pixels = pixels;
        self.revision = 0;
        self.frame_at_ms = 0;
        Ok(())
    }

    fn set_dpi(&mut self, dpi: SurfaceDpi) -> SurfaceResult {
        validate_dpi(dpi)?;
        self.metrics.as_mut().ok_or(SurfaceError::Detached)?.dpi = dpi;
        Ok(())
    }

    fn write(&mut self, frame: SurfaceFrame<'_>) -> SurfaceResult<DirtyRect> {
        let surface = self.metrics.ok_or(SurfaceError::Detached)?.size;
        validate_frame(&frame, surface)?;

        let row_bytes = usize::try_from(frame.rect.width)
            .ok()
            .and_then(|width| width.checked_mul(BGRA_BYTES_PER_PIXEL))
            .ok_or(SurfaceError::FrameTooLarge)?;
        let surface_stride = usize::try_from(surface.width)
            .ok()
            .and_then(|width| width.checked_mul(BGRA_BYTES_PER_PIXEL))
            .ok_or(SurfaceError::FrameTooLarge)?;
        let x_bytes = usize::try_from(frame.rect.x)
            .ok()
            .and_then(|x| x.checked_mul(BGRA_BYTES_PER_PIXEL))
            .ok_or(SurfaceError::FrameTooLarge)?;

        for row in 0..usize::try_from(frame.rect.height).map_err(|_| SurfaceError::FrameTooLarge)? {
            let source_start = row
                .checked_mul(frame.stride)
                .ok_or(SurfaceError::FrameTooLarge)?;
            let source_end = source_start
                .checked_add(row_bytes)
                .ok_or(SurfaceError::FrameTooLarge)?;
            let destination_start = usize::try_from(frame.rect.y)
                .ok()
                .and_then(|y| y.checked_add(row))
                .and_then(|y| y.checked_mul(surface_stride))
                .and_then(|offset| offset.checked_add(x_bytes))
                .ok_or(SurfaceError::FrameTooLarge)?;
            let destination_end = destination_start
                .checked_add(row_bytes)
                .ok_or(SurfaceError::FrameTooLarge)?;
            self.pixels[destination_start..destination_end]
                .copy_from_slice(&frame.pixels[source_start..source_end]);
        }

        self.revision = self.revision.saturating_add(1);
        self.frame_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX);

        Ok(frame.rect)
    }

    fn capture(&self, max_width: u32) -> SurfaceResult<CapturedBgraFrame> {
        let original_size = self.metrics.ok_or(SurfaceError::Detached)?.size;
        if self.revision == 0 {
            return Err(SurfaceError::Platform(
                "native FreeRDP surface has not presented a frame".to_owned(),
            ));
        }
        let width = original_size.width.min(max_width.clamp(320, 1920));
        let height = u64::from(original_size.height)
            .checked_mul(u64::from(width))
            .and_then(|value| value.checked_add(u64::from(original_size.width) - 1))
            .and_then(|value| value.checked_div(u64::from(original_size.width)))
            .and_then(|value| u32::try_from(value).ok())
            .ok_or(SurfaceError::FrameTooLarge)?;
        let size = PixelSize::new(width, height);
        let mut pixels = zeroed_bgra(size)?;
        let source_width =
            usize::try_from(original_size.width).map_err(|_| SurfaceError::FrameTooLarge)?;
        let source_height =
            usize::try_from(original_size.height).map_err(|_| SurfaceError::FrameTooLarge)?;
        let output_width = usize::try_from(width).map_err(|_| SurfaceError::FrameTooLarge)?;
        let output_height = usize::try_from(height).map_err(|_| SurfaceError::FrameTooLarge)?;
        for y in 0..output_height {
            let source_y = y * source_height / output_height;
            for x in 0..output_width {
                let source_x = x * source_width / output_width;
                let source = (source_y * source_width + source_x) * BGRA_BYTES_PER_PIXEL;
                let output = (y * output_width + x) * BGRA_BYTES_PER_PIXEL;
                pixels[output..output + BGRA_BYTES_PER_PIXEL]
                    .copy_from_slice(&self.pixels[source..source + BGRA_BYTES_PER_PIXEL]);
            }
        }
        Ok(CapturedBgraFrame {
            size,
            original_size,
            revision: self.revision,
            frame_at_ms: self.frame_at_ms,
            pixels,
        })
    }
}

fn zeroed_bgra(size: PixelSize) -> SurfaceResult<Vec<u8>> {
    let len = usize::try_from(size.width)
        .ok()
        .and_then(|width| width.checked_mul(usize::try_from(size.height).ok()?))
        .and_then(|pixels| pixels.checked_mul(BGRA_BYTES_PER_PIXEL))
        .ok_or(SurfaceError::FrameTooLarge)?;
    let mut pixels = Vec::new();
    pixels
        .try_reserve_exact(len)
        .map_err(|_| SurfaceError::FrameTooLarge)?;
    pixels.resize(len, 0);
    Ok(pixels)
}

struct WindowContext {
    framebuffer: Arc<Mutex<Framebuffer>>,
    input: WindowsWindowInput,
    alive: Arc<AtomicBool>,
    shutdown_token: usize,
}

fn run_window(
    config: WindowsSurfaceConfig,
    metrics: SurfaceMetrics,
    framebuffer: Arc<Mutex<Framebuffer>>,
    input: Arc<WindowsInputBridge>,
    alive: Arc<AtomicBool>,
    ready: mpsc::SyncSender<Result<(isize, usize), String>>,
) {
    if let Err(error) = register_window_class() {
        let _ = ready.send(Err(error));
        return;
    }

    let instance = match unsafe { GetModuleHandleW(None) } {
        Ok(module) => HINSTANCE(module.0),
        Err(error) => {
            let _ = ready.send(Err(format!("GetModuleHandleW failed: {error}")));
            return;
        }
    };
    let (width, height) = match outer_window_extent(metrics.size, metrics.dpi) {
        Ok(extent) => extent,
        Err(error) => {
            let _ = ready.send(Err(error.to_string()));
            return;
        }
    };
    let title: Vec<u16> = config.title.encode_utf16().chain(Some(0)).collect();
    // The Arc allocation lives for the whole surface object, giving each live
    // surface a stable token distinct from any other surface.
    let shutdown_token = Arc::as_ptr(&alive) as usize;
    let context = Box::new(WindowContext {
        framebuffer,
        input: WindowsWindowInput::new(input, shutdown_token),
        alive: alive.clone(),
        shutdown_token,
    });

    let hwnd = match unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            WINDOW_CLASS,
            PCWSTR(title.as_ptr()),
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            width,
            height,
            None,
            None,
            instance,
            Some((&*context as *const WindowContext).cast::<c_void>()),
        )
    } {
        Ok(hwnd) => hwnd,
        Err(error) => {
            let _ = ready.send(Err(format!("CreateWindowExW failed: {error}")));
            return;
        }
    };

    if let Err(error) = context.input.attach(hwnd, metrics.size) {
        let _ = unsafe { DestroyWindow(hwnd) };
        let _ = ready.send(Err(error.to_string()));
        return;
    }

    alive.store(true, Ordering::Release);
    if ready.send(Ok((hwnd.0 as isize, shutdown_token))).is_err() {
        let _ = unsafe { DestroyWindow(hwnd) };
        alive.store(false, Ordering::Release);
        return;
    }
    if config.visible {
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOW);
            let _ = UpdateWindow(hwnd);
        }
    }

    let mut message = MSG::default();
    loop {
        let status = unsafe { GetMessageW(&mut message, None, 0, 0) }.0;
        if status == -1 {
            let _ = unsafe { DestroyWindow(hwnd) };
            break;
        }
        if status == 0 {
            break;
        }
        unsafe {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    alive.store(false, Ordering::Release);
    drop(context);
}

fn register_window_class() -> Result<(), String> {
    static REGISTRATION: OnceLock<Result<(), String>> = OnceLock::new();
    REGISTRATION
        .get_or_init(|| {
            let module = unsafe { GetModuleHandleW(None) }
                .map_err(|error| format!("GetModuleHandleW failed: {error}"))?;
            let cursor = unsafe { LoadCursorW(None, IDC_ARROW) }
                .map_err(|error| format!("LoadCursorW failed: {error}"))?;
            let class = WNDCLASSEXW {
                cbSize: size_of::<WNDCLASSEXW>() as u32,
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(window_proc),
                hInstance: HINSTANCE(module.0),
                hCursor: cursor,
                lpszClassName: WINDOW_CLASS,
                ..Default::default()
            };
            if unsafe { RegisterClassExW(&class) } == 0 {
                return Err(format!(
                    "RegisterClassExW failed: {}",
                    WindowsError::from_win32()
                ));
            }
            Ok(())
        })
        .clone()
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_NCCREATE {
        let create = &*(lparam.0 as *const CREATESTRUCTW);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
        return LRESULT(1);
    }

    let context = window_context(hwnd);
    if let Some(context) = context {
        if let Some(result) = context.input.handle_message(hwnd, message, wparam, lparam) {
            return result;
        }
    }
    match message {
        WM_PAINT => {
            paint(hwnd, context);
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1),
        WM_SIZE => {
            let _ = InvalidateRect(hwnd, None, BOOL(0));
            LRESULT(0)
        }
        WM_DPICHANGED => {
            if let Some(context) = context {
                let horizontal = (wparam.0 & 0xffff) as u32;
                let vertical = ((wparam.0 >> 16) & 0xffff) as u32;
                if horizontal != 0 && vertical != 0 {
                    let _ = context
                        .framebuffer
                        .lock()
                        .set_dpi(SurfaceDpi::new(horizontal, vertical));
                }
            }
            if lparam.0 != 0 {
                let suggested = &*(lparam.0 as *const RECT);
                let _ = SetWindowPos(
                    hwnd,
                    None,
                    suggested.left,
                    suggested.top,
                    suggested.right - suggested.left,
                    suggested.bottom - suggested.top,
                    SWP_NOZORDER | SWP_NOACTIVATE,
                );
            }
            LRESULT(0)
        }
        WM_CLOSE => {
            let _ = DestroyWindow(hwnd);
            LRESULT(0)
        }
        WM_ZEPHYR_DESTROY => {
            if context.is_some_and(|context| context.shutdown_token == wparam.0) {
                let _ = DestroyWindow(hwnd);
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            if let Some(context) = context {
                context.input.shutdown(hwnd);
                context.alive.store(false, Ordering::Release);
            }
            PostQuitMessage(0);
            LRESULT(0)
        }
        WM_NCDESTROY => {
            if let Some(context) = context {
                context.input.shutdown(hwnd);
            }
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            DefWindowProcW(hwnd, message, wparam, lparam)
        }
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}

unsafe fn window_context(hwnd: HWND) -> Option<&'static WindowContext> {
    let pointer = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const WindowContext;
    pointer.as_ref()
}

unsafe fn paint(hwnd: HWND, context: Option<&WindowContext>) {
    let mut paint = PAINTSTRUCT::default();
    let dc = BeginPaint(hwnd, &mut paint);
    if let Some(context) = context {
        let framebuffer = context.framebuffer.lock();
        if let Some(metrics) = framebuffer.metrics() {
            let mut client = RECT::default();
            if GetClientRect(hwnd, &mut client).is_ok() {
                let destination_width = client.right.saturating_sub(client.left);
                let destination_height = client.bottom.saturating_sub(client.top);
                if destination_width > 0 && destination_height > 0 {
                    let bitmap = bitmap_info(metrics.size);
                    StretchDIBits(
                        dc,
                        0,
                        0,
                        destination_width,
                        destination_height,
                        0,
                        0,
                        metrics.size.width as i32,
                        metrics.size.height as i32,
                        Some(framebuffer.pixels.as_ptr().cast::<c_void>()),
                        &bitmap,
                        DIB_RGB_COLORS,
                        SRCCOPY,
                    );
                }
            }
        }
    }
    let _ = EndPaint(hwnd, &paint);
}

fn bitmap_info(size: PixelSize) -> BITMAPINFO {
    let mut bitmap = BITMAPINFO::default();
    bitmap.bmiHeader = BITMAPINFOHEADER {
        biSize: size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: size.width as i32,
        // A negative height makes the DIB top-down, matching FreeRDP's rows.
        biHeight: -(size.height as i32),
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };
    bitmap
}

fn outer_window_extent(size: PixelSize, dpi: SurfaceDpi) -> SurfaceResult<(i32, i32)> {
    let width = i32::try_from(size.width).map_err(|_| SurfaceError::FrameTooLarge)?;
    let height = i32::try_from(size.height).map_err(|_| SurfaceError::FrameTooLarge)?;
    let mut rect = RECT {
        left: 0,
        top: 0,
        right: width,
        bottom: height,
    };
    unsafe {
        AdjustWindowRectExForDpi(
            &mut rect,
            WS_OVERLAPPEDWINDOW,
            false,
            WINDOW_EX_STYLE::default(),
            dpi.horizontal,
        )
    }
    .map_err(|error| platform_error("AdjustWindowRectExForDpi", error))?;
    Ok((rect.right - rect.left, rect.bottom - rect.top))
}

fn resize_native_window(hwnd: HWND, size: PixelSize, dpi: SurfaceDpi) -> SurfaceResult {
    let (width, height) = outer_window_extent(size, dpi)?;
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            width,
            height,
            SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
        )
    }
    .map_err(|error| platform_error("SetWindowPos", error))
}

fn invalidate_all(hwnd: HWND) -> SurfaceResult {
    if unsafe { InvalidateRect(hwnd, None, BOOL(0)) }.as_bool() {
        Ok(())
    } else {
        Err(platform_error("InvalidateRect", WindowsError::from_win32()))
    }
}

fn invalidate_dirty(hwnd: HWND, dirty: DirtyRect, surface: PixelSize) -> SurfaceResult {
    let mut client = RECT::default();
    unsafe { GetClientRect(hwnd, &mut client) }
        .map_err(|error| platform_error("GetClientRect", error))?;
    let client_width = client.right.saturating_sub(client.left);
    let client_height = client.bottom.saturating_sub(client.top);
    if client_width <= 0 || client_height <= 0 {
        return Ok(());
    }

    let mapped = map_dirty_rect(dirty, surface, client_width as u32, client_height as u32);
    if unsafe { InvalidateRect(hwnd, Some(&mapped), BOOL(0)) }.as_bool() {
        Ok(())
    } else {
        Err(platform_error("InvalidateRect", WindowsError::from_win32()))
    }
}

fn map_dirty_rect(
    dirty: DirtyRect,
    source: PixelSize,
    destination_width: u32,
    destination_height: u32,
) -> RECT {
    let right = dirty.x + dirty.width;
    let bottom = dirty.y + dirty.height;
    RECT {
        left: scale_floor(dirty.x, source.width, destination_width),
        top: scale_floor(dirty.y, source.height, destination_height),
        right: scale_ceil(right, source.width, destination_width),
        bottom: scale_ceil(bottom, source.height, destination_height),
    }
}

fn scale_floor(value: u32, source: u32, destination: u32) -> i32 {
    ((u64::from(value) * u64::from(destination)) / u64::from(source)) as i32
}

fn scale_ceil(value: u32, source: u32, destination: u32) -> i32 {
    let numerator = u64::from(value) * u64::from(destination);
    numerator.div_ceil(u64::from(source)) as i32
}

fn hwnd_from_raw(raw: isize) -> HWND {
    HWND(raw as *mut c_void)
}

fn platform_error(operation: &str, error: WindowsError) -> SurfaceError {
    SurfaceError::Platform(format!("{operation} failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metrics(width: u32, height: u32) -> SurfaceMetrics {
        SurfaceMetrics::new(PixelSize::new(width, height), SurfaceDpi::default())
    }

    #[test]
    fn dirty_rect_honors_source_stride_and_destination_offset() {
        let mut framebuffer = Framebuffer::new(metrics(4, 3)).unwrap();
        let pixels = [
            1, 2, 3, 4, 5, 6, 7, 8, 90, 91, 92, 93, // row + padding
            9, 10, 11, 12, 13, 14, 15, 16, 94, 95, 96, 97,
        ];
        framebuffer
            .write(SurfaceFrame {
                rect: DirtyRect::new(1, 1, 2, 2),
                stride: 12,
                pixels: &pixels,
            })
            .unwrap();

        assert_eq!(&framebuffer.pixels[20..28], &pixels[0..8]);
        assert_eq!(&framebuffer.pixels[36..44], &pixels[12..20]);
        assert!(framebuffer.pixels[..20].iter().all(|byte| *byte == 0));
        assert!(framebuffer.pixels[44..].iter().all(|byte| *byte == 0));
    }

    #[test]
    fn dirty_rect_rejects_short_stride_and_out_of_bounds_rect() {
        let mut framebuffer = Framebuffer::new(metrics(4, 3)).unwrap();
        assert_eq!(
            framebuffer.write(SurfaceFrame {
                rect: DirtyRect::new(0, 0, 2, 1),
                stride: 7,
                pixels: &[0; 8],
            }),
            Err(SurfaceError::InvalidStride {
                minimum: 8,
                actual: 7,
            })
        );
        assert_eq!(
            framebuffer.write(SurfaceFrame {
                rect: DirtyRect::new(3, 2, 2, 1),
                stride: 8,
                pixels: &[0; 8],
            }),
            Err(SurfaceError::RectOutOfBounds {
                surface_width: 4,
                surface_height: 3,
            })
        );
    }

    #[test]
    fn resize_reallocates_and_dpi_is_preserved_until_changed() {
        let initial = SurfaceMetrics::new(PixelSize::new(2, 2), SurfaceDpi::new(120, 120));
        let mut framebuffer = Framebuffer::new(initial).unwrap();
        framebuffer.pixels.fill(0xff);
        framebuffer.resize(PixelSize::new(3, 1)).unwrap();
        assert_eq!(framebuffer.pixels, vec![0; 12]);
        assert_eq!(
            framebuffer.metrics(),
            Some(SurfaceMetrics::new(
                PixelSize::new(3, 1),
                SurfaceDpi::new(120, 120)
            ))
        );
        framebuffer.set_dpi(SurfaceDpi::new(144, 168)).unwrap();
        assert_eq!(
            framebuffer.metrics().unwrap().dpi,
            SurfaceDpi::new(144, 168)
        );
    }

    #[test]
    fn dirty_invalidation_scales_outward() {
        assert_eq!(
            map_dirty_rect(DirtyRect::new(1, 1, 1, 1), PixelSize::new(3, 3), 10, 10,),
            RECT {
                left: 3,
                top: 3,
                right: 7,
                bottom: 7,
            }
        );
    }

    #[test]
    fn hidden_window_lifecycle_is_synchronous_and_idempotent() {
        let surface = WindowsRdpSurface::new(WindowsSurfaceConfig {
            visible: false,
            ..WindowsSurfaceConfig::default()
        });
        surface.attached(metrics(16, 16)).unwrap();
        assert!(surface.is_attached());
        assert_ne!(surface.native_window_handle(), None);
        surface.resized(PixelSize::new(20, 12)).unwrap();
        surface.dpi_changed(SurfaceDpi::new(144, 144)).unwrap();
        assert_eq!(
            surface.metrics(),
            Some(SurfaceMetrics::new(
                PixelSize::new(20, 12),
                SurfaceDpi::new(144, 144)
            ))
        );
        surface.request_full_repaint().unwrap();

        surface.detached();
        assert!(!surface.is_attached());
        assert_eq!(surface.request_full_repaint(), Err(SurfaceError::Detached));
        surface.detached();
    }

    #[test]
    fn user_close_before_detach_joins_the_finished_window_thread() {
        let surface = WindowsRdpSurface::new(WindowsSurfaceConfig {
            visible: false,
            ..WindowsSurfaceConfig::default()
        });
        surface.attached(metrics(16, 16)).unwrap();
        let hwnd = hwnd_from_raw(surface.native_window_handle().unwrap());

        unsafe {
            SendMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0));
        }
        assert!(!surface.is_attached());
        surface.detached();
        assert_eq!(surface.request_full_repaint(), Err(SurfaceError::Detached));
    }
}
