package com.zephyr.agent

import android.util.Base64
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import org.json.JSONObject

internal class EmbeddedLinkApi(private val process: EmbeddedLinkProcess) {
    data class Session(val id: String, val exporter: String)
    private var session: Session? = null
    private var peerUrl: String? = null

    fun signingJwk(deviceId: String): String {
        val alias = "zephyr-agent-link-" + deviceId.replace(Regex("[^A-Za-z0-9_.-]"), "_")
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (!ks.containsAlias(alias)) {
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
                initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256).build())
                generateKeyPair()
            }
        }
        val pub = ks.getCertificate(alias).publicKey as ECPublicKey
        fun coord(v: java.math.BigInteger): String {
            val raw = v.toByteArray()
            val fixed = when {
                raw.size == 32 -> raw
                raw.size == 33 && raw[0] == 0.toByte() -> raw.copyOfRange(1, 33)
                raw.size < 32 -> ByteArray(32 - raw.size) + raw
                else -> error("invalid P-256 coordinate")
            }
            return Base64.encodeToString(fixed, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        }
        return JSONObject().apply { put("kty", "EC"); put("crv", "P-256"); put("x", coord(pub.w.affineX)); put("y", coord(pub.w.affineY)) }.toString()
    }

    /** One-style enrollment proof: ES256 over prefix\0bindId\0deviceId\0
     * userCode\0sas\0sha256hex(secret)\0serverId, base64(P1363). */
    fun enrollmentProof(bindId: String, deviceId: String, userCode: String, sas: String, enrollmentSecret: String, serverId: String): String {
        val secretHash = java.security.MessageDigest.getInstance("SHA-256")
            .digest(enrollmentSecret.toByteArray(Charsets.UTF_8))
            .joinToString("") { b -> "%02x".format(b.toInt() and 0xff) }
        val normalized = userCode.uppercase().replace(Regex("[^A-Z0-9]"), "")
        val payload = listOf("zephyr-link-enrollment-v2", bindId, deviceId, normalized, sas, secretHash, serverId)
            .joinToString("\u0000").toByteArray(Charsets.UTF_8)
        val alias = "zephyr-agent-link-" + deviceId.replace(Regex("[^A-Za-z0-9_.-]"), "_")
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val key = ks.getKey(alias, null) as java.security.PrivateKey
        val der = java.security.Signature.getInstance("SHA256withECDSA").apply { initSign(key); update(payload) }.sign()
        return Base64.encodeToString(derToP1363(der), Base64.NO_WRAP)
    }

    /** Generates an ML-KEM-768 keypair in the Go runtime (loopback, no network). */
    fun mlkemGenerate(deviceId: String): JSONObject =
        JSONObject(process.post("/link/mlkem/generate", "{}"))

    /** Normalizes any server URL to the Link peer root the Go core appends
     *  its leaf paths to. Accepts a bare server URL or an already-normalized
     *  root, so a caller can never hand the core a peer that resolves the
     *  stream upgrade to an unrouted path. */
    private fun linkPeerRoot(serverUrl: String): String {
        val trimmed = serverUrl.trim().trimEnd('/')
        if (trimmed.isEmpty()) return ""
        return if (trimmed.endsWith("/api/link/v2")) trimmed else "$trimmed/api/link/v2"
    }

    fun dial(serverUrl: String, deviceId: String, insecure: Boolean): Session {
        // Go runtime is CGO_ENABLED=0: no Android DNS. Pre-resolve with
        // InetAddress and pass IP + original hostname for SNI/Host.
        val peerRoot = linkPeerRoot(serverUrl)
        val targets = try {
            LinkPeerResolver.resolveAll(peerRoot)
        } catch (_: Exception) {
            listOf(LinkPeerTarget(peerRoot, java.net.URI(peerRoot).host ?: ""))
        }
        var lastError: Exception? = null
        for (target in targets) {
            try {
                return dialOnce(target.url, target.serverName, deviceId, insecure, peerRoot)
            } catch (e: Exception) {
                lastError = e
            }
        }
        throw lastError ?: IllegalStateException("Link 拨号失败")
    }

    private fun dialOnce(dialUrl: String, serverName: String, deviceId: String, insecure: Boolean, peerRoot: String): Session {
        val response = JSONObject(process.post("/link/dial", JSONObject().apply {
            put("serverUrl", dialUrl)
            put("deviceId", deviceId)
            put("insecure", insecure)
            put("serverName", serverName)
        }.toString()))
        if (response.optBoolean("pending", false)) {
            val sessionId = response.getString("sessionId")
            val transcript = Base64.decode(response.getString("transcript"), Base64.URL_SAFE or Base64.NO_PADDING)
            val alias = "zephyr-agent-link-" + deviceId.replace(Regex("[^A-Za-z0-9_.-]"), "_")
            val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val key = keyStore.getKey(alias, null) as java.security.PrivateKey
            val payload = "zephyr-zsl2-handshake-v1\u0000$deviceId\u0000".toByteArray() + transcript
            val der = Signature.getInstance("SHA256withECDSA").apply { initSign(key); update(payload) }.sign()
            val proof = Base64.encodeToString(derToP1363(der), Base64.NO_WRAP)
            val finished = JSONObject(process.post("/link/dial/finish", JSONObject().apply {
                put("sessionId", sessionId); put("proof", proof)
            }.toString()))
            if (!finished.optBoolean("ok", false)) error(finished.optJSONObject("error")?.optString("message") ?: "Link 握手证明失败")
            return Session(finished.getString("sessionId"), finished.optString("exporter")).also {
                session = it
                // Subsequent /link/push must reuse the IP form; SNI lives in
                // the Go sessionTLS recorded at dial time.
                peerUrl = dialUrl
            }
        }
        if (!response.optBoolean("ok", false)) error(response.optJSONObject("error")?.optString("message") ?: "Link 拨号失败")
        return Session(response.getString("sessionId"), response.optString("exporter")).also {
            session = it
            peerUrl = dialUrl
        }
    }

    private fun derToP1363(der: ByteArray): ByteArray {
        var p = 0
        require(der.size > 4 && der[p++].toInt() == 0x30)
        val sequenceLength = der[p++].toInt() and 0xff
        require(sequenceLength <= der.size - p && der[p++].toInt() == 0x02)
        val rLength = der[p++].toInt() and 0xff
        require(rLength > 0 && rLength <= der.size - p)
        val r = der.copyOfRange(p, p + rLength); p += rLength
        require(p < der.size && der[p++].toInt() == 0x02)
        val sLength = der[p++].toInt() and 0xff
        require(sLength > 0 && sLength <= der.size - p)
        val s = der.copyOfRange(p, p + sLength)
        fun fixed(value: ByteArray): ByteArray {
            val raw = value.dropWhile { it == 0.toByte() }.toByteArray()
            require(raw.size <= 32)
            return ByteArray(32 - raw.size) + raw
        }
        return fixed(r) + fixed(s)
    }

    fun push(kind: Int, body: JSONObject): JSONObject {
        val s = session ?: error("Link 会话未建立")
        val peer = peerUrl ?: error("Link 对端未设置")
        val response = JSONObject(process.post("/link/push", JSONObject().apply {
            put("sessionId", s.id)
            put("peerUrl", peer)
            put("kind", kind)
            put("body", body)
            put("secret", false)
        }.toString()))
        if (!response.optBoolean("ok", false)) error(response.optJSONObject("error")?.optString("message") ?: "Link 文件请求失败")
        return response.optJSONObject("ack") ?: JSONObject()
    }

    fun close() { session = null; peerUrl = null }

    /** Boots the bastion tunnel hub inside the Go runtime. Blocking; call off the UI thread.
     *
     * The peer is the URL recorded at dial time, never a caller-supplied one.
     * Two things depend on that: it is the /api/link/v2 root (the Go core
     * appends "/stream", and the main end only routes the WebSocket upgrade at
     * /api/link/v2/stream), and it is the pre-resolved IP form whose SNI the Go
     * sessionTLS table remembers. Passing the bare server URL here dialed
     * https://host/stream, which the main end 404s, so the Agent never attached
     * its stream and every bastion connect failed with "session has no live
     * stream". The argument is kept only as a fallback for a host that has no
     * recorded peer yet, and is normalized to the same root.
     */
    fun tunnelStart(sessionId: String, peerUrl: String) {
        val s = session ?: error("Link 会话未建立")
        val resolvedSession = if (sessionId.isNotEmpty()) sessionId else s.id
        val resolvedPeer = this.peerUrl ?: linkPeerRoot(peerUrl)
        check(resolvedPeer.isNotEmpty()) { "Link 对端未设置" }
        val response = JSONObject(process.post("/link/tunnel/start", JSONObject().apply {
            put("sessionId", resolvedSession)
            put("peerUrl", resolvedPeer)
        }.toString()))
        if (!response.optBoolean("ok", false)) error(response.optJSONObject("error")?.optString("message") ?: "Link 隧道启动失败")
    }
}
