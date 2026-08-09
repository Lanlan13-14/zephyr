package one.zephyr.mobile.protocol.zft2

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The path jail.
 *
 * Every case here is a documented attack from DEVELOPMENT.md 18 (path traversal, symlink escape) or
 * a platform quirk that would silently widen the jail. A repair-instead-of-reject policy is what
 * turns a traversal attempt into an escape, so the tests assert refusal rather than a rewritten path.
 */
class VirtualPathTest {

    private fun rejected(path: String?) {
        try {
            VirtualPath.normalize(path)
            org.junit.Assert.fail("should have rejected " + path)
        } catch (failure: Zft2Exception) {
            assertEquals("invalid_path", failure.code)
        }
    }

    @Test
    fun collapsesSeparatorsAndTrailingSlashes() {
        assertEquals("/a/b", VirtualPath.normalize("/a/b"))
        assertEquals("/a/b", VirtualPath.normalize("/a/b/"))
        assertEquals("/a/b", VirtualPath.normalize("a/b"))
        assertEquals("/a/b", VirtualPath.normalize("/a///b"))
        assertEquals("/", VirtualPath.normalize("/"))
        assertEquals("/", VirtualPath.normalize(""))
    }

    @Test
    fun rejectsRelativeSegments() {
        rejected("/a/../b")
        rejected("/a/./b")
        rejected("..")
        rejected("/../etc/passwd")
        rejected("a/b/..")
    }

    @Test
    fun rejectsHostPathSyntax() {
        rejected("C:/Windows")
        rejected("/a\\b")
        rejected("//server/share")
    }

    @Test
    fun rejectsNulAndControlCharacters() {
        rejected("/a\u0000b")
        rejected("/a\u0001b")
        rejected("/a\u007fb")
    }

    @Test
    fun rejectsAMissingPath() {
        rejected(null)
    }

    @Test
    fun rejectsOversizedAndOverdeepPaths() {
        rejected("/" + "a".repeat(VirtualPath.MAX_SEGMENT_LENGTH + 1))
        rejected("/" + "a".repeat(VirtualPath.MAX_PATH_LENGTH + 1))
        rejected((1..VirtualPath.MAX_DEPTH + 1).joinToString("") { "/x" })
    }

    @Test
    fun acceptsUnicodeAndSpaces() {
        assertEquals("/\u4e2d\u6587/\u30c6\u30b9\u30c8", VirtualPath.normalize("/\u4e2d\u6587/\u30c6\u30b9\u30c8"))
        assertEquals("/My Files/a b.txt", VirtualPath.normalize("/My Files/a b.txt"))
    }

    @Test
    fun containmentIsPrefixSafeAtASegmentBoundary() {
        assertTrue(VirtualPath.isWithin("/share", "/share"))
        assertTrue(VirtualPath.isWithin("/share", "/share/a"))
        // "/shared" must not count as inside "/share": a plain startsWith would say it is.
        assertFalse(VirtualPath.isWithin("/share", "/shared"))
        assertFalse(VirtualPath.isWithin("/share", "/other"))
        assertTrue(VirtualPath.isWithin("/", "/anything"))
    }

    @Test
    fun basenameAndParent() {
        assertEquals("b.txt", VirtualPath.basename("/a/b.txt"))
        assertEquals("/a", VirtualPath.parent("/a/b.txt"))
        assertEquals("/", VirtualPath.parent("/a"))
        assertEquals("/", VirtualPath.parent("/"))
    }
}
