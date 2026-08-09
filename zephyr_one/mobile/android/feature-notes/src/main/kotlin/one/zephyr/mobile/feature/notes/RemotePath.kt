package one.zephyr.mobile.feature.notes

/**
 * POSIX path arithmetic for the S31 breadcrumb.
 *
 * Kept pure and separate from the engine because the breadcrumb, the "up" action and every
 * join are the parts most likely to produce a wrong request: a stray double slash or a swallowed
 * root turns a listing into a missing directory. java.io.File is deliberately not used because it
 * would apply Windows separator rules on the host running the tests.
 */
object RemotePath {

    const val ROOT = "/"
    const val SEPARATOR = '/'

    /** Collapses repeats, resolves . and .., and always returns an absolute path. */
    fun normalize(raw: String): String {
        val stack = ArrayList<String>()
        for (segment in raw.split(SEPARATOR)) {
            when (segment) {
                "", "." -> Unit
                ".." -> if (stack.isNotEmpty()) stack.removeAt(stack.size - 1)
                else -> stack.add(segment)
            }
        }
        if (stack.isEmpty()) return ROOT
        return ROOT + stack.joinToString(ROOT)
    }

    fun join(directory: String, name: String): String {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return normalize(directory)
        return normalize(directory + ROOT + trimmed)
    }

    fun parentOf(path: String): String {
        val normalized = normalize(path)
        if (normalized == ROOT) return ROOT
        val cut = normalized.lastIndexOf(SEPARATOR)
        if (cut <= 0) return ROOT
        return normalized.substring(0, cut)
    }

    fun nameOf(path: String): String {
        val normalized = normalize(path)
        if (normalized == ROOT) return ROOT
        return normalized.substring(normalized.lastIndexOf(SEPARATOR) + 1)
    }

    /** File extension in lower case, without the dot. Empty when there is none. */
    fun extensionOf(path: String): String {
        val name = nameOf(path)
        val dot = name.lastIndexOf('.')
        if (dot <= 0 || dot == name.length - 1) return ""
        return name.substring(dot + 1).lowercase()
    }

    fun isAtRoot(path: String): Boolean = normalize(path) == ROOT

    /**
     * Breadcrumb segments from root to the given directory.
     *
     * The first crumb is always the root so the user can always get back to a known place, which is
     * the recovery path out of the missing-directory state.
     */
    fun crumbs(path: String): List<Crumb> {
        val normalized = normalize(path)
        val result = ArrayList<Crumb>()
        result.add(Crumb(name = ROOT, path = ROOT))
        if (normalized == ROOT) return result
        var current = ""
        for (segment in normalized.trim(SEPARATOR).split(SEPARATOR)) {
            current = current + ROOT + segment
            result.add(Crumb(name = segment, path = current))
        }
        return result
    }

    /**
     * Rejects a name that would escape the current directory.
     *
     * A new file or a rename target is a *name*, not a path: allowing a separator would let a
     * rename move a file somewhere the user never navigated to, which is not what the dialog says
     * it does.
     */
    fun isValidLeafName(name: String): Boolean {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return false
        if (trimmed == "." || trimmed == "..") return false
        if (trimmed.contains(SEPARATOR)) return false
        return !trimmed.contains('\u0000')
    }

    data class Crumb(val name: String, val path: String)
}
