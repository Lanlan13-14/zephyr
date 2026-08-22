'use strict';

const ACTION_AUTHORIZE_OPEN = 'rdp_native.authorize_open';
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function fail(res, status, code, message) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    return res.status(status).json({ ok: false, code, error: message });
}

function normalizeAudioMode(value) {
    return ['local', 'remote', 'off'].includes(value) ? value : 'local';
}

function qualityPolicy(value) {
    if (value === 'performance') {
        return {
            dynamicResolution: true,
            gfx: true,
            disableWallpaper: true,
            disableThemes: true,
            disableMenuAnims: true,
            disableFullWindowDrag: true,
            allowFontSmoothing: false,
        };
    }
    if (value === 'quality') {
        return {
            dynamicResolution: true,
            gfx: true,
            disableWallpaper: false,
            disableThemes: false,
            disableMenuAnims: false,
            disableFullWindowDrag: false,
            allowFontSmoothing: true,
        };
    }
    return {
        dynamicResolution: true,
        gfx: true,
        disableWallpaper: false,
        disableThemes: false,
        disableMenuAnims: false,
        disableFullWindowDrag: false,
        allowFontSmoothing: true,
    };
}

function nativeAuthorization(connection, binding) {
    const password = String(connection.password || '');
    const quality = qualityPolicy(String(connection.rdpQuality || 'balanced'));
    return {
        connectionId: binding.connectionId,
        sessionId: binding.sessionId,
        ownerLabel: binding.ownerLabel,
        host: String(connection.host || '').trim(),
        port: Number(connection.port) || 3389,
        username: String(connection.username || ''),
        password,
        domain: String(connection.rdpDomain || ''),
        security: password ? 'nla' : 'auto',
        ignoreCertificate: false,
        audioMode: normalizeAudioMode(String(connection.rdpSoundMode || 'local')),
        microphone: connection.rdpMicrophone === true,
        clipboard: connection.rdpClipboard !== false,
        driveMappingRequested: connection.rdpStorage === true,
        ...quality,
    };
}

/**
 * Mount the only secret-bearing desktop RDP bridge.
 *
 * `requireUser` binds the request to the Rust-retained embedded app session;
 * `verifyShellRequest` binds it to this exact Tauri process and atomically
 * consumes the request nonce. A normal page has the first authority but never
 * the second.
 */
function mountRoutes(app, {
    requireUser,
    authorizeConnection,
    verifyShellRequest,
    logger = console,
} = {}) {
    if (!app || typeof app.post !== 'function') throw new Error('native RDP broker requires an app');
    if (typeof requireUser !== 'function') throw new Error('native RDP broker requires user authentication');
    if (typeof authorizeConnection !== 'function') throw new Error('native RDP broker requires connection authorization');
    if (typeof verifyShellRequest !== 'function') throw new Error('native RDP broker requires shell authentication');

    app.post('/api/one/rdp/native/authorize-open', requireUser, (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const binding = {
            connectionId: String(body.connectionId || ''),
            sessionId: String(body.sessionId || ''),
            ownerLabel: String(body.ownerLabel || ''),
        };
        if (!SAFE_ID.test(binding.connectionId)
            || !SAFE_ID.test(binding.sessionId)
            || !SAFE_ID.test(binding.ownerLabel)) {
            return fail(res, 400, 'rdp_native_invalid_intent', 'invalid native RDP intent');
        }

        const shell = verifyShellRequest(
            req,
            ACTION_AUTHORIZE_OPEN,
            [binding.connectionId, binding.sessionId, binding.ownerLabel],
        );
        if (!shell?.ok) {
            return fail(res, shell?.reason === 'unconfigured' ? 503 : 403, 'shell_auth_required', 'shell authentication required');
        }

        try {
            const connection = authorizeConnection(req.user, binding.connectionId, 'use');
            if (!connection || String(connection.protocol || '').toUpperCase() !== 'RDP') {
                return fail(res, 404, 'rdp_native_connection_unavailable', 'RDP connection unavailable');
            }
            if (String(connection.connectionMode || 'direct') !== 'direct') {
                return fail(res, 409, 'rdp_native_route_unsupported', 'native RDP currently requires a direct connection');
            }
            const authorization = nativeAuthorization(connection, binding);
            if (!authorization.host || authorization.port < 1 || authorization.port > 65535) {
                return fail(res, 422, 'rdp_native_connection_invalid', 'stored RDP target is invalid');
            }
            if (authorization.driveMappingRequested) {
                return fail(
                    res,
                    409,
                    'rdp_drive_mapping_disabled',
                    'native drive mapping is disabled until a handle-based channel is available',
                );
            }
            logger.info?.('[rdp-native-broker] authorized native session', {
                connectionId: binding.connectionId,
                sessionId: binding.sessionId,
                userId: req.user?.userId || '',
            });
            return res.status(200).json(authorization);
        } catch (error) {
            const status = Number(error?.status) || 403;
            const code = String(error?.code || 'rdp_native_authorization_denied');
            /* A deny and a dead core both surface as "cannot connect"; only the
             * deny is retryable through the ACL path, so it must be logged apart
             * from transport failures. */
            logger.warn?.('[rdp-native-broker] authorization denied', {
                connectionId: binding.connectionId,
                sessionId: binding.sessionId,
                code,
                status,
            });
            return fail(res, status, code, 'native RDP authorization denied');
        }
    });
}

module.exports = {
    ACTION_AUTHORIZE_OPEN,
    mountRoutes,
    nativeAuthorization,
};
