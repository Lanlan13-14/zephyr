package one.zephyr.mobile.protocol.vnc

import java.io.Closeable
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketException
import java.net.SocketTimeoutException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import one.zephyr.mobile.model.MobileError

/** A real RFB client backed by one blocking [Socket] per session. */
class SocketVncEngine(
    private val connectTimeoutMillis: Int = DEFAULT_CONNECT_TIMEOUT_MILLIS,
    private val operationTimeoutMillis: Long = DEFAULT_OPERATION_TIMEOUT_MILLIS,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val socketFactory: () -> Socket = ::Socket,
) : VncEngine {

    private val engineJob = SupervisorJob()
    private val sessions = ConcurrentHashMap<String, SocketVncSession>()

    override val isAvailable: Boolean = true

    override suspend fun connect(request: VncConnectRequest): VncConnectOutcome {
        validate(request)?.let { return VncConnectOutcome.Failed(it) }
        sessions.remove(request.sessionId)?.shutdown()

        var socket: Socket? = null
        var channel: SocketRfbChannel? = null
        return try {
            socket = withContext(ioDispatcher) {
                socketFactory().apply {
                    tcpNoDelay = true
                    keepAlive = true
                    connect(InetSocketAddress(request.host, request.port), connectTimeoutMillis)
                }
            }
            channel = SocketRfbChannel(socket, ioDispatcher)
            when (val handshake = RfbHandshake.perform(channel, request.password, request.shared)) {
                is RfbHandshakeOutcome.Rejected -> {
                    channel.close()
                    rejected(handshake)
                }

                is RfbHandshakeOutcome.Ready -> {
                    val session = SocketVncSession(
                        request = request,
                        info = handshake.session,
                        channel = channel,
                        scope = CoroutineScope(SupervisorJob(engineJob) + ioDispatcher),
                        operationTimeoutMillis = operationTimeoutMillis,
                        onClosed = { closed -> sessions.remove(request.sessionId, closed) },
                    )
                    session.start()
                    sessions[request.sessionId] = session
                    VncConnectOutcome.Connected(
                        version = handshake.session.version,
                        securityType = handshake.session.securityType,
                        widthPx = handshake.session.width,
                        heightPx = handshake.session.height,
                        desktopName = handshake.session.desktopName,
                        pixelFormat = request.preferredPixelFormat,
                    )
                }
            }
        } catch (cancelled: CancellationException) {
            channel?.close()
            if (channel == null) runCatching { socket?.close() }
            throw cancelled
        } catch (timeout: SocketTimeoutException) {
            channel?.close()
            if (channel == null) runCatching { socket?.close() }
            VncConnectOutcome.Failed(
                MobileError.local(
                    VncErrors.CONNECTION_TIMEOUT,
                    "Timed out connecting to the VNC server",
                    retryable = true,
                ),
            )
        } catch (failure: Exception) {
            channel?.close()
            if (channel == null) runCatching { socket?.close() }
            VncConnectOutcome.Failed(
                MobileError.local(
                    VncErrors.CONNECTION_FAILED,
                    failure.message ?: "Could not connect to the VNC server",
                    retryable = true,
                ),
            )
        }
    }

    override fun frames(sessionId: String): Flow<VncFrame> =
        sessions[sessionId]?.frames ?: emptyFlow()

    override suspend fun send(sessionId: String, event: VncInputEvent) {
        requireSession(sessionId).send(event)
    }

    override suspend fun resize(sessionId: String, widthPx: Int, heightPx: Int): VncSurfaceSize =
        requireSession(sessionId).resize(widthPx, heightPx)

    override suspend fun sendClipboard(sessionId: String, text: String) {
        requireSession(sessionId).sendClipboard(text)
    }

    override fun clipboard(sessionId: String): Flow<String> =
        sessions[sessionId]?.clipboard ?: emptyFlow()

    override suspend fun disconnect(sessionId: String) {
        sessions.remove(sessionId)?.shutdown()
    }

    override suspend fun setPixelFormat(sessionId: String, format: RfbPixelFormat): RfbPixelFormat =
        requireSession(sessionId).setPixelFormat(format)

    /** Closes every session owned by this engine. */
    suspend fun close() {
        val active = sessions.values.toList()
        sessions.clear()
        for (session in active) session.shutdown()
        engineJob.cancel()
    }

    private fun requireSession(sessionId: String): SocketVncSession =
        sessions[sessionId] ?: throw VncSessionException(
            VncErrors.SESSION_NOT_FOUND,
            "No VNC session named " + sessionId,
        )

    private fun validate(request: VncConnectRequest): MobileError? = when {
        request.sessionId.isBlank() -> MobileError.local(
            VncErrors.CONNECTION_FAILED,
            "A VNC session id is required",
        )
        request.host.isBlank() -> MobileError.local(
            VncErrors.CONNECTION_FAILED,
            "A VNC host is required",
        )
        request.port !in 1..0xFFFF -> MobileError.local(
            VncErrors.CONNECTION_FAILED,
            "VNC port is out of range",
        )
        !request.preferredPixelFormat.trueColour -> MobileError.local(
            VncErrors.BAD_PIXEL_FORMAT,
            "The socket engine requires a true-colour pixel format",
        )
        else -> null
    }

    private fun rejected(rejected: RfbHandshakeOutcome.Rejected): VncConnectOutcome =
        if (rejected.code == VncErrors.PASSWORD_REQUIRED ||
            rejected.code == VncErrors.AUTH_FAILED ||
            rejected.code == VncErrors.TOO_MANY_ATTEMPTS
        ) {
            VncConnectOutcome.AuthenticationRequired(
                reason = rejected.detail,
                attemptsExhausted = rejected.code == VncErrors.TOO_MANY_ATTEMPTS,
            )
        } else {
            VncConnectOutcome.Failed(
                MobileError.local(
                    code = rejected.code,
                    message = rejected.detail,
                    retryable = rejected.code == VncErrors.TRUNCATED,
                ),
            )
        }

    private companion object {
        const val DEFAULT_CONNECT_TIMEOUT_MILLIS = 10_000
        const val DEFAULT_OPERATION_TIMEOUT_MILLIS = 5_000L
    }
}

/** Serialises socket writes and turns partial stream reads into exact RFB fields. */
internal class SocketRfbChannel(
    private val socket: Socket,
    private val dispatcher: CoroutineDispatcher,
) : RfbByteChannel, Closeable {

    private val input: InputStream = socket.getInputStream()
    private val output: OutputStream = socket.getOutputStream()
    private val writeMutex = Mutex()

    override suspend fun readFully(count: Int): ByteArray {
        require(count >= 0) { "read count must not be negative" }
        return withContext(dispatcher) {
            val result = ByteArray(count)
            var offset = 0
            while (offset < count) {
                val read = input.read(result, offset, count - offset)
                if (read < 0) throw EOFException("VNC server closed with " + (count - offset) + " bytes unread")
                if (read == 0) continue
                offset += read
            }
            result
        }
    }

    suspend fun discardFully(count: Int) {
        require(count >= 0) { "discard count must not be negative" }
        var remaining = count
        while (remaining > 0) {
            val chunk = minOf(remaining, DISCARD_BUFFER_BYTES)
            readFully(chunk)
            remaining -= chunk
        }
    }

    override suspend fun write(bytes: ByteArray) {
        writeMutex.lock()
        try {
            withContext(dispatcher) {
                output.write(bytes)
                output.flush()
            }
        } finally {
            writeMutex.unlock()
        }
    }

    override fun close() {
        runCatching { socket.close() }
    }

    private companion object {
        const val DISCARD_BUFFER_BYTES = 8 * 1024
    }
}

private class SocketVncSession(
    private val request: VncConnectRequest,
    info: RfbSessionInfo,
    private val channel: SocketRfbChannel,
    private val scope: CoroutineScope,
    private val operationTimeoutMillis: Long,
    private val onClosed: (SocketVncSession) -> Unit,
) {

    private val frameChannel = Channel<VncFrame>(capacity = FRAME_BUFFER_CAPACITY)
    private val clipboardChannel = Channel<String>(capacity = CLIPBOARD_BUFFER_CAPACITY)
    private val sendMutex = Mutex()
    private val stateMutex = Mutex()
    private val formatChangeMutex = Mutex()
    private val resizeMutex = Mutex()
    private val terminated = AtomicBoolean(false)

    val frames: Flow<VncFrame> = frameChannel.receiveAsFlow()
    val clipboard: Flow<String> = clipboardChannel.receiveAsFlow()

    @Volatile
    private var width = info.width

    @Volatile
    private var height = info.height

    @Volatile
    private var pixelFormat = request.preferredPixelFormat

    @Volatile
    private var supportsExtendedDesktopSize = false

    private var framebuffer = RfbFramebuffer(width, height)
    private var requestOutstanding = false
    private var pendingFormat: RfbPixelFormat? = null
    private var pendingFormatResult: CompletableDeferred<RfbPixelFormat>? = null
    private var pendingResize: CompletableDeferred<VncSurfaceSize>? = null
    private var readerJob: Job? = null

    suspend fun start() {
        writeMessages(
            RfbEncoder.setPixelFormat(pixelFormat),
            RfbEncoder.setEncodings(
                RfbEncodingPolicy.advertise(
                    setOf(
                        RfbEncoding.COPY_RECT,
                        RfbEncoding.LAST_RECT,
                        RfbEncoding.DESKTOP_SIZE,
                        RfbEncoding.EXTENDED_DESKTOP_SIZE,
                    ),
                ),
            ),
            RfbEncoder.framebufferUpdateRequest(false, 0, 0, width, height),
        )
        requestOutstanding = true
        readerJob = scope.launch { readLoop() }
    }

    suspend fun send(event: VncInputEvent) {
        ensureOpen()
        if (request.viewOnly) return
        when (event) {
            is VncInputEvent.Key -> writeMessages(RfbEncoder.keyEvent(event.keysym, event.down))
            is VncInputEvent.Pointer -> {
                val x = event.x.coerceIn(0, (width - 1).coerceAtLeast(0))
                val y = event.y.coerceIn(0, (height - 1).coerceAtLeast(0))
                writeMessages(RfbEncoder.pointerEvent(event.buttonMask, x, y))
            }
            is VncInputEvent.Text -> sendText(event.text)
        }
    }

    suspend fun sendClipboard(text: String) {
        ensureOpen()
        if (!request.viewOnly) writeMessages(RfbEncoder.clientCutText(text))
    }

    suspend fun setPixelFormat(format: RfbPixelFormat): RfbPixelFormat {
        require(format.trueColour) { "The socket engine requires a true-colour pixel format" }
        ensureOpen()
        formatChangeMutex.lock()
        try {
            if (format == pixelFormat) return pixelFormat
            val result = CompletableDeferred<RfbPixelFormat>()
            stateMutex.lock()
            try {
                if (requestOutstanding) {
                    pendingFormat = format
                    pendingFormatResult = result
                } else {
                    writeMessages(
                        RfbEncoder.setPixelFormat(format),
                        RfbEncoder.framebufferUpdateRequest(false, 0, 0, width, height),
                    )
                    pixelFormat = format
                    requestOutstanding = true
                    result.complete(format)
                }
            } finally {
                stateMutex.unlock()
            }
            return result.await()
        } finally {
            formatChangeMutex.unlock()
        }
    }

    suspend fun resize(requestedWidth: Int, requestedHeight: Int): VncSurfaceSize {
        require(requestedWidth in 1..0xFFFF) { "width out of range: " + requestedWidth }
        require(requestedHeight in 1..0xFFFF) { "height out of range: " + requestedHeight }
        ensureFramebufferSize(requestedWidth, requestedHeight)
        ensureOpen()
        if (!supportsExtendedDesktopSize) return currentSize(serverResized = false)

        resizeMutex.lock()
        try {
            val result = CompletableDeferred<VncSurfaceSize>()
            stateMutex.lock()
            try {
                pendingResize = result
                writeMessages(RfbEncoder.setDesktopSize(requestedWidth, requestedHeight))
            } finally {
                stateMutex.unlock()
            }
            val completed = withTimeoutOrNull(operationTimeoutMillis) { result.await() }
            stateMutex.lock()
            try {
                if (pendingResize === result) pendingResize = null
            } finally {
                stateMutex.unlock()
            }
            return completed ?: currentSize(serverResized = false)
        } finally {
            resizeMutex.unlock()
        }
    }

    suspend fun shutdown() {
        finish()
        readerJob?.cancelAndJoin()
        scope.cancel()
    }

    private suspend fun readLoop() {
        try {
            while (!terminated.get()) {
                when (val type = readU8()) {
                    RfbServerMessage.FRAMEBUFFER_UPDATE -> readFramebufferUpdate()
                    RfbServerMessage.SET_COLOUR_MAP_ENTRIES -> readColourMapEntries()
                    RfbServerMessage.BELL -> Unit
                    RfbServerMessage.SERVER_CUT_TEXT -> readServerCutText()
                    else -> throw VncProtocolException("Unsupported server message type " + type)
                }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (closed: SocketException) {
            // Closing the socket is the normal way disconnect interrupts a blocking read.
        } catch (eof: EOFException) {
            // A clean peer hang-up completes both public flows.
        } finally {
            finish()
        }
    }

    private suspend fun readFramebufferUpdate() {
        val updateHeader = channel.readFully(3)
        val rectangleCount = readU16(updateHeader, 1)
        val formatForUpdate = pixelFormat
        var index = 0
        while (index < rectangleCount) {
            val header = RfbRectangleHeader.decode(channel.readFully(RfbRectangleHeader.BYTES))
            when (header.encoding) {
                RfbEncoding.RAW -> readRaw(header, formatForUpdate)
                RfbEncoding.COPY_RECT -> readCopyRect(header)
                RfbEncoding.LAST_RECT -> break
                RfbEncoding.DESKTOP_SIZE -> applyDesktopSize(header.width, header.height)
                RfbEncoding.EXTENDED_DESKTOP_SIZE -> readExtendedDesktopSize(header)
                else -> throw VncProtocolException(
                    "Server sent unrequested encoding " + RfbEncoding.name(header.encoding),
                )
            }
            index++
        }
        requestNextUpdate()
    }

    private suspend fun readRaw(header: RfbRectangleHeader, format: RfbPixelFormat) {
        framebuffer.checkRectangle(header.x, header.y, header.width, header.height)
        val byteCount = checkedProduct(header.width, header.height, format.bytesPerPixel)
        if (byteCount > MAX_RECTANGLE_BYTES) {
            throw VncProtocolException("Raw rectangle is too large: " + byteCount + " bytes")
        }
        val rgba = RfbPixelDecoder.decode(channel.readFully(byteCount), header.width, header.height, format)
        framebuffer.apply(header.x, header.y, header.width, header.height, rgba)
        frameChannel.send(VncFrame(header.x, header.y, header.width, header.height, rgba))
    }

    private suspend fun readCopyRect(header: RfbRectangleHeader) {
        val source = channel.readFully(4)
        val frame = framebuffer.copy(
            sourceX = readU16(source, 0),
            sourceY = readU16(source, 2),
            destinationX = header.x,
            destinationY = header.y,
            width = header.width,
            height = header.height,
        )
        frameChannel.send(frame)
    }

    private suspend fun readExtendedDesktopSize(header: RfbRectangleHeader) {
        val screenHeader = channel.readFully(4)
        val screenCount = screenHeader[0].toInt() and 0xFF
        channel.discardFully(screenCount * EXTENDED_SCREEN_BYTES)
        supportsExtendedDesktopSize = true

        val accepted = header.y == EXTENDED_RESIZE_SUCCESS
        if (accepted) applyDesktopSize(header.width, header.height)
        stateMutex.lock()
        try {
            pendingResize?.complete(currentSize(serverResized = accepted))
            pendingResize = null
        } finally {
            stateMutex.unlock()
        }
    }

    private fun applyDesktopSize(newWidth: Int, newHeight: Int) {
        ensureFramebufferSize(newWidth, newHeight)
        framebuffer.resize(newWidth, newHeight)
        width = newWidth
        height = newHeight
    }

    private suspend fun readColourMapEntries() {
        val header = channel.readFully(5)
        val colours = readU16(header, 3)
        channel.discardFully(checkedProduct(colours, COLOUR_MAP_ENTRY_BYTES))
    }

    private suspend fun readServerCutText() {
        val header = channel.readFully(7)
        val length = readU32(header, 3)
        if (length > MAX_SERVER_CUT_TEXT_BYTES) {
            throw VncProtocolException("Server clipboard is too large: " + length + " bytes")
        }
        val text = channel.readFully(length.toInt()).toString(Charsets.ISO_8859_1)
        clipboardChannel.send(text)
    }

    private suspend fun requestNextUpdate() {
        stateMutex.lock()
        var formatResult: CompletableDeferred<RfbPixelFormat>? = null
        try {
            requestOutstanding = false
            val nextFormat = pendingFormat
            formatResult = pendingFormatResult
            pendingFormat = null
            pendingFormatResult = null
            if (nextFormat != null) {
                writeMessages(
                    RfbEncoder.setPixelFormat(nextFormat),
                    RfbEncoder.framebufferUpdateRequest(false, 0, 0, width, height),
                )
                pixelFormat = nextFormat
                requestOutstanding = true
                formatResult?.complete(nextFormat)
            } else {
                writeMessages(RfbEncoder.framebufferUpdateRequest(true, 0, 0, width, height))
                requestOutstanding = true
            }
        } catch (failure: Throwable) {
            formatResult?.completeExceptionally(failure)
            throw failure
        } finally {
            stateMutex.unlock()
        }
    }

    private suspend fun sendText(text: String) {
        val messages = ArrayList<ByteArray>()
        var offset = 0
        var count = 0
        while (offset < text.length && count < MAX_TEXT_CODE_POINTS) {
            val codePoint = text.codePointAt(offset)
            val safeCodePoint = if (codePoint in 0xD800..0xDFFF) REPLACEMENT_CHARACTER else codePoint
            val keysym = X11Keysym.unicode(safeCodePoint)
            messages.add(RfbEncoder.keyEvent(keysym, down = true))
            messages.add(RfbEncoder.keyEvent(keysym, down = false))
            offset += Character.charCount(codePoint)
            count++
        }
        writeMessages(*messages.toTypedArray())
    }

    private suspend fun writeMessages(vararg messages: ByteArray) {
        ensureOpen()
        sendMutex.lock()
        try {
            for (message in messages) channel.write(message)
        } finally {
            sendMutex.unlock()
        }
    }

    private fun ensureOpen() {
        if (terminated.get()) throw VncSessionException(VncErrors.SESSION_NOT_FOUND, "VNC session is closed")
    }

    private fun finish() {
        if (!terminated.compareAndSet(false, true)) return
        channel.close()
        frameChannel.close()
        clipboardChannel.close()
        val closed = VncSessionException(VncErrors.SESSION_NOT_FOUND, "VNC session is closed")
        pendingFormatResult?.completeExceptionally(closed)
        pendingResize?.complete(currentSize(serverResized = false))
        onClosed(this)
    }

    private fun currentSize(serverResized: Boolean): VncSurfaceSize =
        VncSurfaceSize(width, height, serverResized)

    private suspend fun readU8(): Int = channel.readFully(1)[0].toInt() and 0xFF

    private companion object {
        const val FRAME_BUFFER_CAPACITY = 8
        const val CLIPBOARD_BUFFER_CAPACITY = 4
        const val MAX_RECTANGLE_BYTES = 64 * 1024 * 1024
        const val MAX_SERVER_CUT_TEXT_BYTES = 1 shl 20
        const val MAX_TEXT_CODE_POINTS = 4096
        const val REPLACEMENT_CHARACTER = 0xFFFD
        const val COLOUR_MAP_ENTRY_BYTES = 6
        const val EXTENDED_SCREEN_BYTES = 16
        const val EXTENDED_RESIZE_SUCCESS = 0
    }
}

/** Maintains enough local framebuffer state to turn CopyRect into an ordinary RGBA damage patch. */
private class RfbFramebuffer(initialWidth: Int, initialHeight: Int) {

    private var width = initialWidth
    private var height = initialHeight
    private var rgba = ByteArray(framebufferBytes(initialWidth, initialHeight))

    fun apply(x: Int, y: Int, patchWidth: Int, patchHeight: Int, pixels: ByteArray) {
        checkRectangle(x, y, patchWidth, patchHeight)
        require(pixels.size == checkedProduct(patchWidth, patchHeight, RGBA_BYTES)) {
            "RGBA patch length does not match its geometry"
        }
        val rowBytes = patchWidth * RGBA_BYTES
        for (row in 0 until patchHeight) {
            val source = row * rowBytes
            val destination = ((y + row) * width + x) * RGBA_BYTES
            pixels.copyInto(rgba, destination, source, source + rowBytes)
        }
    }

    fun copy(
        sourceX: Int,
        sourceY: Int,
        destinationX: Int,
        destinationY: Int,
        width: Int,
        height: Int,
    ): VncFrame {
        checkRectangle(sourceX, sourceY, width, height)
        checkRectangle(destinationX, destinationY, width, height)
        val patch = ByteArray(checkedProduct(width, height, RGBA_BYTES))
        val rowBytes = width * RGBA_BYTES
        for (row in 0 until height) {
            val source = ((sourceY + row) * this.width + sourceX) * RGBA_BYTES
            rgba.copyInto(patch, row * rowBytes, source, source + rowBytes)
        }
        apply(destinationX, destinationY, width, height, patch)
        return VncFrame(destinationX, destinationY, width, height, patch)
    }

    fun resize(newWidth: Int, newHeight: Int) {
        val replacement = ByteArray(framebufferBytes(newWidth, newHeight))
        val copiedWidth = minOf(width, newWidth)
        val copiedHeight = minOf(height, newHeight)
        val rowBytes = copiedWidth * RGBA_BYTES
        for (row in 0 until copiedHeight) {
            rgba.copyInto(replacement, row * newWidth * RGBA_BYTES, row * width * RGBA_BYTES, row * width * RGBA_BYTES + rowBytes)
        }
        width = newWidth
        height = newHeight
        rgba = replacement
    }

    fun checkRectangle(x: Int, y: Int, rectangleWidth: Int, rectangleHeight: Int) {
        if (rectangleWidth <= 0 || rectangleHeight <= 0 || x < 0 || y < 0 ||
            x.toLong() + rectangleWidth > width || y.toLong() + rectangleHeight > height
        ) {
            throw VncProtocolException(
                "Rectangle " + x + "," + y + " " + rectangleWidth + "x" + rectangleHeight +
                    " is outside " + width + "x" + height,
            )
        }
    }

    private companion object {
        const val RGBA_BYTES = 4
    }
}

/** Converts every legal true-colour RFB pixel format to the engine's RGBA8888 contract. */
internal object RfbPixelDecoder {

    fun decode(source: ByteArray, width: Int, height: Int, format: RfbPixelFormat): ByteArray {
        require(format.trueColour) { "Colour-map pixels cannot be decoded as true colour" }
        val pixelCount = checkedProduct(width, height)
        require(source.size == checkedProduct(pixelCount, format.bytesPerPixel)) {
            "Raw pixel payload length does not match its geometry"
        }
        val output = ByteArray(checkedProduct(pixelCount, RGBA_BYTES))
        var sourceOffset = 0
        var outputOffset = 0
        repeat(pixelCount) {
            var value = 0L
            if (format.bigEndian) {
                repeat(format.bytesPerPixel) {
                    value = (value shl 8) or (source[sourceOffset++].toLong() and 0xFF)
                }
            } else {
                repeat(format.bytesPerPixel) { byteIndex ->
                    value = value or ((source[sourceOffset++].toLong() and 0xFF) shl (byteIndex * 8))
                }
            }
            output[outputOffset++] = scale(value, format.redShift, format.redMax).toByte()
            output[outputOffset++] = scale(value, format.greenShift, format.greenMax).toByte()
            output[outputOffset++] = scale(value, format.blueShift, format.blueMax).toByte()
            output[outputOffset++] = 0xFF.toByte()
        }
        return output
    }

    private fun scale(value: Long, shift: Int, maximum: Int): Int {
        val component = (value ushr shift) and maximum.toLong()
        return ((component * 255L + maximum / 2L) / maximum).toInt()
    }

    private const val RGBA_BYTES = 4
}

private fun ensureFramebufferSize(width: Int, height: Int) {
    if (width <= 0 || height <= 0 || width > MAX_FRAMEBUFFER_DIMENSION || height > MAX_FRAMEBUFFER_DIMENSION ||
        width.toLong() * height > MAX_FRAMEBUFFER_PIXELS
    ) {
        throw VncProtocolException("Framebuffer size is unsupported: " + width + "x" + height)
    }
}

private fun framebufferBytes(width: Int, height: Int): Int {
    ensureFramebufferSize(width, height)
    return checkedProduct(width, height, 4)
}

private fun checkedProduct(vararg values: Int): Int {
    var result = 1L
    for (value in values) {
        if (value < 0) throw VncProtocolException("Negative protocol length")
        result *= value.toLong()
        if (result > Int.MAX_VALUE) throw VncProtocolException("Protocol length exceeds Int range")
    }
    return result.toInt()
}

private fun readU16(bytes: ByteArray, offset: Int): Int =
    ((bytes[offset].toInt() and 0xFF) shl 8) or (bytes[offset + 1].toInt() and 0xFF)

private fun readU32(bytes: ByteArray, offset: Int): Long =
    ((bytes[offset].toLong() and 0xFF) shl 24) or
        ((bytes[offset + 1].toLong() and 0xFF) shl 16) or
        ((bytes[offset + 2].toLong() and 0xFF) shl 8) or
        (bytes[offset + 3].toLong() and 0xFF)

private class VncProtocolException(message: String) : Exception(message)

class VncSessionException(val code: String, message: String) : IllegalStateException(message)

private const val MAX_FRAMEBUFFER_DIMENSION = 16_384
private const val MAX_FRAMEBUFFER_PIXELS = 16_777_216L
