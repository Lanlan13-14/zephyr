//! Zephyr drive redirection backend for RDPDR (RDPEFS).
//!
//! Implements ironrdp::rdpdr::backend::RdpdrBackend by forwarding all
//! file system IRPs to the browser-side Agent file system via synchronous
//! JS RPC (globalThis.zephyrRdpFs*). The Worker environment permits
//! synchronous XMLHttpRequest, so these calls do not block the main thread.

use std::sync::Mutex;

use ironrdp::rdpdr::backend::RdpdrBackend;
use ironrdp::rdpdr::pdu::efs::{
    DeviceControlRequest, DeviceIoResponse, NtStatus, PrinterIoRequest, ServerDeviceAnnounceResponse,
    ServerDriveIoRequest,
};
use ironrdp::rdpdr::pdu::esc::{ScardCall, ScardIoCtlCode};
use ironrdp_pdu::PduResult;
use ironrdp_svc::SvcMessage;

static PENDING_DRIVE: Mutex<Option<ZephyrDriveBackend>> = Mutex::new(None);

/// Called from rdp_fs_attach_drive (wasm_bindgen export) to queue a drive
/// backend before the session connects.
pub(crate) fn register_pending_drive(agent_id: String, drive_name: String, read_only: bool) {
    let backend = ZephyrDriveBackend::new(agent_id, drive_name, read_only);
    if let Ok(mut guard) = PENDING_DRIVE.lock() {
        *guard = Some(backend);
    }
}

/// Called from session.rs connect() to take the pending drive backend.
pub(crate) fn take_pending_drive_backend() -> Option<ZephyrDriveBackend> {
    PENDING_DRIVE.lock().ok().and_then(|mut g| g.take())
}

pub(crate) struct ZephyrDriveBackend {
    agent_id: String,
    drive_name: String,
    read_only: bool,
    initialized: bool,
}

impl std::fmt::Debug for ZephyrDriveBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ZephyrDriveBackend")
            .field("agent_id", &self.agent_id)
            .field("drive_name", &self.drive_name)
            .field("read_only", &self.read_only)
            .field("initialized", &self.initialized)
            .finish()
    }
}

ironrdp_core::impl_as_any!(ZephyrDriveBackend);

impl ZephyrDriveBackend {
    pub(crate) fn new(agent_id: String, drive_name: String, read_only: bool) -> Self {
        Self {
            agent_id,
            drive_name,
            read_only,
            initialized: false,
        }
    }
}

impl RdpdrBackend for ZephyrDriveBackend {
    fn handle_server_device_announce_response(&mut self, _pdu: ServerDeviceAnnounceResponse) -> PduResult<()> {
        tracing::info!("RDPEFS device announce received for drive '{}'", self.drive_name);
        Ok(())
    }

    fn handle_scard_call(&mut self, _req: DeviceControlRequest<ScardIoCtlCode>, _call: ScardCall) -> PduResult<()> {
        Ok(())
    }

    fn handle_drive_io_request(&mut self, req: ServerDriveIoRequest) -> PduResult<Vec<SvcMessage>> {
        // Drive IRP handling requires the full IRP dispatch that was in
        // rdpefs.go. For now, return empty Vec (no response) so the RDPDR
        // channel stays alive while the Rust port of the IRP handler is
        // completed.
        //
        // TODO: Implement IRP_MJ_CREATE/READ/WRITE/CLOSE/QUERY_DIRECTORY/
        // QUERY_VOLUME_INFORMATION/SET_INFORMATION by calling
        // globalThis.zephyrRdpFsList/Stat/Open/Read/Write/Close via sync JS.
        tracing::warn!(
            "RDPEFS drive IRP not yet implemented (agent={}, drive={})",
            self.agent_id,
            self.drive_name
        );
        let _ = req;
        Ok(Vec::new())
    }

    fn handle_user_logged_on(&mut self, _rdpdr: &mut ironrdp::rdpdr::Rdpdr) -> PduResult<Vec<SvcMessage>> {
        tracing::info!("RDPEFS USER_LOGGEDON received, drive '{}' ready", self.drive_name);
        self.initialized = true;
        Ok(Vec::new())
    }

    fn handle_printer_io_request(&mut self, req: PrinterIoRequest) -> PduResult<Vec<SvcMessage>> {
        let device_io_request = req.into_device_io_request();
        Ok(vec![SvcMessage::from(
            ironrdp::rdpdr::pdu::RdpdrPdu::DeviceCloseResponse(
                ironrdp::rdpdr::pdu::efs::DeviceCloseResponse {
                    device_io_response: DeviceIoResponse::new(device_io_request, NtStatus::NOT_SUPPORTED),
                },
            ),
        )])
    }
}
