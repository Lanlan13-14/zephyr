package one.zephyr.mobile.sync

import one.zephyr.mobile.contracts.SyncContract
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BlobChunkerTest {

    @Test
    fun `chunk size comes from the contract`() {
        assertEquals(SyncContract.BLOB_CHUNK_BYTES, BlobChunker.CHUNK_BYTES)
        assertEquals(4 * 1024 * 1024, BlobChunker.CHUNK_BYTES)
    }

    @Test
    fun `splits a blob into full chunks plus a remainder`() {
        val chunks = BlobChunker.chunks(totalBytes = 10, chunkBytes = 4)

        assertEquals(3, chunks.size)
        assertEquals(listOf(0, 1, 2), chunks.map { it.index })
        assertEquals(listOf(0L, 4L, 8L), chunks.map { it.offset })
        assertEquals(listOf(4, 4, 2), chunks.map { it.length })
        assertEquals(10L, chunks.last().endExclusive)
    }

    @Test
    fun `resumes from a byte offset rather than a chunk index`() {
        val chunks = BlobChunker.chunksFrom(receivedBytes = 8, totalBytes = 10, chunkBytes = 4)

        // Only the remainder is refetched, and the index continues the original numbering so the
        // server sees the same chunk identity across a reconnect.
        assertEquals(1, chunks.size)
        assertEquals(2, chunks.single().index)
        assertEquals(8L, chunks.single().offset)
        assertEquals(2, chunks.single().length)
    }

    @Test
    fun `resuming mid-chunk refetches from the byte offset`() {
        val chunks = BlobChunker.chunksFrom(receivedBytes = 5, totalBytes = 12, chunkBytes = 4)

        assertEquals(listOf(5L, 9L), chunks.map { it.offset })
        assertEquals(listOf(4, 3), chunks.map { it.length })
    }

    @Test
    fun `a fully received blob needs no chunks`() {
        assertEquals(emptyList<BlobChunk>(), BlobChunker.chunksFrom(receivedBytes = 10, totalBytes = 10, chunkBytes = 4))
        assertEquals(0, BlobChunker.chunkCount(0))
    }

    @Test
    fun `chunk count matches the split`() {
        assertEquals(3, BlobChunker.chunkCount(10, chunkBytes = 4))
        assertEquals(2, BlobChunker.chunkCount(8, chunkBytes = 4))
    }

    @Test
    fun `progress is null when the total is unknown`() {
        assertNull(BlobChunker.fraction(receivedBytes = 5, totalBytes = null))
        assertNull(BlobChunker.fraction(receivedBytes = 5, totalBytes = 0))
        assertEquals(0.5f, BlobChunker.fraction(receivedBytes = 5, totalBytes = 10))
    }
}
