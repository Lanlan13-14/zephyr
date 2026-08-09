package one.zephyr.mobile.protocol.telnet

import java.io.ByteArrayOutputStream

/**
 * Stateful Telnet option processor.
 *
 * A faithful port of `telnet-transport.js`'s `TelnetIacEngine`. Three properties matter and each
 * one is a bug that a naive implementation ships:
 *
 * 1. **Cross-chunk buffering.** A TCP read boundary can land inside `IAC SB ... IAC SE`. Anything
 *    incomplete is held in [pending] and reconsidered with the next chunk, so an option sequence
 *    split across packets is not half-executed and half-printed to the terminal.
 * 2. **A loop guard.** Re-confirming an option that is already enabled is how two RFC 855
 *    implementations end up ping-ponging `DO`/`WILL` forever. A repeated `DO` for an already
 *    enabled option is therefore ignored, not answered.
 * 3. **`CR NUL` collapsing.** RFC 854 encodes a bare carriage return as `CR NUL`; passing the NUL
 *    through puts a stray null byte into the emulator. It is only collapsed while the peer has not
 *    enabled BINARY, because in binary mode those bytes are data.
 *
 * Not thread-safe: one engine belongs to one session, driven from that session's single reader.
 */
class TelnetIacEngine(
    private val writer: ((ByteArray) -> Unit)? = null,
    termType: String = Telnet.DEFAULT_TERM,
    private val respond: Boolean = true,
    private val wantUs: Set<Int> = setOf(Telnet.OPT_NAWS, Telnet.OPT_TTYPE),
    private val wantHim: Set<Int> = setOf(Telnet.OPT_SGA, Telnet.OPT_ECHO),
) {

    /** Reported in answer to `TTYPE SEND`, truncated so a hostile config cannot bloat the reply. */
    val termType: String = termType.ifEmpty { Telnet.DEFAULT_TERM }.take(Telnet.MAX_TERM_LENGTH)

    /** Options enabled on this side. */
    private val us = HashMap<Int, Boolean>()

    /** Options enabled on the peer's side. */
    private val him = HashMap<Int, Boolean>()

    private var pending = ByteArray(0)

    var destroyed = false
        private set

    val bufferedBytes: Int get() = pending.size

    init {
        // Seeded true because the dialer already sent WILL NAWS and WILL TTYPE; a later DO for
        // either is a confirmation, and answering it again would start a negotiation loop.
        for (option in wantUs) us[option] = true
        // Seeded false: we asked, the peer has not agreed yet.
        for (option in wantHim) him[option] = false
    }

    /** True once the peer enabled an option, used by the session to report the effective mode. */
    fun peerEnabled(option: Int): Boolean = him[option] == true

    fun localEnabled(option: Int): Boolean = us[option] == true

    /** Drops the hangover and stops processing. Does not touch the socket. */
    fun destroy() {
        destroyed = true
        pending = ByteArray(0)
    }

    /**
     * Consumes one chunk and returns the bytes the terminal emulator should see.
     *
     * Option replies are written through [writer] as a side effect, in the order the peer's requests
     * arrived, because a Telnet server may make its next decision based on the previous answer.
     */
    fun feed(data: ByteArray): ByteArray {
        if (destroyed || data.isEmpty() && pending.isEmpty()) return ByteArray(0)
        val buffer = if (pending.isEmpty()) data else pending + data
        pending = ByteArray(0)

        val out = ByteArrayOutputStream(buffer.size)
        var index = 0
        while (index < buffer.size) {
            val current = buffer[index].toInt() and 0xFF

            if (current != Telnet.IAC) {
                if (current == Telnet.CR && him[Telnet.OPT_BINARY] != true) {
                    if (index + 1 < buffer.size) {
                        if ((buffer[index + 1].toInt() and 0xFF) == Telnet.NUL) {
                            out.write(Telnet.CR)
                            index += 2
                            continue
                        }
                    } else {
                        // A lone CR at the end of a chunk: hold it, because the next chunk may open
                        // with the NUL that completes the sequence.
                        pending = buffer.copyOfRange(index, buffer.size)
                        break
                    }
                }
                out.write(current)
                index += 1
                continue
            }

            if (index + 1 >= buffer.size) {
                pending = buffer.copyOfRange(index, buffer.size)
                break
            }

            val command = buffer[index + 1].toInt() and 0xFF
            if (command == Telnet.IAC) {
                // Escaped 0xFF: one literal data byte.
                out.write(Telnet.IAC)
                index += 2
                continue
            }
            if (command == Telnet.NOP || command == Telnet.GA) {
                index += 2
                continue
            }
            if (command == Telnet.DO || command == Telnet.DONT || command == Telnet.WILL || command == Telnet.WONT) {
                if (index + 2 >= buffer.size) {
                    pending = buffer.copyOfRange(index, buffer.size)
                    break
                }
                val option = buffer[index + 2].toInt() and 0xFF
                when (command) {
                    Telnet.DO -> onDo(option)
                    Telnet.DONT -> onDont(option)
                    Telnet.WILL -> onWill(option)
                    else -> onWont(option)
                }
                index += 3
                continue
            }
            if (command == Telnet.SB) {
                val end = findSubnegotiationEnd(buffer, index)
                if (end < 0) {
                    pending = buffer.copyOfRange(index, buffer.size)
                    break
                }
                val option = if (index + 2 < end) buffer[index + 2].toInt() and 0xFF else 0
                val bodyStart = index + 3
                val body = if (bodyStart < end) buffer.copyOfRange(bodyStart, end) else ByteArray(0)
                onSubnegotiation(option, body)
                index = end + 2
                continue
            }

            // Any other two-byte command (IP, AO, AYT, EC, EL, BRK): stripped. Acting on them is
            // the server's job, and forwarding them would corrupt the emulator's byte stream.
            index += 2
        }
        return out.toByteArray()
    }

    /**
     * Index of the `IAC` that begins the terminating `IAC SE`, or -1 when it has not arrived.
     *
     * `IAC IAC` inside the body is skipped as an escaped literal, so a payload byte of 0xFF cannot
     * be mistaken for the start of the terminator.
     */
    private fun findSubnegotiationEnd(buffer: ByteArray, start: Int): Int {
        var end = start + 2
        while (end < buffer.size - 1) {
            if ((buffer[end].toInt() and 0xFF) == Telnet.IAC) {
                val next = buffer[end + 1].toInt() and 0xFF
                if (next == Telnet.SE) return end
                if (next == Telnet.IAC) {
                    end += 2
                    continue
                }
            }
            end += 1
        }
        return -1
    }

    // ---- option state machine ------------------------------------------------------------------

    private fun onDo(option: Int) {
        if (!respond) return
        val enabled = us[option] == true
        if (wantUs.contains(option)) {
            // Already enabled: deliberately silent. This is the loop guard.
            if (!enabled) {
                us[option] = true
                reply(Telnet.WILL, option)
            }
        } else {
            if (enabled) us[option] = false
            reply(Telnet.WONT, option)
        }
    }

    private fun onDont(option: Int) {
        if (!respond) return
        // Only answer a real state change; a redundant DONT is dropped.
        if (us[option] == true) {
            us[option] = false
            reply(Telnet.WONT, option)
        }
    }

    private fun onWill(option: Int) {
        if (!respond) return
        val enabled = him[option] == true
        // BINARY is accepted whenever offered: it is the only way to carry 8-bit data unmangled,
        // and it also switches off CR NUL collapsing above.
        if (wantHim.contains(option) || option == Telnet.OPT_BINARY) {
            if (!enabled) {
                him[option] = true
                reply(Telnet.DO, option)
            }
        } else {
            if (enabled) him[option] = false
            reply(Telnet.DONT, option)
        }
    }

    private fun onWont(option: Int) {
        if (!respond) return
        if (him[option] == true) {
            him[option] = false
            reply(Telnet.DONT, option)
        }
    }

    /**
     * Only TTYPE is answered. NAWS is client-to-server only, so an inbound NAWS subnegotiation is
     * ignored rather than echoed.
     */
    private fun onSubnegotiation(option: Int, body: ByteArray) {
        if (!respond) return
        if (option != Telnet.OPT_TTYPE) return
        if (body.isEmpty() || (body[0].toInt() and 0xFF) != Telnet.TTYPE_SEND) return
        val term = termType.toByteArray(Charsets.US_ASCII)
        val packet = ByteArray(6 + term.size)
        packet[0] = Telnet.IAC.toByte()
        packet[1] = Telnet.SB.toByte()
        packet[2] = Telnet.OPT_TTYPE.toByte()
        packet[3] = Telnet.TTYPE_IS.toByte()
        term.copyInto(packet, 4)
        packet[4 + term.size] = Telnet.IAC.toByte()
        packet[5 + term.size] = Telnet.SE.toByte()
        emit(packet)
    }

    private fun reply(command: Int, option: Int) =
        emit(byteArrayOf(Telnet.IAC.toByte(), command.toByte(), (option and 0xFF).toByte()))

    /** A failed write is not fatal here; the socket's own error path owns teardown. */
    private fun emit(bytes: ByteArray) {
        if (!respond || bytes.isEmpty()) return
        val sink = writer ?: return
        try {
            sink(bytes)
        } catch (ignored: Throwable) {
            // Intentionally swallowed: the session observes the socket failure directly.
        }
    }
}
