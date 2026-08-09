package one.zephyr.mobile.protocol.zft2

/**
 * Virtual-path validation for the ZFT2 provider.
 *
 * DEVELOPMENT.md 13.4 requires every virtual path to be rejected for NUL bytes, empty segments,
 * `.`, `..`, absolute host paths and platform separator escapes *before* it is mapped onto the
 * authorised root. This runs as pure logic so the jail is unit-testable without SAF or a
 * security-scoped URL, and so Android and iOS cannot drift into two different interpretations.
 *
 * The validator deliberately does not touch the filesystem: resolving symlinks and refusing the
 * ones that leave the root is the platform provider's job, because only it knows the real root.
 */
object VirtualPath {

    /** Longest single segment. Guards against filesystem-specific name limits and log spam. */
    const val MAX_SEGMENT_LENGTH = 255

    /** Longest whole path. Bounds the work a hostile peer can force per frame. */
    const val MAX_PATH_LENGTH = 4096

    /** Deepest nesting accepted. A path bomb is cheaper to reject than to walk. */
    const val MAX_DEPTH = 64

    /**
     * Normalises a peer-supplied path to a canonical `/a/b` form.
     *
     * @throws Zft2Exception `invalid_path` for anything suspicious. There is intentionally no
     *   "best effort" repair: silently rewriting a traversal attempt into a valid path is how
     *   jails are escaped, so a rejected path stays rejected.
     */
    fun normalize(raw: String?): String {
        val input = raw ?: throw Zft2Exception("invalid_path", "Path is required")
        if (input.length > MAX_PATH_LENGTH) throw Zft2Exception("invalid_path", "Path is too long")
        if (input.contains('\u0000')) throw Zft2Exception("invalid_path", "Path contains NUL")

        // Windows-style separators and drive letters never appear in a virtual path. Accepting them
        // would let a peer address the host filesystem on a desktop provider.
        if (input.contains('\\')) throw Zft2Exception("invalid_path", "Backslash is not a path separator")
        if (input.length >= 2 && input[1] == ':') throw Zft2Exception("invalid_path", "Drive-letter paths are rejected")
        // A UNC path would resolve off-device entirely.
        if (input.startsWith("//")) throw Zft2Exception("invalid_path", "UNC paths are rejected")

        val segments = input.split('/').filter { it.isNotEmpty() }
        if (segments.size > MAX_DEPTH) throw Zft2Exception("invalid_path", "Path is too deep")
        for (segment in segments) {
            if (segment == "." || segment == "..") {
                throw Zft2Exception("invalid_path", "Relative segments are rejected")
            }
            if (segment.length > MAX_SEGMENT_LENGTH) throw Zft2Exception("invalid_path", "Path segment is too long")
            // Control characters are not legal in a shared file name and are a classic way to
            // spoof a name in the main end's file browser.
            if (segment.any { it.code < 0x20 || it.code == 0x7f }) {
                throw Zft2Exception("invalid_path", "Path contains control characters")
            }
        }
        return if (segments.isEmpty()) "/" else "/" + segments.joinToString("/")
    }

    /** True when [candidate] is the root itself or sits underneath it, both already normalised. */
    fun isWithin(root: String, candidate: String): Boolean =
        candidate == root || candidate.startsWith(if (root.endsWith("/")) root else root + "/")

    /** Last segment of a normalised path, empty for the root. */
    fun basename(normalized: String): String = normalized.substringAfterLast('/')

    /** Parent of a normalised path; the root is its own parent. */
    fun parent(normalized: String): String {
        val cut = normalized.lastIndexOf('/')
        if (cut <= 0) return "/"
        return normalized.substring(0, cut)
    }
}
