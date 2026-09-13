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

    fun dial(serverUrl: String, deviceId: String): Session {
        val response = JSONObject(process.post("/link/dial", JSONObject().apply {
            put("serverUrl", serverUrl.trimEnd('/') + "/api/link/v2")
            put("deviceId", deviceId)
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
                session = it; peerUrl = serverUrl.trimEnd('/') + "/api/link/v2"
            }
        }
        if (!response.optBoolean("ok", false)) error(response.optJSONObject("error")?.optString("message") ?: "Link 拨号失败")
        return Session(response.getString("sessionId"), response.optString("exporter")).also {
            session = it
            peerUrl = serverUrl.trimEnd('/') + "/api/link/v2"
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

    /** Boots the bastion tunnel hub inside the Go runtime. Blocking; call off the UI thread. */
    fun tunnelStart(sessionId: String, peerUrl: String) {
        val s = session ?: error("Link 会话未建立")
        val resolvedSession = if (sessionId.isNotEmpty()) sessionId else s.id
        val resolvedPeer = if (peerUrl.isNotEmpty()) peerUrl else (this.peerUrl ?: "")
        check(resolvedPeer.isNotEmpty()) { "Link 对端未设置" }
        val response = JSONObject(process.post("/link/tunnel/start", JSONObject().apply {
            put("sessionId", resolvedSession)
            put("peerUrl", resolvedPeer)
        }.toString()))
        if (!response.optBoolean("ok", false)) error(response.optJSONObject("error")?.optString("message") ?: "Link 隧道启动失败")
    }
}
