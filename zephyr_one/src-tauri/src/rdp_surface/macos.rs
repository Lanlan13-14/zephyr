//! AppKit/Core Graphics presentation surface for in-process FreeRDP frames.
//!
//! FreeRDP callbacks copy borrowed BGRA rows into a persistent Rust backing
//! store. AppKit only sees that store from `drawRect:` on the process main
//! thread, where a short-lived `CGImage` presents it directly. No pixel buffer
//! is exposed to Tauri, a WebView, JavaScript, or WebAssembly.

use std::collections::HashMap;
use std::ffi::{c_char, c_void, CString};
use std::mem;
use std::panic::{catch_unwind, resume_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use core_graphics::base::{
    kCGBitmapByteOrder32Little, kCGImageAlphaNoneSkipFirst, kCGRenderingIntentDefault,
};
use core_graphics::color_space::CGColorSpace;
use core_graphics::context::{CGContext, CGInterpolationQuality};
use core_graphics::data_provider::CGDataProvider;
use core_graphics::geometry::{CGPoint, CGRect, CGSize};
use core_graphics::image::CGImage;
use parking_lot::Mutex;

use super::{
    validate_dpi, validate_frame, validate_metrics, validate_size, DirtyRect, NativeRdpSurface,
    PixelSize, SurfaceDpi, SurfaceError, SurfaceFrame, SurfaceMetrics, SurfaceResult,
};

const BGRA_BYTES_PER_PIXEL: usize = 4;
const APPKIT_POINTS_PER_INCH: f64 = 72.0;
const NS_BACKING_STORE_BUFFERED: usize = 2;
const NS_WINDOW_STYLE_MASK: usize = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3);

#[repr(C)]
struct ObjcObject {
    _private: [u8; 0],
}

#[repr(C)]
struct ObjcClass {
    _private: [u8; 0],
}

#[repr(C)]
struct ObjcSelector {
    _private: [u8; 0],
}

#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {}

#[link(name = "objc")]
unsafe extern "C" {
    fn objc_getClass(name: *const c_char) -> *mut ObjcClass;
    fn objc_allocateClassPair(
        superclass: *mut ObjcClass,
        name: *const c_char,
        extra_bytes: usize,
    ) -> *mut ObjcClass;
    fn objc_disposeClassPair(class: *mut ObjcClass);
    fn objc_registerClassPair(class: *mut ObjcClass);
    fn class_addMethod(
        class: *mut ObjcClass,
        selector: *mut ObjcSelector,
        implementation: *const c_void,
        types: *const c_char,
    ) -> i8;
    fn sel_registerName(name: *const c_char) -> *mut ObjcSelector;
    fn objc_msgSend();
}

#[cfg(target_arch = "x86_64")]
#[link(name = "objc")]
unsafe extern "C" {
    fn objc_msgSend_stret();
}

#[link(name = "System")]
unsafe extern "C" {
    static _dispatch_main_q: u8;
    fn dispatch_sync_f(
        queue: *mut c_void,
        context: *mut c_void,
        work: unsafe extern "C" fn(*mut c_void),
    );
    fn pthread_main_np() -> i32;
}

/// Configuration for the standalone native RDP window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacosSurfaceConfig {
    pub title: String,
    pub visible: bool,
}

impl Default for MacosSurfaceConfig {
    fn default() -> Self {
        Self {
            title: "Zephyr One Remote Desktop".to_owned(),
            visible: true,
        }
    }
}

/// Construct an AppKit surface suitable for
/// [`super::NativeRdpSurfaceRegistry::attach`].
///
/// Window creation is deferred until the registry calls `attached`, so the
/// initial native content size and DPI arrive through the common surface seam.
pub fn create_macos_surface(config: MacosSurfaceConfig) -> Arc<MacosRdpSurface> {
    Arc::new(MacosRdpSurface::new(config))
}

/// A standalone AppKit window with a persistent top-down BGRA framebuffer.
pub struct MacosRdpSurface {
    config: MacosSurfaceConfig,
    framebuffer: Arc<Mutex<Framebuffer>>,
    lifecycle: Mutex<Option<WindowState>>,
    alive: Arc<AtomicBool>,
    backing_scale_bits: Arc<AtomicU64>,
}

#[derive(Debug, Clone, Copy)]
struct WindowState {
    window: usize,
    view: usize,
}

impl MacosRdpSurface {
    pub fn new(config: MacosSurfaceConfig) -> Self {
        Self {
            config,
            framebuffer: Arc::new(Mutex::new(Framebuffer::empty())),
            lifecycle: Mutex::new(None),
            alive: Arc::new(AtomicBool::new(false)),
            backing_scale_bits: Arc::new(AtomicU64::new(1.0_f64.to_bits())),
        }
    }

    /// The current `NSWindow *` as an opaque integer, or `None` when closed.
    /// It is borrowed for the current attachment lifetime and must not be
    /// retained or released by the caller.
    pub fn native_window_handle(&self) -> Option<usize> {
        let lifecycle = self.lifecycle.lock();
        let window = lifecycle.as_ref()?.window;
        self.alive.load(Ordering::Acquire).then_some(window)
    }

    pub fn is_attached(&self) -> bool {
        self.native_window_handle().is_some()
    }

    pub fn metrics(&self) -> Option<SurfaceMetrics> {
        self.framebuffer.lock().metrics()
    }

    /// Current AppKit backing scale. This changes when the window moves between
    /// standard and Retina displays and is independent of the remote DPI.
    pub fn backing_scale_factor(&self) -> f64 {
        f64::from_bits(self.backing_scale_bits.load(Ordering::Acquire))
    }

    fn start(&self, metrics: SurfaceMetrics) -> SurfaceResult {
        validate_metrics(metrics)?;
        let mut lifecycle = self.lifecycle.lock();
        if lifecycle.is_some() {
            return Err(SurfaceError::Platform(
                "AppKit surface is already attached".to_owned(),
            ));
        }

        *self.framebuffer.lock() = Framebuffer::new(metrics)?;
        self.alive.store(false, Ordering::Release);
        self.backing_scale_bits
            .store(1.0_f64.to_bits(), Ordering::Release);

        let config = self.config.clone();
        let context = Arc::new(ViewContext {
            framebuffer: self.framebuffer.clone(),
            alive: self.alive.clone(),
            backing_scale_bits: self.backing_scale_bits.clone(),
        });
        let created = run_on_main_sync(move || create_window(&config, metrics, context))
            .map_err(SurfaceError::Platform)?;
        *lifecycle = Some(created);
        Ok(())
    }

    fn stop(&self) {
        let mut lifecycle = self.lifecycle.lock();
        let Some(state) = lifecycle.take() else {
            return;
        };

        // Prevent new direct calls before entering the main-queue fence. When
        // this synchronous block returns, the window and its content view have
        // been closed and released, so no AppKit callback can retain a pointer
        // into this surface.
        self.alive.store(false, Ordering::Release);
        run_on_main_sync(move || destroy_window(state));
    }

    fn with_running<T>(
        &self,
        callback: impl FnOnce(WindowState) -> SurfaceResult<T>,
    ) -> SurfaceResult<T> {
        let lifecycle = self.lifecycle.lock();
        let state = *lifecycle.as_ref().ok_or(SurfaceError::Detached)?;
        if !self.alive.load(Ordering::Acquire) {
            return Err(SurfaceError::Detached);
        }
        callback(state)
    }
}

impl NativeRdpSurface for MacosRdpSurface {
    fn attached(&self, metrics: SurfaceMetrics) -> SurfaceResult {
        self.start(metrics)
    }

    fn detached(&self) {
        self.stop();
    }

    fn resized(&self, size: PixelSize) -> SurfaceResult {
        validate_size(size)?;
        self.with_running(|state| {
            let dpi = {
                let mut framebuffer = self.framebuffer.lock();
                framebuffer.resize(size)?;
                framebuffer.metrics().ok_or(SurfaceError::Detached)?.dpi
            };
            let content_size = points_for_pixels(size, dpi);
            run_on_main_sync(move || unsafe {
                msg_send_void_size(
                    state.window as *mut ObjcObject,
                    selector(c"setContentSize:"),
                    content_size,
                );
                msg_send_void_bool(
                    state.view as *mut ObjcObject,
                    selector(c"setNeedsDisplay:"),
                    true,
                );
            });
            Ok(())
        })
    }

    fn dpi_changed(&self, dpi: SurfaceDpi) -> SurfaceResult {
        validate_dpi(dpi)?;
        self.with_running(|state| {
            let size = {
                let mut framebuffer = self.framebuffer.lock();
                framebuffer.set_dpi(dpi)?;
                framebuffer.size()
            };
            let content_size = points_for_pixels(size, dpi);
            run_on_main_sync(move || unsafe {
                msg_send_void_size(
                    state.window as *mut ObjcObject,
                    selector(c"setContentSize:"),
                    content_size,
                );
                msg_send_void_bool(
                    state.view as *mut ObjcObject,
                    selector(c"setNeedsDisplay:"),
                    true,
                );
            });
            Ok(())
        })
    }

    fn present(&self, frame: SurfaceFrame<'_>) -> SurfaceResult {
        self.with_running(|state| {
            let (dirty, source) = {
                let mut framebuffer = self.framebuffer.lock();
                let dirty = framebuffer.write(frame)?;
                (dirty, framebuffer.size())
            };
            run_on_main_sync(move || unsafe {
                let view = state.view as *mut ObjcObject;
                let bounds = msg_send_rect(view, selector(c"bounds"));
                let invalid = map_dirty_rect(dirty, source, bounds);
                msg_send_void_rect(view, selector(c"setNeedsDisplayInRect:"), invalid);
            });
            Ok(())
        })
    }

    fn request_full_repaint(&self) -> SurfaceResult {
        self.with_running(|state| {
            run_on_main_sync(move || unsafe {
                msg_send_void_bool(
                    state.view as *mut ObjcObject,
                    selector(c"setNeedsDisplay:"),
                    true,
                );
            });
            Ok(())
        })
    }
}

impl Drop for MacosRdpSurface {
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
        let metrics = self.metrics.as_mut().ok_or(SurfaceError::Detached)?;
        let pixels = zeroed_bgra(size)?;
        metrics.size = size;
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
        Ok(frame.rect)
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

struct ViewContext {
    framebuffer: Arc<Mutex<Framebuffer>>,
    alive: Arc<AtomicBool>,
    backing_scale_bits: Arc<AtomicU64>,
}

static VIEW_CLASS: OnceLock<Result<usize, String>> = OnceLock::new();
static VIEW_CONTEXTS: OnceLock<Mutex<HashMap<usize, Arc<ViewContext>>>> = OnceLock::new();

fn view_contexts() -> &'static Mutex<HashMap<usize, Arc<ViewContext>>> {
    VIEW_CONTEXTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn view_class() -> Result<*mut ObjcClass, String> {
    VIEW_CLASS
        .get_or_init(|| unsafe {
            let existing = objc_getClass(c"ZephyrOneNativeRdpView".as_ptr());
            if !existing.is_null() {
                return Ok(existing as usize);
            }
            let superclass = objc_getClass(c"NSView".as_ptr());
            if superclass.is_null() {
                return Err("AppKit NSView class is unavailable".to_owned());
            }
            let class = objc_allocateClassPair(superclass, c"ZephyrOneNativeRdpView".as_ptr(), 0);
            if class.is_null() {
                return Err("failed to allocate native RDP NSView class".to_owned());
            }

            let methods = [
                (
                    c"drawRect:",
                    draw_rect as unsafe extern "C" fn(*mut ObjcObject, *mut ObjcSelector, CGRect)
                        as *const c_void,
                    c"v@:{CGRect={CGPoint=dd}{CGSize=dd}}",
                ),
                (
                    c"isOpaque",
                    is_opaque as unsafe extern "C" fn(*mut ObjcObject, *mut ObjcSelector) -> i8
                        as *const c_void,
                    c"c@:",
                ),
                (
                    c"windowWillClose:",
                    window_will_close
                        as unsafe extern "C" fn(*mut ObjcObject, *mut ObjcSelector, *mut ObjcObject)
                        as *const c_void,
                    c"v@:@",
                ),
                (
                    c"windowDidResize:",
                    window_needs_repaint
                        as unsafe extern "C" fn(*mut ObjcObject, *mut ObjcSelector, *mut ObjcObject)
                        as *const c_void,
                    c"v@:@",
                ),
                (
                    c"windowDidChangeBackingProperties:",
                    window_backing_changed
                        as unsafe extern "C" fn(*mut ObjcObject, *mut ObjcSelector, *mut ObjcObject)
                        as *const c_void,
                    c"v@:@",
                ),
                (
                    c"windowDidChangeOcclusionState:",
                    window_needs_repaint
                        as unsafe extern "C" fn(*mut ObjcObject, *mut ObjcSelector, *mut ObjcObject)
                        as *const c_void,
                    c"v@:@",
                ),
            ];
            for (name, implementation, types) in methods {
                if class_addMethod(
                    class,
                    sel_registerName(name.as_ptr()),
                    implementation,
                    types.as_ptr(),
                ) == 0
                {
                    objc_disposeClassPair(class);
                    return Err(format!(
                        "failed to register native RDP view method {}",
                        name.to_string_lossy()
                    ));
                }
            }
            objc_registerClassPair(class);
            Ok(class as usize)
        })
        .clone()
        .map(|class| class as *mut ObjcClass)
}

fn create_window(
    config: &MacosSurfaceConfig,
    metrics: SurfaceMetrics,
    context: Arc<ViewContext>,
) -> Result<WindowState, String> {
    unsafe {
        let title = CString::new(config.title.as_bytes())
            .map_err(|_| "native RDP window title contains a NUL byte".to_owned())?;
        let application_class = require_class(c"NSApplication")?;
        let _application = msg_send_id(application_class.cast(), selector(c"sharedApplication"));
        let window_class = require_class(c"NSWindow")?;
        let string_class = require_class(c"NSString")?;
        let view_class = view_class()?;

        let frame = CGRect::new(
            &CGPoint::new(0.0, 0.0),
            &points_for_pixels(metrics.size, metrics.dpi),
        );
        let allocated_window = msg_send_id(window_class.cast(), selector(c"alloc"));
        if allocated_window.is_null() {
            return Err("failed to allocate native RDP NSWindow".to_owned());
        }
        let window = msg_send_window_init(
            allocated_window,
            selector(c"initWithContentRect:styleMask:backing:defer:"),
            frame,
            NS_WINDOW_STYLE_MASK,
            NS_BACKING_STORE_BUFFERED,
            false,
        );
        if window.is_null() {
            return Err("failed to initialize native RDP NSWindow".to_owned());
        }

        let allocated_view = msg_send_id(view_class.cast(), selector(c"alloc"));
        let view = msg_send_id_rect(allocated_view, selector(c"initWithFrame:"), frame);
        if view.is_null() {
            msg_send_void(window, selector(c"release"));
            return Err("failed to initialize native RDP NSView".to_owned());
        }

        view_contexts()
            .lock()
            .insert(view as usize, context.clone());
        msg_send_void_bool(window, selector(c"setReleasedWhenClosed:"), false);
        msg_send_void_bool(view, selector(c"setNeedsDisplayOnBoundsChange:"), true);
        msg_send_void_id(window, selector(c"setContentView:"), view);
        msg_send_void_id(window, selector(c"setDelegate:"), view);

        let native_title = msg_send_id_cstr(
            string_class.cast(),
            selector(c"stringWithUTF8String:"),
            title.as_ptr(),
        );
        if !native_title.is_null() {
            msg_send_void_id(window, selector(c"setTitle:"), native_title);
        }

        let scale = msg_send_f64(window, selector(c"backingScaleFactor"));
        if scale.is_finite() && scale > 0.0 {
            context
                .backing_scale_bits
                .store(scale.to_bits(), Ordering::Release);
        }
        context.alive.store(true, Ordering::Release);
        if config.visible {
            msg_send_void_id(
                window,
                selector(c"makeKeyAndOrderFront:"),
                std::ptr::null_mut(),
            );
        }

        // NSWindow retained its content view; balance alloc/init ownership.
        msg_send_void(view, selector(c"release"));
        Ok(WindowState {
            window: window as usize,
            view: view as usize,
        })
    }
}

fn destroy_window(state: WindowState) {
    unsafe {
        let window = state.window as *mut ObjcObject;
        view_contexts().lock().remove(&state.view);
        msg_send_void_id(window, selector(c"setDelegate:"), std::ptr::null_mut());
        msg_send_void_id(window, selector(c"orderOut:"), std::ptr::null_mut());
        msg_send_void(window, selector(c"close"));
        msg_send_void(window, selector(c"release"));
    }
}

unsafe extern "C" fn draw_rect(
    view: *mut ObjcObject,
    _selector: *mut ObjcSelector,
    _dirty: CGRect,
) {
    let _ = catch_unwind(AssertUnwindSafe(|| unsafe { draw_framebuffer(view) }));
}

unsafe extern "C" fn is_opaque(_view: *mut ObjcObject, _selector: *mut ObjcSelector) -> i8 {
    1
}

unsafe extern "C" fn window_will_close(
    view: *mut ObjcObject,
    _selector: *mut ObjcSelector,
    _notification: *mut ObjcObject,
) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if let Some(context) = view_contexts().lock().get(&(view as usize)).cloned() {
            context.alive.store(false, Ordering::Release);
        }
    }));
}

unsafe extern "C" fn window_needs_repaint(
    view: *mut ObjcObject,
    _selector: *mut ObjcSelector,
    _notification: *mut ObjcObject,
) {
    let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
        msg_send_void_bool(view, selector(c"setNeedsDisplay:"), true);
    }));
}

unsafe extern "C" fn window_backing_changed(
    view: *mut ObjcObject,
    _selector: *mut ObjcSelector,
    _notification: *mut ObjcObject,
) {
    let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
        let window = msg_send_id(view, selector(c"window"));
        if let Some(context) = view_contexts().lock().get(&(view as usize)).cloned() {
            let scale = msg_send_f64(window, selector(c"backingScaleFactor"));
            if scale.is_finite() && scale > 0.0 {
                context
                    .backing_scale_bits
                    .store(scale.to_bits(), Ordering::Release);
            }
        }
        msg_send_void_bool(view, selector(c"setNeedsDisplay:"), true);
    }));
}

unsafe fn draw_framebuffer(view: *mut ObjcObject) {
    let Some(context) = view_contexts().lock().get(&(view as usize)).cloned() else {
        return;
    };
    let graphics_context_class = match require_class(c"NSGraphicsContext") {
        Ok(class) => class,
        Err(_) => return,
    };
    let graphics_context = msg_send_id(graphics_context_class.cast(), selector(c"currentContext"));
    if graphics_context.is_null() {
        return;
    }
    let raw_context = msg_send_id(graphics_context, selector(c"CGContext"));
    if raw_context.is_null() {
        return;
    }

    let framebuffer = context.framebuffer.lock();
    let Some(metrics) = framebuffer.metrics() else {
        return;
    };
    let provider = CGDataProvider::from_slice(&framebuffer.pixels);
    let color_space = CGColorSpace::create_device_rgb();
    let bitmap_info = kCGBitmapByteOrder32Little | kCGImageAlphaNoneSkipFirst;
    let image = CGImage::new(
        metrics.size.width as usize,
        metrics.size.height as usize,
        8,
        32,
        metrics.size.width as usize * BGRA_BYTES_PER_PIXEL,
        &color_space,
        bitmap_info,
        &provider,
        false,
        kCGRenderingIntentDefault,
    );
    let cg = CGContext::from_existing_context_ptr(raw_context.cast());
    let bounds = msg_send_rect(view, selector(c"bounds"));
    cg.save();
    cg.set_interpolation_quality(CGInterpolationQuality::CGInterpolationQualityNone);
    cg.translate(0.0, bounds.size.height);
    cg.scale(1.0, -1.0);
    cg.draw_image(
        CGRect::new(
            &CGPoint::new(bounds.origin.x, bounds.origin.y),
            &bounds.size,
        ),
        &image,
    );
    cg.restore();
}

fn points_for_pixels(size: PixelSize, dpi: SurfaceDpi) -> CGSize {
    CGSize::new(
        (f64::from(size.width) * APPKIT_POINTS_PER_INCH / f64::from(dpi.horizontal)).max(1.0),
        (f64::from(size.height) * APPKIT_POINTS_PER_INCH / f64::from(dpi.vertical)).max(1.0),
    )
}

fn map_dirty_rect(dirty: DirtyRect, source: PixelSize, bounds: CGRect) -> CGRect {
    let scale_x = bounds.size.width / f64::from(source.width);
    let scale_y = bounds.size.height / f64::from(source.height);
    let bottom = source.height - (dirty.y + dirty.height);
    CGRect::new(
        &CGPoint::new(
            bounds.origin.x + f64::from(dirty.x) * scale_x,
            bounds.origin.y + f64::from(bottom) * scale_y,
        ),
        &CGSize::new(
            f64::from(dirty.width) * scale_x,
            f64::from(dirty.height) * scale_y,
        ),
    )
}

struct MainQueueCall<F, R> {
    function: Option<F>,
    result: Option<std::thread::Result<R>>,
}

fn run_on_main_sync<F, R>(function: F) -> R
where
    F: FnOnce() -> R + Send,
    R: Send,
{
    if unsafe { pthread_main_np() } != 0 {
        return function();
    }

    let mut call = MainQueueCall {
        function: Some(function),
        result: None,
    };
    unsafe {
        dispatch_sync_f(
            (&raw const _dispatch_main_q).cast_mut().cast(),
            (&mut call as *mut MainQueueCall<F, R>).cast(),
            invoke_main_queue::<F, R>,
        );
    }
    match call
        .result
        .expect("main queue did not execute synchronous work")
    {
        Ok(result) => result,
        Err(payload) => resume_unwind(payload),
    }
}

unsafe extern "C" fn invoke_main_queue<F, R>(context: *mut c_void)
where
    F: FnOnce() -> R + Send,
    R: Send,
{
    let call = &mut *context.cast::<MainQueueCall<F, R>>();
    if let Some(function) = call.function.take() {
        call.result = Some(catch_unwind(AssertUnwindSafe(function)));
    }
}

unsafe fn require_class(name: &std::ffi::CStr) -> Result<*mut ObjcClass, String> {
    let class = objc_getClass(name.as_ptr());
    if class.is_null() {
        Err(format!(
            "AppKit class {} is unavailable",
            name.to_string_lossy()
        ))
    } else {
        Ok(class)
    }
}

unsafe fn selector(name: &std::ffi::CStr) -> *mut ObjcSelector {
    sel_registerName(name.as_ptr())
}

unsafe fn msg_send_id(receiver: *mut ObjcObject, selector: *mut ObjcSelector) -> *mut ObjcObject {
    let send: unsafe extern "C" fn(*mut ObjcObject, *mut ObjcSelector) -> *mut ObjcObject =
        mem::transmute(objc_msgSend as *const ());
    send(receiver, selector)
}

unsafe fn msg_send_id_cstr(
    receiver: *mut ObjcObject,
    selector: *mut ObjcSelector,
    value: *const c_char,
) -> *mut ObjcObject {
    let send: unsafe extern "C" fn(
        *mut ObjcObject,
        *mut ObjcSelector,
        *const c_char,
    ) -> *mut ObjcObject = mem::transmute(objc_msgSend as *const ());
    send(receiver, selector, value)
}

unsafe fn msg_send_id_rect(
    receiver: *mut ObjcObject,
    selector: *mut ObjcSelector,
    rect: CGRect,
) -> *mut ObjcObject {
    let send: unsafe extern "C" fn(*mut ObjcObject, *mut ObjcSelector, CGRect) -> *mut ObjcObject =
        mem::transmute(objc_msgSend as *const ());
    send(receiver, selector, rect)
}

unsafe fn msg_send_window_init(
    receiver: *mut ObjcObject,
    selector: *mut ObjcSelector,
    rect: CGRect,
    style: usize,
    backing: usize,
    defer: bool,
) -> *mut ObjcObject {
    let send: unsafe extern "C" fn(
        *mut ObjcObject,
        *mut ObjcSelector,
        CGRect,
        usize,
        usize,
        i8,
    ) -> *mut ObjcObject = mem::transmute(objc_msgSend as *const ());
    send(receiver, selector, rect, style, backing, i8::from(defer))
}

unsafe fn msg_send_void(receiver: *mut ObjcObject, selector: *mut ObjcSelector) {
    let send: unsafe extern "C" fn(*mut ObjcObject, *mut ObjcSelector) =
        mem::transmute(objc_msgSend as *const ());
    send(receiver, selector);
}

unsafe fn msg_send_void_id(
    receiver: *mut ObjcObject,
    selector: *mut ObjcSelector,
    value: *mut ObjcObject,
) {
    let send: unsafe extern "C" fn(*mut ObjcObject, *mut ObjcSelector, *mut ObjcObject) =
        mem::transmute(objc_msgSend as *const ());
    send(receiver, selector, value);
}

unsafe fn msg_send_void_bool(receiver: *mut ObjcObject, selector: *mut ObjcSelector, value: bool) {
    let send: unsafe extern "C" fn(*mut ObjcObject, *mut ObjcSelector, i8) =
        mem::transmute(objc_msgSend as *const ());
    send(receiver, selector, i8::from(value));
}

unsafe fn msg_send_void_rect(receiver: *mut ObjcObject, selector: *mut ObjcSelector, rect: CGRect) {
    let send: unsafe extern "C" fn(*mut ObjcObject, *mut ObjcSelector, CGRect) =
        mem::transmute(objc_msgSend as *const ());
    send(receiver, selector, rect);
}

unsafe fn msg_send_void_size(receiver: *mut ObjcObject, selector: *mut ObjcSelector, size: CGSize) {
    let send: unsafe extern "C" fn(*mut ObjcObject, *mut ObjcSelector, CGSize) =
        mem::transmute(objc_msgSend as *const ());
    send(receiver, selector, size);
}

unsafe fn msg_send_f64(receiver: *mut ObjcObject, selector: *mut ObjcSelector) -> f64 {
    let send: unsafe extern "C" fn(*mut ObjcObject, *mut ObjcSelector) -> f64 =
        mem::transmute(objc_msgSend as *const ());
    send(receiver, selector)
}

#[cfg(not(target_arch = "x86_64"))]
unsafe fn msg_send_rect(receiver: *mut ObjcObject, selector: *mut ObjcSelector) -> CGRect {
    let send: unsafe extern "C" fn(*mut ObjcObject, *mut ObjcSelector) -> CGRect =
        mem::transmute(objc_msgSend as *const ());
    send(receiver, selector)
}

#[cfg(target_arch = "x86_64")]
unsafe fn msg_send_rect(receiver: *mut ObjcObject, selector: *mut ObjcSelector) -> CGRect {
    let send: unsafe extern "C" fn(*mut CGRect, *mut ObjcObject, *mut ObjcSelector) =
        mem::transmute(objc_msgSend_stret as *const ());
    let mut result = mem::MaybeUninit::<CGRect>::uninit();
    send(result.as_mut_ptr(), receiver, selector);
    result.assume_init()
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
        assert_surface::<MacosRdpSurface>();
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
    fn appkit_size_uses_remote_dpi_and_dirty_y_is_flipped() {
        let points = points_for_pixels(PixelSize::new(192, 96), SurfaceDpi::new(96, 96));
        assert_eq!(points, CGSize::new(144.0, 72.0));

        let bounds = CGRect::new(&CGPoint::new(0.0, 0.0), &CGSize::new(300.0, 150.0));
        let mapped = map_dirty_rect(
            DirtyRect::new(10, 5, 20, 10),
            PixelSize::new(100, 50),
            bounds,
        );
        assert_eq!(mapped.origin, CGPoint::new(30.0, 105.0));
        assert_eq!(mapped.size, CGSize::new(60.0, 30.0));
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
}
