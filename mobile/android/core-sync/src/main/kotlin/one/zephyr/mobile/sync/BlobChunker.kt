package one.zephyr.mobile.sync

import one.zephyr.mobile.contracts.SyncContract

/** One slice of a blob transfer. */
data class BlobChunk(
    val index: Int,
    val offset: Long,
    val length: Int,
) {
    val endExclusive: Long get() = offset + length
}

/**
 * Splits a blob into the frozen 4 MiB chunks.
 *
 * Chunking exists so a large note attachment or key file can be resumed rather than restarted: the
 * transfer row records receivedBytes, and [chunksFrom] recomputes only the remaining slices.
 * SYNC_STATE_MACHINE.md 8 fixes the size, so it is read from the contract rather than tuned here.
 */
object BlobChunker {

    const val CHUNK_BYTES: Int = SyncContract.BLOB_CHUNK_BYTES

    fun chunks(totalBytes: Long, chunkBytes: Int = CHUNK_BYTES): List<BlobChunk> =
        chunksFrom(0L, totalBytes, chunkBytes)

    /**
     * @param receivedBytes bytes already durably stored. Resuming from a byte offset rather than a
     *   chunk index keeps the transfer correct even if the negotiated chunk size changed between
     *   rounds.
     */
    fun chunksFrom(receivedBytes: Long, totalBytes: Long, chunkBytes: Int = CHUNK_BYTES): List<BlobChunk> {
        require(chunkBytes > 0) { "chunk size must be positive" }
        require(totalBytes >= 0) { "blob size cannot be negative" }
        require(receivedBytes in 0..totalBytes) { "receivedBytes must be within the blob" }

        val chunks = mutableListOf<BlobChunk>()
        var offset = receivedBytes
        var index = (receivedBytes / chunkBytes).toInt()
        while (offset < totalBytes) {
            val length = minOf(chunkBytes.toLong(), totalBytes - offset).toInt()
            chunks.add(BlobChunk(index = index, offset = offset, length = length))
            offset += length
            index += 1
        }
        return chunks
    }

    fun chunkCount(totalBytes: Long, chunkBytes: Int = CHUNK_BYTES): Int {
        require(chunkBytes > 0) { "chunk size must be positive" }
        if (totalBytes <= 0) return 0
        return ((totalBytes + chunkBytes - 1) / chunkBytes).toInt()
    }

    /** Progress fraction for the file sync card; null when the total is unknown. */
    fun fraction(receivedBytes: Long, totalBytes: Long?): Float? {
        val total = totalBytes ?: return null
        if (total <= 0) return null
        return (receivedBytes.toFloat() / total).coerceIn(0f, 1f)
    }
}
