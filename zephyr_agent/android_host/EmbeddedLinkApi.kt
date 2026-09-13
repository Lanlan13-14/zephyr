package com.zephyr.agent

import android.util.Base64
import org.json.JSONObject

internal class EmbeddedLinkApi(private val process: EmbeddedLinkProcess) {
    data class Session(val id: String, val exporter: String)
    private var session: Session? = null
    private var peerUrl: String? = null

    fun dial(serverUrl: String, deviceId: String): Session {
        val response = JSONObject(process.post("/link/dial", JSONObject().apply {
            put("serverUrl", serverUrl.trimEnd('/') + "/api/link/v2")
            put("deviceId", deviceId)
        }.toString()))
        // Enrollment proof is intentionally required. The signing operation is
        // owned by the platform keystore and must be added before production use.
        if (response.optBoolean("pending", false)) error("Link 设备签名尚未配置；需要 Android Keystore 完成 enrollment proof")
        if (!response.optBoolean("ok", false)) error(response.optJSONObject("error")?.optString("message") ?: "Link 拨号失败")
        return Session(response.getString("sessionId"), response.optString("exporter")).also {
            session = it
            peerUrl = serverUrl.trimEnd('/') + "/api/link/v2"
        }
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
}
