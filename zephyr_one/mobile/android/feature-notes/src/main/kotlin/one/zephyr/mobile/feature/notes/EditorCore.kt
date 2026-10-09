package one.zephyr.mobile.feature.notes

import org.json.JSONObject

/**
 * Android side of the one editorcore document. The native library is the same
 * Go session the desktop host runs. This object stores the document id only;
 * the UTF-8 is read back from the core on save.
 *
 * The JNI symbols are the c-shared exports editorcore_call and editorcore_free.
 * A test can replace [callNative] without loading the library or a JVM device.
 */
internal object EditorCore {
    data class Snapshot(
        val id: Long,
        val version: Long,
        val text: String,
        val base: Int,
        val extent: Int,
    )

    var callNative: (String) -> String = { request ->
        val response = nativeCall(request)
        response
    }

    fun open(text: String): Snapshot = call(JSONObject().put("op", "open").put("text", text))

    fun edit(id: Long, start: Int, end: Int, text: String, base: Int, extent: Int): Snapshot {
        val request = JSONObject()
            .put("op", "replace")
            .put("id", id)
            .put("start", start)
            .put("end", end)
            .put("text", text)
            .put("base", base)
            .put("extent", extent)
            .put("preserve", true)
        return call(request)
    }

    fun select(id: Long, base: Int, extent: Int): Snapshot {
        return call(JSONObject().put("op", "setSelection").put("id", id).put("base", base).put("extent", extent))
    }

    fun selection(id: Long, base: Int, extent: Int): Snapshot = select(id, base, extent)

    fun text(id: Long): String {
        val response = JSONObject(callNative(JSONObject().put("op", "text").put("id", id).toString()))
        if (!response.optBoolean("ok")) error(response.optString("error", "editorcore"))
        return response.optString("text")
    }

    fun command(id: Long, op: String, fields: Map<String, Any?> = emptyMap()): JSONObject {
        val request = JSONObject().put("op", op).put("id", id)
        for ((key, value) in fields) if (value != null) request.put(key, value)
        val response = JSONObject(callNative(request.toString()))
        if (!response.optBoolean("ok")) error(response.optString("error", "editorcore"))
        return response
    }

    fun find(id: Long, query: String, caseSensitive: Boolean = false, regex: Boolean = false, from: Int = 0): JSONObject =
        command(id, "find", mapOf("query" to query, "caseSensitive" to caseSensitive, "regex" to regex, "from" to from)).getJSONObject("payload")

    fun findNext(id: Long, query: String, caseSensitive: Boolean = false, regex: Boolean = false, from: Int = 0): JSONObject =
        command(id, "findNext", mapOf("query" to query, "caseSensitive" to caseSensitive, "regex" to regex, "from" to from))

    fun findPrevious(id: Long, query: String, caseSensitive: Boolean = false, regex: Boolean = false, from: Int = 0): JSONObject =
        command(id, "findPrevious", mapOf("query" to query, "caseSensitive" to caseSensitive, "regex" to regex, "from" to from))

    fun replaceOne(id: Long, query: String, replacement: String, caseSensitive: Boolean = false, regex: Boolean = false, from: Int = 0): Snapshot =
        call(JSONObject().put("op", "replaceOne").put("id", id).put("query", query).put("replacement", replacement).put("caseSensitive", caseSensitive).put("regex", regex).put("from", from))

    fun replaceAll(id: Long, query: String, replacement: String, caseSensitive: Boolean = false, regex: Boolean = false): Snapshot =
        call(JSONObject().put("op", "replaceAll").put("id", id).put("query", query).put("replacement", replacement).put("caseSensitive", caseSensitive).put("regex", regex))

    fun undo(id: Long): Snapshot = call(JSONObject().put("op", "undo").put("id", id))
    fun redo(id: Long): Snapshot = call(JSONObject().put("op", "redo").put("id", id))
    fun indent(id: Long): Snapshot = call(JSONObject().put("op", "indent").put("id", id))
    fun format(id: Long): Snapshot = call(JSONObject().put("op", "format").put("id", id))
    fun trimTrailingWhitespace(id: Long): Snapshot = call(JSONObject().put("op", "trimTrailingWhitespace").put("id", id))
    fun outdent(id: Long): Snapshot = call(JSONObject().put("op", "outdent").put("id", id))
    fun breakLine(id: Long): Snapshot = call(JSONObject().put("op", "breakLine").put("id", id))
    fun toggleComment(id: Long, language: String): Snapshot = call(JSONObject().put("op", "toggleLineComment").put("id", id).put("language", language))
    fun bracket(id: Long, open: String): Snapshot = call(JSONObject().put("op", "bracket").put("id", id).put("text", open))
    fun copy(id: Long): String = command(id, "copy").getJSONObject("payload").optString("text")
    fun cut(id: Long): Pair<Snapshot, String> {
        val response = command(id, "cut")
        return snapshotOf(response) to response.getJSONObject("payload").optString("text")
    }
    fun setTabSize(id: Long, tabSize: Int) { command(id, "setTabSize", mapOf("tabSize" to tabSize)) }
    fun setEncoding(id: Long, encoding: String): JSONObject = command(id, "setEncoding", mapOf("encoding" to encoding)).getJSONObject("payload")
    fun setEol(id: Long, eol: String): JSONObject = command(id, "setEOL", mapOf("eol" to eol)).getJSONObject("payload")
    fun meta(id: Long): JSONObject = command(id, "meta").getJSONObject("payload")
    fun markSaved(id: Long): JSONObject = command(id, "markSaved").getJSONObject("payload")
    fun setReadOnly(id: Long, readOnly: Boolean) { command(id, "setReadOnly", mapOf("readOnly" to readOnly)) }
    fun capabilities(id: Long): JSONObject = command(id, "capabilities").getJSONObject("payload")

    private fun call(request: JSONObject): Snapshot {
        val response = JSONObject(callNative(request.toString()))
        if (!response.optBoolean("ok")) error(response.optString("error", "editorcore"))
        return snapshotOf(response)
    }

    private fun snapshotOf(response: JSONObject): Snapshot {
        val snapshot = response.getJSONObject("snapshot")
        val selection = snapshot.getJSONObject("selection")
        return Snapshot(
            id = snapshot.getLong("id"),
            version = snapshot.getLong("version"),
            text = response.optString("text"),
            base = selection.getInt("base"),
            extent = selection.getInt("extent"),
        )
    }

    private fun nativeCall(request: String): String = EditorCoreNative.call(request)
}

internal object EditorCoreNative {
    init {
        runCatching { System.loadLibrary("editorcore_jni") }
    }

    fun call(request: String): String = nativeCall(request)

    @JvmStatic
    private external fun nativeCall(request: String): String
}
