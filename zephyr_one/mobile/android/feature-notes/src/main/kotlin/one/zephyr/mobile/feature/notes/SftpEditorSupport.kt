package one.zephyr.mobile.feature.notes

import one.zephyr.mobile.protocol.ssh.SshRemoteOps

/**
 * Desktop editor extras that do not need Monaco: language label, outline, in-file find
 * and a bounded workspace grep over the current SFTP directory.
 */
object SftpEditorSupport {

    data class OutlineItem(val name: String, val line: Int, val kind: String)

    data class FindHit(val line: Int, val column: Int, val text: String)

    data class WorkspaceHit(val path: String, val line: Int, val text: String)

    fun languageOf(path: String): String {
        val ext = RemotePath.extensionOf(path)
        return when (ext) {
            "kt", "kts" -> "Kotlin"
            "java" -> "Java"
            "js", "mjs", "cjs" -> "JavaScript"
            "ts", "tsx" -> "TypeScript"
            "py" -> "Python"
            "go" -> "Go"
            "rs" -> "Rust"
            "rb" -> "Ruby"
            "php" -> "PHP"
            "c", "h" -> "C"
            "cc", "cpp", "hpp", "cxx" -> "C++"
            "cs" -> "C#"
            "swift" -> "Swift"
            "sh", "bash", "zsh" -> "Shell"
            "json", "jsonc" -> "JSON"
            "yml", "yaml" -> "YAML"
            "xml", "html", "htm" -> "Markup"
            "css", "scss", "less" -> "CSS"
            "md", "markdown" -> "Markdown"
            "sql" -> "SQL"
            "toml", "ini", "cfg", "conf", "properties" -> "Config"
            else -> if (ext.isBlank()) "Text" else ext.uppercase()
        }
    }

    fun outline(text: String, path: String): List<OutlineItem> {
        val language = languageOf(path).lowercase()
        val patterns = when {
            language in setOf("kotlin", "java", "javascript", "typescript", "c#", "swift") ->
                listOf(
                    Regex("""^\s*(?:(?:public|private|protected|internal|open|override|suspend|fun|function|class|interface|object|enum|struct)\s+)+([A-Za-z_][\w.]*)"""),
                    Regex("""^\s*(?:def|class|interface)\s+([A-Za-z_]\w*)"""),
                )
            language == "python" || language == "ruby" ->
                listOf(Regex("""^\s*(?:def|class|async\s+def)\s+([A-Za-z_]\w*)"""))
            language == "go" ->
                listOf(Regex("""^\s*func\s+(?:\([^)]+\)\s+)?([A-Za-z_]\w*)"""))
            language == "rust" ->
                listOf(Regex("""^\s*(?:pub\s+)?(?:fn|struct|enum|trait|impl)\s+([A-Za-z_]\w*)"""))
            else ->
                listOf(
                    Regex("""^\s*(?:function|def|class|fun|func|fn)\s+([A-Za-z_]\w*)"""),
                    Regex("""^\s{0,3}#{1,3}\s+(.+?)\s*$"""),
                )
        }
        val items = ArrayList<OutlineItem>()
        text.lineSequence().forEachIndexed { index, line ->
            for (pattern in patterns) {
                val match = pattern.find(line) ?: continue
                items += OutlineItem(match.groupValues[1].trim(), index + 1, "symbol")
                break
            }
        }
        return items.take(400)
    }

    fun findInText(text: String, query: String, ignoreCase: Boolean = true): List<FindHit> {
        val needle = query.trim()
        if (needle.isEmpty()) return emptyList()
        val hits = ArrayList<FindHit>()
        text.lineSequence().forEachIndexed { index, line ->
            var from = 0
            val hay = if (ignoreCase) line.lowercase() else line
            val pin = if (ignoreCase) needle.lowercase() else needle
            while (from <= hay.length) {
                val at = hay.indexOf(pin, from)
                if (at < 0) break
                hits += FindHit(index + 1, at + 1, line.trim().take(200))
                from = at + pin.length.coerceAtLeast(1)
                if (hits.size >= 500) return hits
            }
        }
        return hits
    }

    fun formatDocument(text: String, tabSize: Int, useTabs: Boolean = false): String {
        val indent = if (useTabs) "\t" else " ".repeat(tabSize.coerceIn(2, 8))
        val lines = text.replace("\r\n", "\n").replace('\r', '\n').split('\n')
        var depth = 0
        val out = ArrayList<String>(lines.size)
        for (raw in lines) {
            val trimmed = raw.trim()
            val closes = trimmed.startsWith("}") || trimmed.startsWith("]") || trimmed.startsWith(")")
            if (closes) depth = (depth - 1).coerceAtLeast(0)
            out += if (trimmed.isEmpty()) "" else indent.repeat(depth) + trimmed
            val opens = trimmed.endsWith("{") || trimmed.endsWith("[") || trimmed.endsWith("(")
            if (opens && !trimmed.startsWith("}")) depth += 1
        }
        return out.joinToString("\n")
    }

    fun workspaceSearchCommand(directory: String, query: String, maxFiles: Int = 80): String {
        val encoded = java.util.Base64.getEncoder().encodeToString(query.toByteArray(Charsets.UTF_8))
        return """
python3 - "$encoded" ${SshRemoteOps.shellQuote(directory)} $maxFiles <<'PY'
import base64, json, os, sys
query = base64.b64decode(sys.argv[1]).decode('utf-8', 'replace')
root = sys.argv[2]
limit = int(sys.argv[3])
hits = []
scanned = 0
skip_ext = {'.png','.jpg','.jpeg','.gif','.webp','.mp4','.mkv','.mp3','.zip','.gz','.tar','.7z','.woff','.ttf','.so','.bin','.exe'}
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if d not in {'.git','node_modules','.cache'}][:40]
    for name in filenames:
        if scanned >= limit or len(hits) >= 200:
            print(json.dumps({'hits': hits, 'filesScanned': scanned}))
            raise SystemExit(0)
        ext = os.path.splitext(name)[1].lower()
        if ext in skip_ext:
            continue
        path = os.path.join(dirpath, name)
        try:
            size = os.lstat(path).st_size
        except OSError:
            continue
        if size > 512 * 1024:
            continue
        scanned += 1
        try:
            with open(path, 'rb') as fh:
                raw = fh.read()
            if b'\x00' in raw:
                continue
            text = raw.decode('utf-8', 'replace')
        except OSError:
            continue
        for index, line in enumerate(text.splitlines(), 1):
            if query in line:
                hits.append({'path': path, 'line': index, 'text': line.strip()[:200]})
                if len(hits) >= 200:
                    break
print(json.dumps({'hits': hits, 'filesScanned': scanned}))
PY
        """.trimIndent()
    }

    fun parseWorkspaceHits(raw: String): Pair<List<WorkspaceHit>, Int> {
        val line = raw.lineSequence().map(String::trim).lastOrNull { it.startsWith("{") } ?: return emptyList<WorkspaceHit>() to 0
        val map = SshRemoteOps.parseFlatJsonObject(line)
        val scanned = map["filesScanned"]?.toIntOrNull() ?: 0
        val hitsRaw = line.substringAfter("\"hits\":", "[]")
        val hits = ArrayList<WorkspaceHit>()
        val objectPattern = Regex("""\{[^{}]+\}""")
        for (blob in objectPattern.findAll(hitsRaw)) {
            val item = SshRemoteOps.parseFlatJsonObject(blob.value)
            val path = item["path"] ?: continue
            hits += WorkspaceHit(path, item["line"]?.toIntOrNull() ?: 1, item["text"].orEmpty())
        }
        return hits to scanned
    }
}
