package one.zephyr.mobile.protocol.ffmpeg

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FfmpegImageTest {

    @Test
    fun browserDirectMatchesDesktopWasmTable() {
        assertEquals(
            setOf("jpg", "jpeg", "png", "webp", "gif", "avif", "bmp"),
            FfmpegImage.BROWSER_DIRECT,
        )
    }

    @Test
    fun ceilingsMatchDesktopPreviewWasm() {
        assertEquals(4096, FfmpegImage.MAX_EDGE)
        assertEquals(32 * 1024 * 1024, FfmpegImage.MAX_PIXELS)
        assertEquals("ffmpeg-6.1.2", FfmpegImage.ENGINE)
    }

    @Test
    fun extensionParserIgnoresDotfilesAndPaths() {
        assertEquals("jxl", FfmpegImage.extensionOf("/var/photo.JXL"))
        assertEquals("heic", FfmpegImage.extensionOf("C:\\tmp\\clip.Heic"))
        assertEquals("", FfmpegImage.extensionOf(".gitignore"))
        assertEquals("", FfmpegImage.extensionOf("README"))
        assertEquals("png", FfmpegImage.extensionOf("a.b.png"))
    }

    @Test
    fun platformSetDoesNotSwallowFfmpegFormats() {
        assertFalse("jxl" in FfmpegImage.BROWSER_DIRECT)
        assertFalse("tif" in FfmpegImage.BROWSER_DIRECT)
        assertFalse("psd" in FfmpegImage.BROWSER_DIRECT)
        assertFalse("exr" in FfmpegImage.BROWSER_DIRECT)
        assertTrue("jpg" in FfmpegImage.BROWSER_DIRECT)
        assertTrue("webp" in FfmpegImage.BROWSER_DIRECT)
    }
}
