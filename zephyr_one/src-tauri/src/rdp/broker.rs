//! Authoritative native-RDP authorization and session ownership.
//!
//! The WebView may name a saved connection and a UI session, but it never
//! supplies a target, credential, channel grant, or filesystem path. A connect
//! stays inside one broker critical section from trusted-core resolution through
//! native session creation, and every later operation is tied to the WebView
//! label that created the native surface.

use std::collections::HashMap;

use parking_lot::Mutex;

use super::{AudioMode, Config, Security};

const INVALID_INTENT: &str = "rdp_broker_invalid_intent";
const OWNER_MISMATCH: &str = "rdp_broker_owner_mismatch";
const SESSION_EXISTS: &str = "rdp_broker_session_exists";
const SESSION_MISSING: &str = "rdp_broker_session_missing";
const SESSION_NOT_ACTIVE: &str = "rdp_broker_session_not_active";
const AUTHORIZATION_MISMATCH: &str = "rdp_broker_authorization_mismatch";
const DRIVE_MAPPING_DISABLED: &str = "rdp_drive_mapping_disabled";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenIntent {
    pub connection_id: String,
    pub session_id: String,
    pub width: u32,
    pub height: u32,
}

pub(crate) struct AuthorizedConnection {
    pub connection_id: String,
    pub session_id: String,
    pub owner_label: String,
    pub config: Config,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelBinding {
    pub audio: AudioMode,
    pub microphone: bool,
    pub clipboard: bool,
    pub dynamic_resolution: bool,
    pub gfx: bool,
    pub drive_mapping: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionBinding {
    pub connection_id: String,
    pub session_id: String,
    pub owner_label: String,
    pub host: String,
    pub port: u32,
    pub security: Security,
    pub channels: ChannelBinding,
}

#[derive(Debug, Clone)]
enum LeasePhase {
    SurfaceReserved,
    Active(SessionBinding),
}

#[derive(Debug, Clone)]
struct SurfaceLease {
    owner_label: String,
    phase: LeasePhase,
}

/// Process-local authority for native surfaces and RDP sessions.
///
/// No token is serialized to JavaScript. Tauri injects the invoking WebView,
/// and its label is the unforgeable owner key used for every command.
#[derive(Default)]
pub struct NativeRdpBroker {
    leases: Mutex<HashMap<String, SurfaceLease>>,
}

impl NativeRdpBroker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn claim_surface(&self, owner_label: &str, session_id: &str) -> Result<(), String> {
        validate_owner_and_session(owner_label, session_id)?;
        let mut leases = self.leases.lock();
        /* A lease stuck in SurfaceReserved means the previous open died before
         * the connect could consume it. Re-claiming the same surface for the
         * same owner is the retry, not an attack: only another owner's claim
         * is refused. */
        if let Some(existing) = leases.get(session_id) {
            let stuck_reserved = matches!(existing.phase, LeasePhase::SurfaceReserved)
                && existing.owner_label == owner_label;
            if !stuck_reserved {
                return Err(format!(
                    "{SESSION_EXISTS}: native RDP session {session_id} is already owned"
                ));
            }
        }
        leases.insert(
            session_id.to_owned(),
            SurfaceLease {
                owner_label: owner_label.to_owned(),
                phase: LeasePhase::SurfaceReserved,
            },
        );
        Ok(())
    }

    pub fn release_reserved(&self, owner_label: &str, session_id: &str) {
        let mut leases = self.leases.lock();
        let should_remove = leases.get(session_id).is_some_and(|lease| {
            lease.owner_label == owner_label && matches!(lease.phase, LeasePhase::SurfaceReserved)
        });
        if should_remove {
            leases.remove(session_id);
        }
    }

    /// Inspecting a missing id is needed before the UI creates its surface.
    /// An id already claimed by another WebView remains private.
    pub fn assert_owner_or_unclaimed(
        &self,
        owner_label: &str,
        session_id: &str,
    ) -> Result<(), String> {
        validate_owner_and_session(owner_label, session_id)?;
        let leases = self.leases.lock();
        match leases.get(session_id) {
            None => Ok(()),
            Some(lease) if lease.owner_label == owner_label => Ok(()),
            Some(_) => Err(owner_mismatch(session_id)),
        }
    }

    pub fn assert_surface_owner(&self, owner_label: &str, session_id: &str) -> Result<(), String> {
        validate_owner_and_session(owner_label, session_id)?;
        let leases = self.leases.lock();
        require_owner(&leases, owner_label, session_id).map(|_| ())
    }

    pub fn assert_active_owner(&self, owner_label: &str, session_id: &str) -> Result<(), String> {
        validate_owner_and_session(owner_label, session_id)?;
        let leases = self.leases.lock();
        let lease = require_owner(&leases, owner_label, session_id)?;
        if !matches!(lease.phase, LeasePhase::Active(_)) {
            return Err(format!(
                "{SESSION_NOT_ACTIVE}: native RDP session {session_id} has not started"
            ));
        }
        Ok(())
    }

    /// Resolve, approve, and create one session while holding the ownership
    /// lock. There is no renderer-visible grant to steal or replay, and two
    /// racing opens cannot both consume the reserved surface.
    pub(crate) fn authorize_and_open<Resolve, Approve, Open>(
        &self,
        owner_label: &str,
        intent: &OpenIntent,
        resolve: Resolve,
        approve: Approve,
        open: Open,
    ) -> Result<SessionBinding, String>
    where
        Resolve: FnOnce() -> Result<AuthorizedConnection, String>,
        Approve: FnOnce(&SessionBinding) -> Result<(), String>,
        Open: FnOnce(Config) -> Result<(), String>,
    {
        validate_intent(owner_label, intent)?;
        let mut leases = self.leases.lock();
        let lease = require_owner(&leases, owner_label, &intent.session_id)?;
        if !matches!(lease.phase, LeasePhase::SurfaceReserved) {
            return Err(format!(
                "{SESSION_EXISTS}: native RDP session {} already consumed its authorization",
                intent.session_id
            ));
        }

        /* Resolve/approve/open run while the lock is held so no other caller can
         * consume the reserved surface. On any failure the lease is released: a
         * retry after an auth cancel or a connect error must be able to start
         * over instead of finding the id permanently owned. */
        let opened = (|| {
            let mut authorization = resolve()?;
            validate_authorization(owner_label, intent, &authorization)?;
            authorization.config.width = intent.width;
            authorization.config.height = intent.height;
            let binding = binding_from(&authorization);

            approve(&binding)?;
            open(authorization.config)?;
            Ok::<SessionBinding, String>(binding)
        })();

        let opened = match opened {
            Ok(binding) => binding,
            Err(error) => {
                let still_reserved = leases
                    .get(&intent.session_id)
                    .is_some_and(|lease| {
                        lease.owner_label == owner_label
                            && matches!(lease.phase, LeasePhase::SurfaceReserved)
                    });
                if still_reserved {
                    leases.remove(&intent.session_id);
                }
                return Err(error);
            }
        };

        let lease = require_owner_mut(&mut leases, owner_label, &intent.session_id)?;
        if !matches!(lease.phase, LeasePhase::SurfaceReserved) {
            return Err(format!(
                "{SESSION_EXISTS}: native RDP authorization was already consumed"
            ));
        }
        lease.phase = LeasePhase::Active(opened.clone());
        Ok(opened)
    }

    /// Run an owner-scoped operation under the same lease lock used by close.
    /// This makes close versus input deterministic: either input completes
    /// first, or it observes that the lease is gone.
    pub fn with_active<R>(
        &self,
        owner_label: &str,
        session_id: &str,
        operation: impl FnOnce() -> R,
    ) -> Result<R, String> {
        validate_owner_and_session(owner_label, session_id)?;
        let leases = self.leases.lock();
        let lease = require_owner(&leases, owner_label, session_id)?;
        if !matches!(lease.phase, LeasePhase::Active(_)) {
            return Err(format!(
                "{SESSION_NOT_ACTIVE}: native RDP session {session_id} has not started"
            ));
        }
        Ok(operation())
    }

    pub fn close_owned<R>(
        &self,
        owner_label: &str,
        session_id: &str,
        operation: impl FnOnce() -> R,
    ) -> Result<R, String> {
        validate_owner_and_session(owner_label, session_id)?;
        let mut leases = self.leases.lock();
        require_owner(&leases, owner_label, session_id)?;
        let result = operation();
        leases.remove(session_id);
        Ok(result)
    }

    pub fn owned_active_ids(&self, owner_label: &str) -> Vec<String> {
        self.leases
            .lock()
            .iter()
            .filter(|(_, lease)| {
                lease.owner_label == owner_label && matches!(lease.phase, LeasePhase::Active(_))
            })
            .map(|(session_id, _)| session_id.clone())
            .collect()
    }

    pub fn owned_ids(&self, owner_label: &str) -> Vec<String> {
        self.leases
            .lock()
            .iter()
            .filter(|(_, lease)| lease.owner_label == owner_label)
            .map(|(session_id, _)| session_id.clone())
            .collect()
    }

    #[cfg(test)]
    fn binding(&self, session_id: &str) -> Option<SessionBinding> {
        self.leases
            .lock()
            .get(session_id)
            .and_then(|lease| match &lease.phase {
                LeasePhase::Active(binding) => Some(binding.clone()),
                LeasePhase::SurfaceReserved => None,
            })
    }
}

fn validate_intent(owner_label: &str, intent: &OpenIntent) -> Result<(), String> {
    validate_owner_and_session(owner_label, &intent.session_id)?;
    if intent.connection_id.trim().is_empty() || intent.connection_id.len() > 128 {
        return Err(format!(
            "{INVALID_INTENT}: connection id must contain 1 to 128 bytes"
        ));
    }
    if !(320..=8192).contains(&intent.width) || !(240..=8192).contains(&intent.height) {
        return Err(format!(
            "{INVALID_INTENT}: native RDP dimensions are outside the supported range"
        ));
    }
    Ok(())
}

fn validate_owner_and_session(owner_label: &str, session_id: &str) -> Result<(), String> {
    if owner_label.is_empty() || owner_label.len() > 128 {
        return Err(format!("{INVALID_INTENT}: invalid WebView owner"));
    }
    if session_id.trim().is_empty() || session_id.len() > 128 {
        return Err(format!(
            "{INVALID_INTENT}: session id must contain 1 to 128 bytes"
        ));
    }
    Ok(())
}

fn validate_authorization(
    owner_label: &str,
    intent: &OpenIntent,
    authorization: &AuthorizedConnection,
) -> Result<(), String> {
    if authorization.connection_id != intent.connection_id
        || authorization.session_id != intent.session_id
        || authorization.owner_label != owner_label
    {
        return Err(format!(
            "{AUTHORIZATION_MISMATCH}: trusted-core response did not match the requested session"
        ));
    }
    let config = &authorization.config;
    if config.host.trim().is_empty() || config.host.len() > 1024 {
        return Err(format!(
            "{AUTHORIZATION_MISMATCH}: trusted core returned an invalid host"
        ));
    }
    if !(1..=65535).contains(&config.port) {
        return Err(format!(
            "{AUTHORIZATION_MISMATCH}: trusted core returned an invalid port"
        ));
    }
    if config.ignore_certificate || config.security == Security::Rdp {
        return Err(format!(
            "{AUTHORIZATION_MISMATCH}: insecure RDP policy was refused"
        ));
    }
    if !config.password.is_empty() && config.security != Security::Nla {
        return Err(format!(
            "{AUTHORIZATION_MISMATCH}: password credentials require NLA"
        ));
    }
    if !config.drive_name.is_empty() || !config.drive_path.is_empty() {
        return Err(format!(
            "{DRIVE_MAPPING_DISABLED}: native drive mapping is disabled until a handle-based channel is available"
        ));
    }
    Ok(())
}

fn binding_from(authorization: &AuthorizedConnection) -> SessionBinding {
    let config = &authorization.config;
    SessionBinding {
        connection_id: authorization.connection_id.clone(),
        session_id: authorization.session_id.clone(),
        owner_label: authorization.owner_label.clone(),
        host: config.host.clone(),
        port: config.port,
        security: config.security,
        channels: ChannelBinding {
            audio: config.audio,
            microphone: config.microphone,
            clipboard: config.clipboard,
            dynamic_resolution: config.dynamic_resolution,
            gfx: config.gfx,
            drive_mapping: false,
        },
    }
}

fn require_owner<'a>(
    leases: &'a HashMap<String, SurfaceLease>,
    owner_label: &str,
    session_id: &str,
) -> Result<&'a SurfaceLease, String> {
    match leases.get(session_id) {
        None => Err(format!(
            "{SESSION_MISSING}: no native RDP lease for session {session_id}"
        )),
        Some(lease) if lease.owner_label == owner_label => Ok(lease),
        Some(_) => Err(owner_mismatch(session_id)),
    }
}

fn require_owner_mut<'a>(
    leases: &'a mut HashMap<String, SurfaceLease>,
    owner_label: &str,
    session_id: &str,
) -> Result<&'a mut SurfaceLease, String> {
    match leases.get_mut(session_id) {
        None => Err(format!(
            "{SESSION_MISSING}: no native RDP lease for session {session_id}"
        )),
        Some(lease) if lease.owner_label == owner_label => Ok(lease),
        Some(_) => Err(owner_mismatch(session_id)),
    }
}

fn owner_mismatch(session_id: &str) -> String {
    format!("{OWNER_MISMATCH}: invoking WebView does not own native RDP session {session_id}")
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};

    use super::*;

    fn authorization(owner: &str, connection_id: &str, session_id: &str) -> AuthorizedConnection {
        let mut config = Config::default();
        config.host = "rdp.internal".to_owned();
        config.username = "alice".to_owned();
        config.password = "stored-secret".to_owned();
        config.security = Security::Nla;
        AuthorizedConnection {
            connection_id: connection_id.to_owned(),
            session_id: session_id.to_owned(),
            owner_label: owner.to_owned(),
            config,
        }
    }

    fn intent() -> OpenIntent {
        OpenIntent {
            connection_id: "connection-1".to_owned(),
            session_id: "session-1".to_owned(),
            width: 1280,
            height: 720,
        }
    }

    #[test]
    fn authorization_is_consumed_once_and_bound_to_every_security_dimension() {
        let broker = NativeRdpBroker::new();
        let intent = intent();
        broker.claim_surface("main", &intent.session_id).unwrap();
        let opened = AtomicUsize::new(0);
        let binding = broker
            .authorize_and_open(
                "main",
                &intent,
                || Ok(authorization("main", "connection-1", "session-1")),
                |_| Ok(()),
                |config| {
                    assert_eq!(config.width, 1280);
                    assert_eq!(config.height, 720);
                    opened.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(opened.load(Ordering::SeqCst), 1);
        assert_eq!(binding.connection_id, "connection-1");
        assert_eq!(binding.host, "rdp.internal");
        assert_eq!(binding.port, 3389);
        assert_eq!(binding.security, Security::Nla);
        assert!(binding.channels.clipboard);
        assert!(!binding.channels.drive_mapping);

        let replay = broker
            .authorize_and_open(
                "main",
                &intent,
                || Ok(authorization("main", "connection-1", "session-1")),
                |_| Ok(()),
                |_| Ok(()),
            )
            .unwrap_err();
        assert!(replay.starts_with(SESSION_EXISTS));
        assert_eq!(broker.binding("session-1"), Some(binding));
    }

    #[test]
    fn cross_owner_control_and_close_are_refused() {
        let broker = NativeRdpBroker::new();
        let intent = intent();
        broker.claim_surface("owner-a", &intent.session_id).unwrap();
        broker
            .authorize_and_open(
                "owner-a",
                &intent,
                || Ok(authorization("owner-a", "connection-1", "session-1")),
                |_| Ok(()),
                |_| Ok(()),
            )
            .unwrap();

        assert!(broker
            .with_active("owner-b", "session-1", || ())
            .unwrap_err()
            .starts_with(OWNER_MISMATCH));
        assert!(broker
            .close_owned("owner-b", "session-1", || ())
            .unwrap_err()
            .starts_with(OWNER_MISMATCH));
        assert!(broker.with_active("owner-a", "session-1", || ()).is_ok());
    }

    #[test]
    fn a_failed_open_releases_the_reservation_for_retry() {
        let broker = NativeRdpBroker::new();
        let intent = intent();
        broker.claim_surface("main", &intent.session_id).unwrap();

        /* Auth cancel: the approve step fails. The reservation must not leak,
         * or the next connect is told the id is already owned forever. */
        let denied = broker
            .authorize_and_open(
                "main",
                &intent,
                || Ok(authorization("main", "connection-1", "session-1")),
                |_| Err("rdp_native_user_authorization_required: cancelled".to_owned()),
                |_| Ok(()),
            )
            .unwrap_err();
        assert!(denied.starts_with("rdp_native_user_authorization_required"));

        let retried = broker
            .authorize_and_open(
                "main",
                &intent,
                || Ok(authorization("main", "connection-1", "session-1")),
                |_| Ok(()),
                |_| Ok(()),
            );
        assert!(retried.is_ok(), "retry after a failed open must succeed: {retried:?}");
    }

    #[test]
    fn a_failed_connect_releases_the_reservation_for_retry() {
        let broker = NativeRdpBroker::new();
        let intent = intent();
        broker.claim_surface("main", &intent.session_id).unwrap();

        /* Native engine refused the settings. The lease is still only reserved,
         * so the retry must be able to claim it again. */
        let failed = broker
            .authorize_and_open(
                "main",
                &intent,
                || Ok(authorization("main", "connection-1", "session-1")),
                |_| Ok(()),
                |_| Err("rdp_session_create_failed: engine refused".to_owned()),
            )
            .unwrap_err();
        assert!(failed.starts_with("rdp_session_create_failed"));

        assert!(broker
            .authorize_and_open(
                "main",
                &intent,
                || Ok(authorization("main", "connection-1", "session-1")),
                |_| Ok(()),
                |_| Ok(()),
            )
            .is_ok());
    }

    #[test]
    fn racing_connects_have_exactly_one_winner() {
        let broker = Arc::new(NativeRdpBroker::new());
        broker.claim_surface("main", "race-session").unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let opens = Arc::new(AtomicUsize::new(0));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let broker = broker.clone();
            let barrier = barrier.clone();
            let opens = opens.clone();
            workers.push(std::thread::spawn(move || {
                let intent = OpenIntent {
                    connection_id: "race-connection".to_owned(),
                    session_id: "race-session".to_owned(),
                    width: 1024,
                    height: 768,
                };
                barrier.wait();
                broker.authorize_and_open(
                    "main",
                    &intent,
                    || Ok(authorization("main", "race-connection", "race-session")),
                    |_| Ok(()),
                    |_| {
                        opens.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    },
                )
            }));
        }
        barrier.wait();
        let results = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(opens.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn drive_paths_and_mismatched_core_bindings_fail_closed() {
        let broker = NativeRdpBroker::new();
        let intent = intent();
        broker.claim_surface("main", "session-1").unwrap();
        let mismatch = broker
            .authorize_and_open(
                "main",
                &intent,
                || Ok(authorization("main", "other-connection", "session-1")),
                |_| Ok(()),
                |_| Ok(()),
            )
            .unwrap_err();
        assert!(mismatch.starts_with(AUTHORIZATION_MISMATCH));

        let mut mapped = authorization("main", "connection-1", "session-1");
        mapped.config.drive_name = "share".to_owned();
        mapped.config.drive_path = "C:\\private".to_owned();
        let drive = broker
            .authorize_and_open("main", &intent, || Ok(mapped), |_| Ok(()), |_| Ok(()))
            .unwrap_err();
        assert!(drive.starts_with(DRIVE_MAPPING_DISABLED));
    }
}
