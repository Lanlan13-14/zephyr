package one.zephyr.mobile.protocol.ssh

/**
 * Desktop `public/terminal.js` file-kind tables, used so Mobile opens the same preview / editor
 * path the main end would for a given extension.
 */
object SshFileKinds {

    val IMAGE = setOf(
        "jpg", "jpeg", "png", "webp", "gif", "svg", "avif",
        "tif", "tiff", "heic", "heif", "jxl", "jp2", "j2k", "bmp", "dib", "ico", "cur", "icns",
        "psd", "psb", "xcf", "dds", "tga", "hdr", "exr", "pnm", "pbm", "pgm", "ppm", "pam",
        "pcx", "sgi", "ras", "sun", "fits", "fit", "dng", "cr2", "cr3", "nef", "arw", "orf",
        "rw2", "raf", "pef", "srw", "x3f", "mrw", "erf", "kdc", "dcr", "mos",
    )

    val VIDEO = setOf(
        "mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "flv", "f4v", "mpeg", "mpg", "mpe",
        "ts", "mts", "m2ts", "vob", "ogv", "3gp", "3g2", "asf", "rm", "rmvb", "divx", "mxf",
    )

    val AUDIO = setOf(
        "mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "weba", "wma", "alac",
        "aiff", "aif", "ape", "amr", "mid", "midi", "mka", "caf", "ac3", "dts", "m4b",
    )

    val ARCHIVE = setOf(
        "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "tbz", "tbz2", "xz", "txz", "zst",
        "lz", "lzma", "br", "jar", "war", "ear", "apk", "ipa", "deb", "rpm", "pkg", "dmg", "iso",
    )

    val TEXT = setOf(
        "txt", "md", "markdown", "json", "jsonc", "yml", "yaml", "toml", "ini", "cfg", "conf",
        "xml", "html", "htm", "css", "scss", "less", "js", "jsx", "ts", "tsx", "mjs", "cjs",
        "kt", "kts", "java", "go", "rs", "py", "rb", "php", "c", "h", "cc", "cpp", "hpp",
        "cs", "swift", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "sql", "graphql",
        "gradle", "properties", "env", "gitignore", "dockerignore", "editorconfig", "log",
        "csv", "tsv", "svg", "vue", "svelte", "lua", "r", "pl", "pm", "ex", "exs", "erl",
        "hs", "clj", "scala", "groovy", "dart", "proto", "tf", "hcl", "nginx", "service",
    )

    val ARCHIVE_EXTRACTABLE = listOf(
        ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz", ".tar", ".zip", ".gz", ".bz2", ".xz", ".7z",
    )

    fun extensionOf(path: String): String {
        val name = path.substringAfterLast('/').substringAfterLast('\\')
        val dot = name.lastIndexOf('.')
        if (dot <= 0 || dot == name.length - 1) return ""
        return name.substring(dot + 1).lowercase()
    }

    fun archiveExtensionOf(name: String): String {
        val lower = name.lowercase()
        return ARCHIVE_EXTRACTABLE.firstOrNull { lower.endsWith(it) }.orEmpty()
    }

    fun isImage(path: String): Boolean = extensionOf(path) in IMAGE

    fun isVideo(path: String): Boolean = extensionOf(path) in VIDEO

    fun isAudio(path: String): Boolean = extensionOf(path) in AUDIO

    fun isMedia(path: String): Boolean = isVideo(path) || isAudio(path)

    fun isArchive(path: String): Boolean =
        archiveExtensionOf(path).isNotEmpty() || extensionOf(path) in ARCHIVE

    fun isText(path: String): Boolean {
        val ext = extensionOf(path)
        if (ext.isEmpty()) return true
        return ext in TEXT
    }

    fun decodeOctalMode(text: String): Int {
        val trimmed = text.trim()
        require(trimmed.matches(Regex("^[0-7]{3,4}$"))) { "mode 必须是 3–4 位八进制，例如 644 或 0755" }
        return trimmed.toInt(8)
    }

    fun formatOctalMode(mode: Int): String = (mode and 0x1FF).toString(8).padStart(3, '0')

    fun uniqueCopyName(existing: Set<String>, original: String): String {
        if (original !in existing) return original
        val archive = archiveExtensionOf(original)
        val stem = if (archive.isNotEmpty()) original.dropLast(archive.length) else {
            val dot = original.lastIndexOf('.')
            if (dot <= 0) original else original.substring(0, dot)
        }
        val suffix = if (archive.isNotEmpty()) archive else {
            val dot = original.lastIndexOf('.')
            if (dot <= 0) "" else original.substring(dot)
        }
        var index = 1
        while (true) {
            val candidate = if (index == 1) "$stem-复制$suffix" else "$stem-复制$index$suffix"
            if (candidate !in existing) return candidate
            index++
        }
    }

    fun compressCommand(sources: List<String>, target: String): String {
        require(sources.isNotEmpty()) { "缺少压缩项目" }
        val quotedSources = sources.joinToString(" ") { SshRemoteOps.shellQuote(it) }
        val quotedTarget = SshRemoteOps.shellQuote(target)
        val lower = target.lowercase()
        return when {
            lower.endsWith(".zip") -> "zip -r -- $quotedTarget $quotedSources"
            lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2") -> "tar -cjf $quotedTarget $quotedSources"
            lower.endsWith(".tar.xz") || lower.endsWith(".txz") -> "tar -cJf $quotedTarget $quotedSources"
            else -> "tar -czf $quotedTarget $quotedSources"
        }
    }

    fun extractCommand(archive: String, targetDir: String): String {
        val quotedArchive = SshRemoteOps.shellQuote(archive)
        val quotedDir = SshRemoteOps.shellQuote(targetDir)
        val lower = archive.lowercase()
        return when {
            lower.endsWith(".zip") -> "mkdir -p $quotedDir && unzip -o $quotedArchive -d $quotedDir"
            lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2") || lower.endsWith(".bz2") ->
                "mkdir -p $quotedDir && tar -xjf $quotedArchive -C $quotedDir"
            lower.endsWith(".tar.xz") || lower.endsWith(".txz") || lower.endsWith(".xz") ->
                "mkdir -p $quotedDir && tar -xJf $quotedArchive -C $quotedDir"
            else -> "mkdir -p $quotedDir && tar -xzf $quotedArchive -C $quotedDir"
        }
    }

    fun copyCommand(sources: List<String>, directory: String, cut: Boolean): String {
        require(sources.isNotEmpty()) { "没有可粘贴的项目" }
        val dest = SshRemoteOps.shellQuote(directory)
        val quoted = sources.joinToString(" ") { SshRemoteOps.shellQuote(it) }
        return if (cut) {
            "mkdir -p $dest && mv -- $quoted $dest"
        } else {
            "mkdir -p $dest && cp -a -- $quoted $dest"
        }
    }

    fun recursiveDeleteCommand(path: String): String {
        require(path.isNotBlank() && path != "/") { "拒绝删除空路径或根目录" }
        return "rm -rf -- ${SshRemoteOps.shellQuote(path)}"
    }

    fun treePropertiesCommand(path: String): String =
        "python3 - <<'PY'\n" +
            "import os, json\n" +
            "root = ${jsonString(path)}\n" +
            "size = 0\n" +
            "files = 0\n" +
            "dirs = 0\n" +
            "mtime = 0\n" +
            "try:\n" +
            "    st = os.lstat(root)\n" +
            "    mtime = int(st.st_mtime)\n" +
            "    if os.path.isdir(root) and not os.path.islink(root):\n" +
            "        for dirpath, dirnames, filenames in os.walk(root):\n" +
            "            dirs += len(dirnames)\n" +
            "            files += len(filenames)\n" +
            "            for name in filenames:\n" +
            "                fp = os.path.join(dirpath, name)\n" +
            "                try:\n" +
            "                    size += os.lstat(fp).st_size\n" +
            "                except OSError:\n" +
            "                    pass\n" +
            "        dirs += 1\n" +
            "    else:\n" +
            "        files = 1\n" +
            "        size = st.st_size\n" +
            "except OSError as err:\n" +
            "    print(json.dumps({'error': str(err)}))\n" +
            "    raise SystemExit(1)\n" +
            "print(json.dumps({'path': root, 'size': size, 'fileCount': files, 'dirCount': dirs, 'mtime': mtime}))\n" +
            "PY"

    fun parseTreeProperties(raw: String): RemoteTreeProperties {
        val line = raw.lineSequence().map(String::trim).lastOrNull { it.startsWith("{") }
            ?: error("属性响应无效")
        val map = SshRemoteOps.parseFlatJsonObject(line)
        if (map["error"]?.isNotBlank() == true) error(map.getValue("error"))
        return RemoteTreeProperties(
            path = map["path"].orEmpty(),
            sizeBytes = map["size"]?.toLongOrNull() ?: 0L,
            fileCount = map["fileCount"]?.toIntOrNull() ?: 0,
            dirCount = map["dirCount"]?.toIntOrNull() ?: 0,
            mtimeSec = map["mtime"]?.toLongOrNull() ?: 0L,
        )
    }

    private fun jsonString(value: String): String =
        "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
}

data class RemoteTreeProperties(
    val path: String,
    val sizeBytes: Long,
    val fileCount: Int,
    val dirCount: Int,
    val mtimeSec: Long,
)
