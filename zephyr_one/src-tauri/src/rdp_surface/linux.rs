//! X11/Cairo presentation surface for in-process FreeRDP frames.
//!
//! A surface owns a dedicated X11 connection and event thread. FreeRDP
//! callbacks copy borrowed BGRA rows into a persistent Rust backing store, then
//! synchronously ask that thread to paint the corresponding dirty rectangle.
//! Cairo reads the backing store only while its mutex is held. Pixels never
//! enter GTK, Tauri, a WebView, JavaScript, or WebAssembly.
//!
//! X11 was selected as the compatibility surface because Tauri's Linux build
//! already requires GTK 3 and therefore the X11/Cairo development libraries,
//! while XWayland covers the common Wayland desktop case. A pure Wayland
//! session without XWayland fails explicitly at attachment instead of falling
//! back to a browser renderer.

use std::ffi::{CStr, CString};
use std::mem::MaybeUninit;
use std::os::raw::c_int;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use cairo_sys as cairo;
use parking_lot::Mutex;
use x11::xlib;

use super::{
    validate_dpi, validate_frame, validate_metrics, validate_size, DirtyRect, NativeRdpSurface,
    PixelSize, SurfaceDpi, SurfaceError, SurfaceFrame, SurfaceMetrics, SurfaceResult,
};

const BGRA_BYTES_PER_PIXEL: usize = 4;
const EVENT_POLL_INTERVAL: Duration = Duration::from_millis(8);

/// Configuration for the standalone native Linux RDP window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxSurfaceConfig {
    pub title: String,
    pub visible: bool,
}

impl Default for LinuxSurfaceConfig {
    fn default() -> Self {
        Self {
            title: "Zephyr One Remote Desktop".to_owned(),
            visible: true,
        }
    }
}

/// Construct an X11/Cairo surface suitable for
/// [`super::NativeRdpSurfaceRegistry::attach`].
///
/// Window creation is deferred until [`NativeRdpSurface::attached`] supplies
/// the remote framebuffer metrics. No RDP engine or WebView is created here.
pub fn create_linux_surface(config: LinuxSurfaceConfig) -> Arc<LinuxRdpSurface> {
    Arc::new(LinuxRdpSurface::new(config))
}

/// A standalone X11 window backed by a top-down, tightly packed BGRA buffer.
pub struct LinuxRdpSurface {
    config: LinuxSurfaceConfig,
    framebuffer: Arc<Mutex<Framebuffer>>,
    lifecycle: Mutex<Option<SurfaceThread>>,
    alive: Arc<AtomicBool>,
    visible: Arc<AtomicBool>,
    focused: Arc<AtomicBool>,
    window: AtomicUsize,
}

struct SurfaceThread {
    commands: Sender<SurfaceCommand>,
    join: JoinHandle<()>,
}

type CommandReply = SyncSender<SurfaceResult>;

enum SurfaceCommand {
    Paint {
        dirty: Option<DirtyRect>,
        reply: CommandReply,
    },
    Resize {
        size: PixelSize,
        reply: CommandReply,
    },
    Show {
        reply: CommandReply,
    },
    Focus {
        reply: CommandReply,
    },
    Shutdown,
}

impl LinuxRdpSurface {
    pub fn new(config: LinuxSurfaceConfig) -> Self {
        Self {
            config,
            framebuffer: Arc::new(Mutex::new(Framebuffer::empty())),
            lifecycle: Mutex::new(None),
            alive: Arc::new(AtomicBool::new(false)),
            visible: Arc::new(AtomicBool::new(false)),
            focused: Arc::new(AtomicBool::new(false)),
            window: AtomicUsize::new(0),
        }
    }

    /// Current X11 `Window` as an opaque integer, or `None` while detached.
    ///
    /// The handle is borrowed for the current attachment lifetime. Callers
    /// must not destroy it or retain it after detachment.
    pub fn native_window_handle(&self) -> Option<usize> {
        let window = self.window.load(Ordering::Acquire);
        (window != 0 && self.alive.load(Ordering::Acquire)).then_some(window)
    }

    pub fn is_attached(&self) -> bool {
        self.native_window_handle().is_some()
    }

    pub fn is_visible(&self) -> bool {
        self.is_attached() && self.visible.load(Ordering::Acquire)
    }

    pub fn is_focused(&self) -> bool {
        self.is_attached() && self.focused.load(Ordering::Acquire)
    }

    pub fn metrics(&self) -> Option<SurfaceMetrics> {
        self.framebuffer.lock().metrics()
    }

    /// Map and raise the native window. This carries no frame data.
    pub fn show(&self) -> SurfaceResult {
        self.request(|reply| SurfaceCommand::Show { reply })
    }

    /// Ask the X server to focus and raise the native window.
    pub fn focus(&self) -> SurfaceResult {
        self.request(|reply| SurfaceCommand::Focus { reply })
    }

    fn start(&self, metrics: SurfaceMetrics) -> SurfaceResult {
        validate_metrics(metrics)?;
        native_dimensions(metrics.size)?;
        if !cfg!(target_endian = "little") {
            return Err(SurfaceError::Platform(
                "the Linux Cairo surface requires little-endian BGRA pixels".to_owned(),
            ));
        }
        let title = CString::new(self.config.title.as_str()).map_err(|_| {
            SurfaceError::Platform("native surface title contains a NUL byte".to_owned())
        })?;

        let mut lifecycle = self.lifecycle.lock();
        if lifecycle.is_some() {
            return Err(SurfaceError::Platform(
                "Linux native surface is already attached".to_owned(),
            ));
        }

        *self.framebuffer.lock() = Framebuffer::new(metrics)?;
        self.window.store(0, Ordering::Release);
        self.alive.store(false, Ordering::Release);
        self.visible.store(false, Ordering::Release);
        self.focused.store(false, Ordering::Release);

        let (commands_tx, commands_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let framebuffer = self.framebuffer.clone();
        let alive = self.alive.clone();
        let visible = self.visible.clone();
        let focused = self.focused.clone();
        let initially_visible = self.config.visible;
        let join = thread::Builder::new()
            .name("zephyr-rdp-x11".to_owned())
            .spawn(move || {
                run_window(
                    title,
                    metrics,
                    initially_visible,
                    framebuffer,
                    commands_rx,
                    ready_tx,
                    alive,
                    visible,
                    focused,
                )
            })
            .map_err(|error| {
                SurfaceError::Platform(format!("failed to start X11 surface thread: {error}"))
            })?;

        let raw_window = match ready_rx.recv() {
            Ok(Ok(raw_window)) => raw_window,
            Ok(Err(error)) => {
                let _ = join.join();
                return Err(SurfaceError::Platform(error));
            }
            Err(_) => {
                let _ = join.join();
                return Err(SurfaceError::Platform(
                    "X11 surface thread exited before creating its window".to_owned(),
                ));
            }
        };

        self.window.store(raw_window, Ordering::Release);
        *lifecycle = Some(SurfaceThread {
            commands: commands_tx,
            join,
        });
        Ok(())
    }

    fn stop(&self) {
        let mut lifecycle = self.lifecycle.lock();
        let Some(surface_thread) = lifecycle.take() else {
            return;
        };

        // Make the borrowed handle unavailable before shutdown begins. Joining
        // the X11 thread is the destruction fence: once this returns, no Cairo
        // paint can still read the backing store and the X11 window is gone.
        self.window.store(0, Ordering::Release);
        self.alive.store(false, Ordering::Release);
        self.visible.store(false, Ordering::Release);
        self.focused.store(false, Ordering::Release);
        let _ = surface_thread.commands.send(SurfaceCommand::Shutdown);
        let _ = surface_thread.join.join();
    }

    fn request(&self, command: impl FnOnce(CommandReply) -> SurfaceCommand) -> SurfaceResult {
        let lifecycle = self.lifecycle.lock();
        let surface_thread = lifecycle.as_ref().ok_or(SurfaceError::Detached)?;
        if !self.alive.load(Ordering::Acquire) {
            return Err(SurfaceError::Detached);
        }
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        surface_thread
            .commands
            .send(command(reply_tx))
            .map_err(|_| SurfaceError::Detached)?;
        reply_rx.recv().map_err(|_| SurfaceError::Detached)?
    }
}

impl NativeRdpSurface for LinuxRdpSurface {
    fn attached(&self, metrics: SurfaceMetrics) -> SurfaceResult {
        self.start(metrics)
    }

    fn detached(&self) {
        self.stop();
    }

    fn resized(&self, size: PixelSize) -> SurfaceResult {
        validate_size(size)?;
        native_dimensions(size)?;
        {
            let mut framebuffer = self.framebuffer.lock();
            framebuffer.resize(size)?;
        }
        self.request(|reply| SurfaceCommand::Resize { size, reply })
    }

    fn dpi_changed(&self, dpi: SurfaceDpi) -> SurfaceResult {
        validate_dpi(dpi)?;
        {
            let mut framebuffer = self.framebuffer.lock();
            framebuffer.set_dpi(dpi)?;
        }
        self.request(|reply| SurfaceCommand::Paint { dirty: None, reply })
    }

    fn present(&self, frame: SurfaceFrame<'_>) -> SurfaceResult {
        let dirty = self.framebuffer.lock().write(frame)?;
        self.request(|reply| SurfaceCommand::Paint {
            dirty: Some(dirty),
            reply,
        })
    }

    fn request_full_repaint(&self) -> SurfaceResult {
        self.request(|reply| SurfaceCommand::Paint { dirty: None, reply })
    }
}

impl Drop for LinuxRdpSurface {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Debug)]
struct Framebuffer {
    metrics: Option<SurfaceMetrics>,
    pixels: Vec<u8>,
}

impl Framebuffer {
    fn empty() -> Self {
        Self {
            metrics: None,
            pixels: Vec::new(),
        }
    }

    fn new(metrics: SurfaceMetrics) -> SurfaceResult<Self> {
        validate_metrics(metrics)?;
        Ok(Self {
            metrics: Some(metrics),
            pixels: zeroed_bgra(metrics.size)?,
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
        let pixels = zeroed_bgra(size)?;
        self.metrics.as_mut().ok_or(SurfaceError::Detached)?.size = size;
        self.pixels = pixels;
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
        let surface_stride = bgra_stride(surface)?;
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
        Ok(frame.rect)
    }
}

fn bgra_stride(size: PixelSize) -> SurfaceResult<usize> {
    usize::try_from(size.width)
        .ok()
        .and_then(|width| width.checked_mul(BGRA_BYTES_PER_PIXEL))
        .ok_or(SurfaceError::FrameTooLarge)
}

fn zeroed_bgra(size: PixelSize) -> SurfaceResult<Vec<u8>> {
    let len = bgra_stride(size)?
        .checked_mul(usize::try_from(size.height).map_err(|_| SurfaceError::FrameTooLarge)?)
        .ok_or(SurfaceError::FrameTooLarge)?;
    let mut pixels = Vec::new();
    pixels
        .try_reserve_exact(len)
        .map_err(|_| SurfaceError::FrameTooLarge)?;
    pixels.resize(len, 0);
    Ok(pixels)
}

fn native_dimensions(size: PixelSize) -> SurfaceResult<(c_int, c_int)> {
    let width = c_int::try_from(size.width).map_err(|_| SurfaceError::FrameTooLarge)?;
    let height = c_int::try_from(size.height).map_err(|_| SurfaceError::FrameTooLarge)?;
    Ok((width, height))
}

#[allow(clippy::too_many_arguments)]
fn run_window(
    title: CString,
    metrics: SurfaceMetrics,
    initially_visible: bool,
    framebuffer: Arc<Mutex<Framebuffer>>,
    commands: Receiver<SurfaceCommand>,
    ready: SyncSender<Result<usize, String>>,
    alive: Arc<AtomicBool>,
    visible: Arc<AtomicBool>,
    focused: Arc<AtomicBool>,
) {
    let result = unsafe {
        run_x11_window(
            &title,
            metrics,
            initially_visible,
            &framebuffer,
            &commands,
            &ready,
            &alive,
            &visible,
            &focused,
        )
    };
    alive.store(false, Ordering::Release);
    visible.store(false, Ordering::Release);
    focused.store(false, Ordering::Release);
    if let Err(error) = result {
        let _ = ready.send(Err(error));
    }
}

#[allow(clippy::too_many_arguments)]
unsafe fn run_x11_window(
    title: &CStr,
    metrics: SurfaceMetrics,
    initially_visible: bool,
    framebuffer: &Arc<Mutex<Framebuffer>>,
    commands: &Receiver<SurfaceCommand>,
    ready: &SyncSender<Result<usize, String>>,
    alive: &AtomicBool,
    visible: &AtomicBool,
    focused: &AtomicBool,
) -> Result<(), String> {
    let display = xlib::XOpenDisplay(ptr::null());
    if display.is_null() {
        return Err(
            "unable to open an X11 display; pure Wayland sessions require XWayland for the native RDP surface"
                .to_owned(),
        );
    }

    let screen = xlib::XDefaultScreen(display);
    let root = xlib::XDefaultRootWindow(display);
    let visual = xlib::XDefaultVisual(display, screen);
    let (initial_width, initial_height) =
        native_dimensions(metrics.size).map_err(|error| error.to_string())?;
    let window = xlib::XCreateSimpleWindow(
        display,
        root,
        0,
        0,
        initial_width as u32,
        initial_height as u32,
        0,
        xlib::XBlackPixel(display, screen),
        xlib::XBlackPixel(display, screen),
    );
    if window == 0 {
        xlib::XCloseDisplay(display);
        return Err("XCreateSimpleWindow failed".to_owned());
    }

    xlib::XStoreName(display, window, title.as_ptr());
    xlib::XSelectInput(
        display,
        window,
        xlib::ExposureMask | xlib::StructureNotifyMask | xlib::FocusChangeMask,
    );
    let delete_name = c"WM_DELETE_WINDOW";
    let mut wm_delete = xlib::XInternAtom(display, delete_name.as_ptr(), xlib::False);
    if wm_delete != 0 {
        xlib::XSetWMProtocols(display, window, &mut wm_delete, 1);
    }

    let target =
        cairo::cairo_xlib_surface_create(display, window, visual, initial_width, initial_height);
    let target_status = cairo::cairo_surface_status(target);
    if target_status != cairo::STATUS_SUCCESS {
        let error = cairo_error("failed to create Cairo Xlib surface", target_status);
        cairo::cairo_surface_destroy(target);
        xlib::XDestroyWindow(display, window);
        xlib::XCloseDisplay(display);
        return Err(error);
    }

    if initially_visible {
        xlib::XMapRaised(display, window);
        visible.store(true, Ordering::Release);
    }
    xlib::XSync(display, xlib::False);
    alive.store(true, Ordering::Release);
    if ready.send(Ok(window as usize)).is_err() {
        cairo::cairo_surface_destroy(target);
        xlib::XDestroyWindow(display, window);
        xlib::XCloseDisplay(display);
        return Ok(());
    }

    let mut destination = metrics.size;
    let mut window_destroyed = false;
    let mut running = true;
    while running {
        match commands.recv_timeout(EVENT_POLL_INTERVAL) {
            Ok(command) => {
                running = handle_command(
                    command,
                    display,
                    window,
                    target,
                    visual,
                    framebuffer,
                    &mut destination,
                    visible,
                    focused,
                );
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => running = false,
        }

        while running && xlib::XPending(display) > 0 {
            let mut event = MaybeUninit::<xlib::XEvent>::uninit();
            xlib::XNextEvent(display, event.as_mut_ptr());
            let event = event.assume_init();
            match event.get_type() {
                xlib::Expose => {
                    let _ = paint(target, framebuffer, destination, None);
                    xlib::XFlush(display);
                }
                xlib::ConfigureNotify => {
                    let configured = event.configure;
                    if configured.width > 0 && configured.height > 0 {
                        destination =
                            PixelSize::new(configured.width as u32, configured.height as u32);
                        cairo::cairo_xlib_surface_set_size(
                            target,
                            configured.width,
                            configured.height,
                        );
                        let _ = paint(target, framebuffer, destination, None);
                        xlib::XFlush(display);
                    }
                }
                xlib::MapNotify => visible.store(true, Ordering::Release),
                xlib::UnmapNotify => visible.store(false, Ordering::Release),
                xlib::FocusIn => focused.store(true, Ordering::Release),
                xlib::FocusOut => focused.store(false, Ordering::Release),
                xlib::ClientMessage
                    if wm_delete != 0
                        && event.client_message.data.get_long(0) as xlib::Atom == wm_delete =>
                {
                    alive.store(false, Ordering::Release);
                    visible.store(false, Ordering::Release);
                    focused.store(false, Ordering::Release);
                    xlib::XDestroyWindow(display, window);
                    xlib::XFlush(display);
                    window_destroyed = true;
                    running = false;
                }
                xlib::DestroyNotify => {
                    alive.store(false, Ordering::Release);
                    visible.store(false, Ordering::Release);
                    focused.store(false, Ordering::Release);
                    window_destroyed = true;
                    running = false;
                }
                _ => {}
            }
        }
    }

    alive.store(false, Ordering::Release);
    visible.store(false, Ordering::Release);
    focused.store(false, Ordering::Release);
    cairo::cairo_surface_destroy(target);
    if !window_destroyed {
        xlib::XDestroyWindow(display, window);
    }
    xlib::XSync(display, xlib::False);
    xlib::XCloseDisplay(display);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
unsafe fn handle_command(
    command: SurfaceCommand,
    display: *mut xlib::Display,
    window: xlib::Window,
    target: *mut cairo::cairo_surface_t,
    _visual: *mut xlib::Visual,
    framebuffer: &Arc<Mutex<Framebuffer>>,
    destination: &mut PixelSize,
    visible: &AtomicBool,
    focused: &AtomicBool,
) -> bool {
    match command {
        SurfaceCommand::Paint { dirty, reply } => {
            let result = paint(target, framebuffer, *destination, dirty);
            xlib::XFlush(display);
            let _ = reply.send(result);
            true
        }
        SurfaceCommand::Resize { size, reply } => {
            let result = native_dimensions(size).and_then(|(width, height)| {
                xlib::XResizeWindow(display, window, width as u32, height as u32);
                xlib::XSync(display, xlib::False);
                *destination = size;
                cairo::cairo_xlib_surface_set_size(target, width, height);
                paint(target, framebuffer, *destination, None)
            });
            let _ = reply.send(result);
            true
        }
        SurfaceCommand::Show { reply } => {
            xlib::XMapRaised(display, window);
            xlib::XFlush(display);
            visible.store(true, Ordering::Release);
            let _ = reply.send(Ok(()));
            true
        }
        SurfaceCommand::Focus { reply } => {
            xlib::XMapRaised(display, window);
            xlib::XRaiseWindow(display, window);
            xlib::XSetInputFocus(display, window, xlib::RevertToParent, xlib::CurrentTime);
            xlib::XFlush(display);
            visible.store(true, Ordering::Release);
            focused.store(true, Ordering::Release);
            let _ = reply.send(Ok(()));
            true
        }
        SurfaceCommand::Shutdown => false,
    }
}

unsafe fn paint(
    target: *mut cairo::cairo_surface_t,
    framebuffer: &Arc<Mutex<Framebuffer>>,
    destination: PixelSize,
    dirty: Option<DirtyRect>,
) -> SurfaceResult {
    let mut framebuffer = framebuffer.lock();
    let source = framebuffer.size();
    validate_size(source)?;
    let (source_width, source_height) = native_dimensions(source)?;
    let stride = c_int::try_from(bgra_stride(source)?).map_err(|_| SurfaceError::FrameTooLarge)?;
    let image = cairo::cairo_image_surface_create_for_data(
        framebuffer.pixels.as_mut_ptr(),
        cairo::FORMAT_RGB24,
        source_width,
        source_height,
        stride,
    );
    let image_status = cairo::cairo_surface_status(image);
    if image_status != cairo::STATUS_SUCCESS {
        let error = SurfaceError::Platform(cairo_error(
            "failed to create Cairo BGRA image surface",
            image_status,
        ));
        cairo::cairo_surface_destroy(image);
        return Err(error);
    }

    let context = cairo::cairo_create(target);
    let context_status = cairo::cairo_status(context);
    if context_status != cairo::STATUS_SUCCESS {
        let error = SurfaceError::Platform(cairo_error(
            "failed to create Cairo paint context",
            context_status,
        ));
        cairo::cairo_destroy(context);
        cairo::cairo_surface_destroy(image);
        return Err(error);
    }

    cairo::cairo_save(context);
    if let Some(dirty) = dirty {
        let mapped = map_dirty_rect(dirty, source, destination);
        cairo::cairo_rectangle(
            context,
            f64::from(mapped.x),
            f64::from(mapped.y),
            f64::from(mapped.width),
            f64::from(mapped.height),
        );
        cairo::cairo_clip(context);
    }
    cairo::cairo_scale(
        context,
        f64::from(destination.width) / f64::from(source.width),
        f64::from(destination.height) / f64::from(source.height),
    );
    cairo::cairo_set_operator(context, cairo::OPERATOR_SOURCE);
    cairo::cairo_set_source_surface(context, image, 0.0, 0.0);
    cairo::cairo_pattern_set_filter(cairo::cairo_get_source(context), cairo::FILTER_NEAREST);
    cairo::cairo_paint(context);
    cairo::cairo_restore(context);

    let status = cairo::cairo_status(context);
    cairo::cairo_destroy(context);
    cairo::cairo_surface_destroy(image);
    cairo::cairo_surface_flush(target);
    if status == cairo::STATUS_SUCCESS {
        Ok(())
    } else {
        Err(SurfaceError::Platform(cairo_error(
            "Cairo failed to paint the native RDP frame",
            status,
        )))
    }
}

fn map_dirty_rect(dirty: DirtyRect, source: PixelSize, destination: PixelSize) -> DirtyRect {
    let right = dirty.x + dirty.width;
    let bottom = dirty.y + dirty.height;
    let left = scale_floor(dirty.x, source.width, destination.width);
    let top = scale_floor(dirty.y, source.height, destination.height);
    let right = scale_ceil(right, source.width, destination.width);
    let bottom = scale_ceil(bottom, source.height, destination.height);
    DirtyRect::new(left, top, right - left, bottom - top)
}

fn scale_floor(value: u32, source: u32, destination: u32) -> u32 {
    ((u64::from(value) * u64::from(destination)) / u64::from(source)) as u32
}

fn scale_ceil(value: u32, source: u32, destination: u32) -> u32 {
    let numerator = u64::from(value) * u64::from(destination);
    numerator.div_ceil(u64::from(source)) as u32
}

fn cairo_error(context: &str, status: cairo::cairo_status_t) -> String {
    let detail = unsafe {
        let message = cairo::cairo_status_to_string(status);
        if message.is_null() {
            "unknown Cairo error".to_owned()
        } else {
            CStr::from_ptr(message).to_string_lossy().into_owned()
        }
    };
    format!("{context}: {detail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metrics(width: u32, height: u32) -> SurfaceMetrics {
        SurfaceMetrics::new(PixelSize::new(width, height), SurfaceDpi::default())
    }

    #[test]
    fn implements_common_native_surface_contract() {
        fn assert_surface<T: NativeRdpSurface>() {}
        assert_surface::<LinuxRdpSurface>();
    }

    #[test]
    fn dirty_rect_honors_stride_and_destination_offset() {
        let mut framebuffer = Framebuffer::new(metrics(4, 3)).unwrap();
        let pixels = [
            1, 2, 3, 4, 5, 6, 7, 8, 90, 91, 92, 93, 9, 10, 11, 12, 13, 14, 15, 16, 94, 95, 96, 97,
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
    fn dirty_rect_rejects_short_stride_and_out_of_bounds_input() {
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
    fn resize_reallocates_without_losing_dpi() {
        let initial = SurfaceMetrics::new(PixelSize::new(2, 2), SurfaceDpi::new(120, 144));
        let mut framebuffer = Framebuffer::new(initial).unwrap();
        framebuffer.pixels.fill(0xff);
        framebuffer.resize(PixelSize::new(3, 1)).unwrap();
        assert_eq!(framebuffer.pixels, vec![0; 12]);
        assert_eq!(framebuffer.metrics().unwrap().dpi, initial.dpi);
    }

    #[test]
    fn dirty_invalidation_scales_outward() {
        assert_eq!(
            map_dirty_rect(
                DirtyRect::new(1, 1, 1, 1),
                PixelSize::new(3, 3),
                PixelSize::new(10, 10),
            ),
            DirtyRect::new(3, 3, 4, 4)
        );
        assert_eq!(
            map_dirty_rect(
                DirtyRect::new(0, 0, 4, 2),
                PixelSize::new(4, 2),
                PixelSize::new(7, 5),
            ),
            DirtyRect::new(0, 0, 7, 5)
        );
    }

    #[test]
    fn detached_surface_is_idempotent_without_opening_a_display() {
        let surface = LinuxRdpSurface::new(LinuxSurfaceConfig::default());
        surface.detached();
        surface.detached();
        assert!(!surface.is_attached());
        assert_eq!(surface.request_full_repaint(), Err(SurfaceError::Detached));
    }
}
