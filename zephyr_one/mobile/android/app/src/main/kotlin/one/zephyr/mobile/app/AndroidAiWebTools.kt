package one.zephyr.mobile.app

import java.net.URI
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request

/** Public-web helpers used by the local AI host. Mirrors the main-end DuckDuckGo HTML path. */
internal object AndroidAiWebTools {
    data class SearchHit(val title: String, val url: String, val snippet: String)

    fun search(http: OkHttpClient, query: String, maxResults: Int): List<SearchHit> {
        val url = "https://duckduckgo.com/html/?q=" + java.net.URLEncoder.encode(query, Charsets.UTF_8.name())
        val html = requestText(http, url)
        return parseDuckDuckGo(html, maxResults)
    }

    fun fetch(http: OkHttpClient, url: String, maxChars: Int): String {
        val parsed = URI(url)
        if (parsed.scheme != "http" && parsed.scheme != "https") {
            throw IllegalArgumentException("仅支持 http/https URL")
        }
        val body = requestText(http, parsed.toString())
        return stripHtml(body).take(maxChars.coerceIn(1, 120_000))
    }

    fun parseDuckDuckGo(html: String, maxResults: Int): List<SearchHit> {
        val out = ArrayList<SearchHit>(maxResults)
        val primary = Regex(
            """<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)</a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)</a>""",
            RegexOption.IGNORE_CASE,
        )
        for (match in primary.findAll(html)) {
            if (out.size >= maxResults) break
            val link = unwrapDuckDuckGo(htmlDecode(match.groupValues[1]))
            out += SearchHit(stripHtml(match.groupValues[2]), link, stripHtml(match.groupValues[3]))
        }
        if (out.isEmpty()) {
            val simple = Regex("""<a[^>]+href="([^"]+)"[^>]*>([\s\S]{5,220}?)</a>""", RegexOption.IGNORE_CASE)
            for (match in simple.findAll(html)) {
                if (out.size >= maxResults) break
                val title = stripHtml(match.groupValues[2])
                val link = htmlDecode(match.groupValues[1])
                if (title.isNotBlank() && link.startsWith("http")) {
                    out += SearchHit(title, link, "")
                }
            }
        }
        return out
    }

    fun stripHtml(value: String): String =
        htmlDecode(value.replace(Regex("(?is)<script[^>]*>.*?</script>|<style[^>]*>.*?</style>|<[^>]+>"), " "))
            .replace(Regex("\\s+"), " ")
            .trim()

    internal fun htmlDecode(value: String): String = value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")

    private fun unwrapDuckDuckGo(link: String): String = try {
        val parsed = link.toHttpUrl()
        parsed.queryParameter("uddg") ?: link
    } catch (_: Exception) {
        link
    }

    private fun requestText(http: OkHttpClient, url: String): String {
        val request = Request.Builder()
            .url(url)
            .header("User-Agent", "Mozilla/5.0 ZephyrAI/1.0")
            .get()
            .build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IllegalStateException("HTTP ${response.code}")
            return response.body?.string().orEmpty()
        }
    }
}
