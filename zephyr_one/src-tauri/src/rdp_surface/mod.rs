//! Native presentation boundary for desktop RDP sessions.
//!
//! FreeRDP owns protocol decoding and emits borrowed BGRA dirty rectangles
//! through [`FrameSink`]. This module keeps those rectangles in-process and
//! hands them synchronously to a platform surface. It intentionally exposes no
//! serializable frame type and no Tauri command: pixels must never cross into
//! JavaScript or a WebView canvas.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};

use parking_lot::Mutex;

use crate::rdp::{FrameRect, FrameSink, SessionEvent, SessionRegistry};

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;
#[cfg(target_os = "windows")]
pub mod windows_input;

const BGRA_BYTES_PER_PIXEL: usize = 4;
const DEFAULT_DPI: u32 = 96;

/// Pixel dimensions of the native RDP backing surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelSize {
    pub width: u32,
    pub height: u32,
}

impl PixelSize {
    pub const fn new(width: u32, height: u32) -> Self {
        Self { width, height }
    }
}

/// Physical DPI reported by the window containing the surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SurfaceDpi {
    pub horizontal: u32,
    pub vertical: u32,
}

impl SurfaceDpi {
    pub const fn new(horizontal: u32, vertical: u32) -> Self {
        Self {
            horizontal,
            vertical,
        }
    }
}

impl Default for SurfaceDpi {
    fn default() -> Self {
        Self::new(DEFAULT_DPI, DEFAULT_DPI)
    }
}

/// Current native backing-store configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SurfaceMetrics {
    pub size: PixelSize,
    pub dpi: SurfaceDpi,
}

impl SurfaceMetrics {
    pub const fn new(size: PixelSize, dpi: SurfaceDpi) -> Self {
        Self { size, dpi }
    }
}

/// A dirty rectangle, in framebuffer pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DirtyRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl DirtyRect {
    pub const fn new(x: u32, y: u32, width: u32, height: u32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }
}

/// Borrowed BGRA pixels for one dirty rectangle.
///
/// `stride` is the byte distance between row starts and may include platform
/// padding. The buffer must contain `stride * rect.height` bytes. The borrow is
/// deliberately tied to the call so a surface cannot retain FreeRDP's scratch
/// buffer after [`NativeRdpSurface::present`] returns.
#[derive(Debug)]
pub struct SurfaceFrame<'a> {
    pub rect: DirtyRect,
    pub stride: usize,
    pub pixels: &'a [u8],
}

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum SurfaceError {
    #[error("surface session id cannot be empty")]
    EmptySessionId,
    #[error("surface dimensions must be non-zero (got {width}x{height})")]
    InvalidSize { width: u32, height: u32 },
    #[error("surface DPI must be non-zero (got {horizontal}x{vertical})")]
    InvalidDpi { horizontal: u32, vertical: u32 },
    #[error("surface attachment is no longer current")]
    Detached,
    #[error("dirty rectangle dimensions must be non-zero")]
    EmptyRect,
    #[error("dirty rectangle lies outside {surface_width}x{surface_height}")]
    RectOutOfBounds {
        surface_width: u32,
        surface_height: u32,
    },
    #[error("frame stride {actual} is smaller than the {minimum}-byte BGRA row")]
    InvalidStride { minimum: usize, actual: usize },
    #[error("frame has {actual} bytes but its stride and height require {minimum}")]
    BufferTooSmall { minimum: usize, actual: usize },
    #[error("frame dimensions overflow addressable memory")]
    FrameTooLarge,
    #[error("native surface failed: {0}")]
    Platform(String),
}

pub type SurfaceResult<T = ()> = Result<T, SurfaceError>;

/// Platform-owned native rendering target.
///
/// Implementations may dispatch to their required UI/compositor thread, but
/// each method must finish synchronously. The registry serializes callbacks for
/// one attachment and guarantees that no callback is running, or can start,
/// after `detached` returns. Implementations must not synchronously call a
/// lifecycle method on their own attachment from inside one of these callbacks.
pub trait NativeRdpSurface: Send + Sync + 'static {
    fn attached(&self, metrics: SurfaceMetrics) -> SurfaceResult;
    fn detached(&self);
    fn resized(&self, size: PixelSize) -> SurfaceResult;
    fn dpi_changed(&self, dpi: SurfaceDpi) -> SurfaceResult;
    fn present(&self, frame: SurfaceFrame<'_>) -> SurfaceResult;

    /// Repaint the platform backing store, for example after window exposure.
    /// A remote full-frame refresh is requested separately by the registry.
    fn request_full_repaint(&self) -> SurfaceResult;
}

/// Control-plane hook used when a newly attached or exposed surface needs the
/// complete remote framebuffer rather than only future dirty rectangles.
pub trait FullFrameRequester: Send + Sync + 'static {
    /// Returns false when the FreeRDP session is no longer present.
    fn request_full_frame(&self, session_id: &str) -> bool;
}

impl FullFrameRequester for SessionRegistry {
    fn request_full_frame(&self, session_id: &str) -> bool {
        let Some(session) = self.get(session_id) else {
            return false;
        };
        session.request_full_frame();
        true
    }
}

struct AttachmentState {
    active: bool,
    metrics: SurfaceMetrics,
}

struct Attachment {
    generation: u64,
    surface: Arc<dyn NativeRdpSurface>,
    // Held across callbacks. This is what makes `detached` a destruction fence.
    state: Mutex<AttachmentState>,
}

impl Attachment {
    fn new(
        generation: u64,
        surface: Arc<dyn NativeRdpSurface>,
        metrics: SurfaceMetrics,
    ) -> SurfaceResult<Self> {
        validate_metrics(metrics)?;
        surface.attached(metrics)?;
        Ok(Self {
            generation,
            surface,
            state: Mutex::new(AttachmentState {
                active: true,
                metrics,
            }),
        })
    }

    fn resize(&self, size: PixelSize) -> SurfaceResult {
        validate_size(size)?;
        let mut state = self.state.lock();
        ensure_active(&state)?;
        self.surface.resized(size)?;
        state.metrics.size = size;
        Ok(())
    }

    fn set_dpi(&self, dpi: SurfaceDpi) -> SurfaceResult {
        validate_dpi(dpi)?;
        let mut state = self.state.lock();
        ensure_active(&state)?;
        self.surface.dpi_changed(dpi)?;
        state.metrics.dpi = dpi;
        Ok(())
    }

    fn present(&self, frame: SurfaceFrame<'_>) -> SurfaceResult {
        let state = self.state.lock();
        ensure_active(&state)?;
        validate_frame(&frame, state.metrics.size)?;
        self.surface.present(frame)
    }

    fn repaint(&self) -> SurfaceResult {
        let state = self.state.lock();
        ensure_active(&state)?;
        self.surface.request_full_repaint()
    }

    fn deactivate(&self) {
        let mut state = self.state.lock();
        if !state.active {
            return;
        }
        state.active = false;
        self.surface.detached();
    }
}

impl Drop for Attachment {
    fn drop(&mut self) {
        let state = self.state.get_mut();
        if state.active {
            state.active = false;
            self.surface.detached();
        }
    }
}

struct RegistryInner {
    attachments: Mutex<HashMap<Arc<str>, Arc<Attachment>>>,
    // Serializes attach/replace/detach so their externally visible order is
    // stable even when native window creation and destruction race.
    lifecycle: Mutex<()>,
    next_generation: AtomicU64,
    full_frames: Arc<dyn FullFrameRequester>,
}

impl RegistryInner {
    fn current(&self, session_id: &str) -> Option<Arc<Attachment>> {
        self.attachments.lock().get(session_id).cloned()
    }

    fn current_generation(&self, session_id: &str, generation: u64) -> Option<Arc<Attachment>> {
        self.attachments
            .lock()
            .get(session_id)
            .filter(|attachment| attachment.generation == generation)
            .cloned()
    }

    fn detach_generation(&self, session_id: &str, generation: u64) -> bool {
        let _lifecycle = self.lifecycle.lock();
        let attachment = {
            let mut attachments = self.attachments.lock();
            match attachments.get(session_id) {
                Some(current) if current.generation == generation => attachments.remove(session_id),
                _ => None,
            }
        };
        if let Some(attachment) = attachment {
            attachment.deactivate();
            true
        } else {
            false
        }
    }
}

impl Drop for RegistryInner {
    fn drop(&mut self) {
        for attachment in self.attachments.get_mut().drain().map(|(_, value)| value) {
            attachment.deactivate();
        }
    }
}

/// Session-to-native-surface registry owned by the Tauri shell.
///
/// The registry holds exactly one current surface per RDP session. Replacing a
/// surface invalidates the old lease, so a delayed destroy notification from an
/// old tab cannot detach its replacement.
pub struct NativeRdpSurfaceRegistry {
    inner: Arc<RegistryInner>,
}

impl NativeRdpSurfaceRegistry {
    pub fn new(sessions: Arc<SessionRegistry>) -> Self {
        Self::with_full_frame_requester(sessions)
    }

    pub fn with_full_frame_requester(full_frames: Arc<dyn FullFrameRequester>) -> Self {
        Self {
            inner: Arc::new(RegistryInner {
                attachments: Mutex::new(HashMap::new()),
                lifecycle: Mutex::new(()),
                next_generation: AtomicU64::new(1),
                full_frames,
            }),
        }
    }

    pub fn attach(
        &self,
        session_id: impl Into<Arc<str>>,
        surface: Arc<dyn NativeRdpSurface>,
        metrics: SurfaceMetrics,
    ) -> SurfaceResult<SurfaceAttachment> {
        let session_id = session_id.into();
        if session_id.trim().is_empty() {
            return Err(SurfaceError::EmptySessionId);
        }

        let _lifecycle = self.inner.lifecycle.lock();
        let generation = self.inner.next_generation.fetch_add(1, Ordering::Relaxed);
        let attachment = Arc::new(Attachment::new(generation, surface, metrics)?);
        let replaced = self
            .inner
            .attachments
            .lock()
            .insert(session_id.clone(), attachment);
        if let Some(replaced) = replaced {
            replaced.deactivate();
        }

        // Reattached surfaces have missed earlier dirty rectangles. The only
        // correct seed is a new full update from the in-process FreeRDP session.
        self.inner.full_frames.request_full_frame(&session_id);
        Ok(SurfaceAttachment {
            registry: Arc::downgrade(&self.inner),
            session_id,
            generation,
            detached: AtomicBool::new(false),
        })
    }

    /// A `FrameSink` suitable for passing directly to the FreeRDP session.
    /// It contains only a weak registry reference, so an engine callback cannot
    /// keep the application or native window alive during shutdown.
    pub fn frame_sink(&self, session_id: impl Into<Arc<str>>) -> Arc<dyn FrameSink> {
        Arc::new(NativeSurfaceFrameSink {
            registry: Arc::downgrade(&self.inner),
            session_id: session_id.into(),
        })
    }

    /// Force-detach the current surface during session/application teardown.
    pub fn detach_session(&self, session_id: &str) -> bool {
        let _lifecycle = self.inner.lifecycle.lock();
        let attachment = self.inner.attachments.lock().remove(session_id);
        if let Some(attachment) = attachment {
            attachment.deactivate();
            true
        } else {
            false
        }
    }

    pub fn is_attached(&self, session_id: &str) -> bool {
        self.inner.attachments.lock().contains_key(session_id)
    }

    fn present(&self, session_id: &str, frame: SurfaceFrame<'_>) -> SurfaceResult {
        self.inner
            .current(session_id)
            .ok_or(SurfaceError::Detached)?
            .present(frame)
    }

    fn remote_resized(&self, session_id: &str, size: PixelSize) {
        let Some(attachment) = self.inner.current(session_id) else {
            return;
        };
        let _ = attachment.resize(size);
    }
}

/// Generation-scoped ownership token for one attached native surface.
///
/// Dropping the token detaches it. Methods fail with [`SurfaceError::Detached`]
/// once another surface has replaced it or the session has been torn down.
pub struct SurfaceAttachment {
    registry: Weak<RegistryInner>,
    session_id: Arc<str>,
    generation: u64,
    detached: AtomicBool,
}

impl SurfaceAttachment {
    pub fn resize(&self, size: PixelSize) -> SurfaceResult {
        self.current()?.resize(size)
    }

    pub fn set_dpi(&self, dpi: SurfaceDpi) -> SurfaceResult {
        self.current()?.set_dpi(dpi)
    }

    /// Repaint cached platform pixels and ask FreeRDP for a complete refresh.
    pub fn request_full_repaint(&self) -> SurfaceResult {
        let registry = self.registry.upgrade().ok_or(SurfaceError::Detached)?;
        let attachment = registry
            .current_generation(&self.session_id, self.generation)
            .ok_or(SurfaceError::Detached)?;
        attachment.repaint()?;
        registry.full_frames.request_full_frame(&self.session_id);
        Ok(())
    }

    pub fn detach(&self) -> bool {
        if self.detached.swap(true, Ordering::AcqRel) {
            return false;
        }
        self.registry
            .upgrade()
            .map(|registry| registry.detach_generation(&self.session_id, self.generation))
            .unwrap_or(false)
    }

    fn current(&self) -> SurfaceResult<Arc<Attachment>> {
        if self.detached.load(Ordering::Acquire) {
            return Err(SurfaceError::Detached);
        }
        self.registry
            .upgrade()
            .and_then(|registry| registry.current_generation(&self.session_id, self.generation))
            .ok_or(SurfaceError::Detached)
    }
}

impl Drop for SurfaceAttachment {
    fn drop(&mut self) {
        self.detach();
    }
}

struct NativeSurfaceFrameSink {
    registry: Weak<RegistryInner>,
    session_id: Arc<str>,
}

impl FrameSink for NativeSurfaceFrameSink {
    fn frame(&self, rect: FrameRect<'_>) {
        let (Ok(x), Ok(y), Ok(width), Ok(height)) = (
            u32::try_from(rect.x),
            u32::try_from(rect.y),
            u32::try_from(rect.w),
            u32::try_from(rect.h),
        ) else {
            return;
        };
        let Some(stride) = usize::try_from(width)
            .ok()
            .and_then(|width| width.checked_mul(BGRA_BYTES_PER_PIXEL))
        else {
            return;
        };
        let Some(registry) = self.registry.upgrade() else {
            return;
        };
        let facade = NativeRdpSurfaceRegistry { inner: registry };
        let _ = facade.present(
            &self.session_id,
            SurfaceFrame {
                rect: DirtyRect::new(x, y, width, height),
                stride,
                pixels: rect.pixels,
            },
        );
    }

    fn event(&self, event: SessionEvent) {
        let SessionEvent::Resize { width, height } = event else {
            return;
        };
        let (Ok(width), Ok(height)) = (u32::try_from(width), u32::try_from(height)) else {
            return;
        };
        let Some(registry) = self.registry.upgrade() else {
            return;
        };
        NativeRdpSurfaceRegistry { inner: registry }
            .remote_resized(&self.session_id, PixelSize::new(width, height));
    }
}

fn validate_metrics(metrics: SurfaceMetrics) -> SurfaceResult {
    validate_size(metrics.size)?;
    validate_dpi(metrics.dpi)
}

fn validate_size(size: PixelSize) -> SurfaceResult {
    if size.width == 0 || size.height == 0 {
        return Err(SurfaceError::InvalidSize {
            width: size.width,
            height: size.height,
        });
    }
    Ok(())
}

fn validate_dpi(dpi: SurfaceDpi) -> SurfaceResult {
    if dpi.horizontal == 0 || dpi.vertical == 0 {
        return Err(SurfaceError::InvalidDpi {
            horizontal: dpi.horizontal,
            vertical: dpi.vertical,
        });
    }
    Ok(())
}

fn ensure_active(state: &AttachmentState) -> SurfaceResult {
    if state.active {
        Ok(())
    } else {
        Err(SurfaceError::Detached)
    }
}

fn validate_frame(frame: &SurfaceFrame<'_>, surface: PixelSize) -> SurfaceResult {
    if frame.rect.width == 0 || frame.rect.height == 0 {
        return Err(SurfaceError::EmptyRect);
    }
    let right =
        frame
            .rect
            .x
            .checked_add(frame.rect.width)
            .ok_or(SurfaceError::RectOutOfBounds {
                surface_width: surface.width,
                surface_height: surface.height,
            })?;
    let bottom =
        frame
            .rect
            .y
            .checked_add(frame.rect.height)
            .ok_or(SurfaceError::RectOutOfBounds {
                surface_width: surface.width,
                surface_height: surface.height,
            })?;
    if right > surface.width || bottom > surface.height {
        return Err(SurfaceError::RectOutOfBounds {
            surface_width: surface.width,
            surface_height: surface.height,
        });
    }

    let row_bytes = usize::try_from(frame.rect.width)
        .ok()
        .and_then(|width| width.checked_mul(BGRA_BYTES_PER_PIXEL))
        .ok_or(SurfaceError::FrameTooLarge)?;
    if frame.stride < row_bytes {
        return Err(SurfaceError::InvalidStride {
            minimum: row_bytes,
            actual: frame.stride,
        });
    }
    let required = frame
        .stride
        .checked_mul(usize::try_from(frame.rect.height).map_err(|_| SurfaceError::FrameTooLarge)?)
        .ok_or(SurfaceError::FrameTooLarge)?;
    if frame.pixels.len() < required {
        return Err(SurfaceError::BufferTooSmall {
            minimum: required,
            actual: frame.pixels.len(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    use super::*;

    #[derive(Debug, Clone, PartialEq, Eq)]
    enum Call {
        Attach(SurfaceMetrics),
        Detach,
        Resize(PixelSize),
        Dpi(SurfaceDpi),
        Present {
            rect: DirtyRect,
            stride: usize,
            bytes: usize,
        },
        Repaint,
    }

    #[derive(Default)]
    struct FakeSurface {
        calls: Mutex<Vec<Call>>,
    }

    impl FakeSurface {
        fn calls(&self) -> Vec<Call> {
            self.calls.lock().clone()
        }
    }

    impl NativeRdpSurface for FakeSurface {
        fn attached(&self, metrics: SurfaceMetrics) -> SurfaceResult {
            self.calls.lock().push(Call::Attach(metrics));
            Ok(())
        }

        fn detached(&self) {
            self.calls.lock().push(Call::Detach);
        }

        fn resized(&self, size: PixelSize) -> SurfaceResult {
            self.calls.lock().push(Call::Resize(size));
            Ok(())
        }

        fn dpi_changed(&self, dpi: SurfaceDpi) -> SurfaceResult {
            self.calls.lock().push(Call::Dpi(dpi));
            Ok(())
        }

        fn present(&self, frame: SurfaceFrame<'_>) -> SurfaceResult {
            self.calls.lock().push(Call::Present {
                rect: frame.rect,
                stride: frame.stride,
                bytes: frame.pixels.len(),
            });
            Ok(())
        }

        fn request_full_repaint(&self) -> SurfaceResult {
            self.calls.lock().push(Call::Repaint);
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakeFullFrames {
        sessions: Mutex<Vec<String>>,
    }

    impl FullFrameRequester for FakeFullFrames {
        fn request_full_frame(&self, session_id: &str) -> bool {
            self.sessions.lock().push(session_id.to_string());
            true
        }
    }

    fn metrics(width: u32, height: u32) -> SurfaceMetrics {
        SurfaceMetrics::new(PixelSize::new(width, height), SurfaceDpi::default())
    }

    fn registry() -> (NativeRdpSurfaceRegistry, Arc<FakeFullFrames>) {
        let requests = Arc::new(FakeFullFrames::default());
        (
            NativeRdpSurfaceRegistry::with_full_frame_requester(requests.clone()),
            requests,
        )
    }

    #[test]
    fn validates_dirty_rect_boundaries_and_padded_stride() {
        let (registry, _) = registry();
        let surface = Arc::new(FakeSurface::default());
        let _lease = registry
            .attach("session", surface.clone(), metrics(4, 3))
            .unwrap();

        let padded = [0u8; 24];
        let attachment = registry.inner.current("session").unwrap();
        attachment
            .present(SurfaceFrame {
                rect: DirtyRect::new(2, 1, 2, 2),
                stride: 12,
                pixels: &padded,
            })
            .unwrap();

        let outside = attachment.present(SurfaceFrame {
            rect: DirtyRect::new(3, 1, 2, 2),
            stride: 8,
            pixels: &padded[..16],
        });
        assert_eq!(
            outside,
            Err(SurfaceError::RectOutOfBounds {
                surface_width: 4,
                surface_height: 3,
            })
        );
        assert_eq!(
            attachment.present(SurfaceFrame {
                rect: DirtyRect::new(0, 0, 2, 2),
                stride: 7,
                pixels: &padded,
            }),
            Err(SurfaceError::InvalidStride {
                minimum: 8,
                actual: 7,
            })
        );
        assert_eq!(
            attachment.present(SurfaceFrame {
                rect: DirtyRect::new(0, 0, 2, 2),
                stride: 12,
                pixels: &padded[..23],
            }),
            Err(SurfaceError::BufferTooSmall {
                minimum: 24,
                actual: 23,
            })
        );

        assert_eq!(
            surface.calls(),
            vec![
                Call::Attach(metrics(4, 3)),
                Call::Present {
                    rect: DirtyRect::new(2, 1, 2, 2),
                    stride: 12,
                    bytes: 24,
                },
            ]
        );
    }

    #[test]
    fn frame_sink_preserves_tight_bgra_contract_and_remote_resize() {
        let (registry, _) = registry();
        let surface = Arc::new(FakeSurface::default());
        let _lease = registry
            .attach("session", surface.clone(), metrics(2, 2))
            .unwrap();
        let sink = registry.frame_sink("session");
        let pixels = [0u8; 16];

        sink.frame(FrameRect {
            x: 0,
            y: 0,
            w: 2,
            h: 2,
            pixels: &pixels,
        });
        sink.event(SessionEvent::Resize {
            width: 3,
            height: 4,
        });

        assert_eq!(
            surface.calls(),
            vec![
                Call::Attach(metrics(2, 2)),
                Call::Present {
                    rect: DirtyRect::new(0, 0, 2, 2),
                    stride: 8,
                    bytes: 16,
                },
                Call::Resize(PixelSize::new(3, 4)),
            ]
        );
    }

    #[test]
    fn resize_dpi_and_full_repaint_follow_the_lease() {
        let (registry, requests) = registry();
        let surface = Arc::new(FakeSurface::default());
        let lease = registry
            .attach("session", surface.clone(), metrics(8, 6))
            .unwrap();

        lease.resize(PixelSize::new(10, 7)).unwrap();
        lease.set_dpi(SurfaceDpi::new(144, 144)).unwrap();
        lease.request_full_repaint().unwrap();

        assert_eq!(
            surface.calls(),
            vec![
                Call::Attach(metrics(8, 6)),
                Call::Resize(PixelSize::new(10, 7)),
                Call::Dpi(SurfaceDpi::new(144, 144)),
                Call::Repaint,
            ]
        );
        assert_eq!(
            requests.sessions.lock().as_slice(),
            &["session".to_string(), "session".to_string()]
        );
    }

    #[test]
    fn stale_lease_cannot_detach_a_reattached_surface() {
        let (registry, _) = registry();
        let old_surface = Arc::new(FakeSurface::default());
        let old = registry
            .attach("session", old_surface.clone(), metrics(2, 2))
            .unwrap();
        let sink = registry.frame_sink("session");
        let new_surface = Arc::new(FakeSurface::default());
        let new = registry
            .attach("session", new_surface.clone(), metrics(2, 2))
            .unwrap();

        assert_eq!(
            old.resize(PixelSize::new(3, 3)),
            Err(SurfaceError::Detached)
        );
        assert!(!old.detach());
        assert!(registry.is_attached("session"));

        let pixels = [0u8; 4];
        sink.frame(FrameRect {
            x: 0,
            y: 0,
            w: 1,
            h: 1,
            pixels: &pixels,
        });
        assert!(new_surface
            .calls()
            .iter()
            .any(|call| matches!(call, Call::Present { .. })));
        assert_eq!(
            old_surface
                .calls()
                .iter()
                .filter(|call| **call == Call::Detach)
                .count(),
            1
        );
        assert!(new.detach());
    }

    struct BlockingSurface {
        entered: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
        detached: AtomicBool,
    }

    impl NativeRdpSurface for BlockingSurface {
        fn attached(&self, _metrics: SurfaceMetrics) -> SurfaceResult {
            Ok(())
        }

        fn detached(&self) {
            self.detached.store(true, Ordering::Release);
        }

        fn resized(&self, _size: PixelSize) -> SurfaceResult {
            Ok(())
        }

        fn dpi_changed(&self, _dpi: SurfaceDpi) -> SurfaceResult {
            Ok(())
        }

        fn present(&self, _frame: SurfaceFrame<'_>) -> SurfaceResult {
            self.entered.send(()).unwrap();
            self.release.lock().recv().unwrap();
            assert!(!self.detached.load(Ordering::Acquire));
            Ok(())
        }

        fn request_full_repaint(&self) -> SurfaceResult {
            Ok(())
        }
    }

    #[test]
    fn detach_waits_for_an_in_flight_present_before_destroying() {
        let (registry, _) = registry();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let surface = Arc::new(BlockingSurface {
            entered: entered_tx,
            release: Mutex::new(release_rx),
            detached: AtomicBool::new(false),
        });
        let lease = registry
            .attach("session", surface.clone(), metrics(1, 1))
            .unwrap();
        let sink = registry.frame_sink("session");

        let render = thread::spawn(move || {
            let pixels = [0u8; 4];
            sink.frame(FrameRect {
                x: 0,
                y: 0,
                w: 1,
                h: 1,
                pixels: &pixels,
            });
        });
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();

        let (destroy_started_tx, destroy_started_rx) = mpsc::channel();
        let (detached_tx, detached_rx) = mpsc::channel();
        let destroy = thread::spawn(move || {
            destroy_started_tx.send(()).unwrap();
            let result = lease.detach();
            detached_tx.send(result).unwrap();
        });
        destroy_started_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert!(detached_rx.recv_timeout(Duration::from_millis(50)).is_err());
        assert!(!surface.detached.load(Ordering::Acquire));

        release_tx.send(()).unwrap();
        render.join().unwrap();
        assert!(detached_rx.recv_timeout(Duration::from_secs(1)).unwrap());
        destroy.join().unwrap();
        assert!(surface.detached.load(Ordering::Acquire));
    }
}
