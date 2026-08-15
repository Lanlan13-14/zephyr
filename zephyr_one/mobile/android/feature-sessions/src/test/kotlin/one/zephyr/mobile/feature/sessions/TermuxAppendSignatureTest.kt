package one.zephyr.mobile.feature.sessions

import com.termux.terminal.TerminalEmulator
import com.termux.terminal.TerminalSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

/**
 * Pins the method the remote session actually calls.
 *
 * [TerminalSession.appendFromRemote] feeds `mEmulator.append(data, offset, count)`.
 * The two-argument Termux original cannot accept that window; 9a49a84 updated the
 * Kotlin wrapper and left this Java call compiling against nothing.
 */
class TermuxAppendSignatureTest {

    @Test
    fun emulatorDeclaresOffsetAndCountAppend() {
        val method = TerminalEmulator::class.java.getMethod(
            "append",
            ByteArray::class.java,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
        )
        assertEquals(Void.TYPE, method.returnType)
    }

    @Test
    fun remoteFeedKeepsTheWindowedSignature() {
        val method = TerminalSession::class.java.getMethod(
            "appendFromRemote",
            ByteArray::class.java,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
        )
        assertNotNull(method)
        assertEquals(3, method.parameterCount)
    }
}
