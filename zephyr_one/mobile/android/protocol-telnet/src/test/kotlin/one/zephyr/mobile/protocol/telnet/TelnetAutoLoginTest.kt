package one.zephyr.mobile.protocol.telnet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Prompt-driven auto-login.
 *
 * DEVELOPMENT.md 14.2 lists it as optional, which makes the failure modes the interesting part: a
 * credential must never be sent to a prompt that was not recognised, and the state machine must not
 * answer the same prompt twice when the server echoes it back.
 */
class TelnetAutoLoginTest {

    private class Sink {
        val lines = mutableListOf<String>()
        fun send(): (String) -> Unit = { lines.add(it) }
    }

    @Test
    fun sendsUsernameThenPasswordOnTheirPrompts() {
        val sink = Sink()
        val login = TelnetAutoLogin("alice", "s3cret", sink.send())

        login.observe("Welcome\r\nlogin: ")
        assertEquals(listOf("alice" + TelnetAutoLogin.LINE_END), sink.lines)
        assertEquals(TelnetAutoLogin.State.AWAITING_PASSWORD, login.state)

        login.observe("Password: ")
        assertEquals("s3cret" + TelnetAutoLogin.LINE_END, sink.lines[1])
        assertEquals(TelnetAutoLogin.State.COMPLETE, login.state)
        assertEquals(TelnetAutoLogin.Field.PASSWORD, login.lastSentField)
    }

    /** A prompt split across packets is the normal case, not an edge case. */
    @Test
    fun matchesAPromptSplitAcrossChunks() {
        val sink = Sink()
        val login = TelnetAutoLogin("bob", null, sink.send())
        login.observe("lo")
        login.observe("gin")
        assertTrue(sink.lines.isEmpty())
        login.observe(": ")
        assertEquals(listOf("bob" + TelnetAutoLogin.LINE_END), sink.lines)
    }

    /** With no password configured, a later password prompt gets nothing rather than an empty line. */
    @Test
    fun stopsAtTheUsernameWhenNoPasswordIsConfigured() {
        val sink = Sink()
        val login = TelnetAutoLogin("bob", null, sink.send())
        login.observe("login: ")
        assertEquals(TelnetAutoLogin.State.COMPLETE, login.state)
        login.observe("Password: ")
        assertEquals("nothing may be sent for an unconfigured password", 1, sink.lines.size)
    }

    @Test
    fun isDisabledWithoutAUsername() {
        val sink = Sink()
        val login = TelnetAutoLogin(null, "s3cret", sink.send())
        assertEquals(TelnetAutoLogin.State.DISABLED, login.state)
        login.observe("login: ")
        assertTrue(sink.lines.isEmpty())
    }

    /** The window is cleared after a match, so an echoed prompt cannot re-trigger it. */
    @Test
    fun doesNotAnswerTheSamePromptTwice() {
        val sink = Sink()
        val login = TelnetAutoLogin("alice", "s3cret", sink.send())
        login.observe("login: ")
        login.observe("alice\r\n")
        assertEquals(1, sink.lines.size)
    }

    @Test
    fun matchesChinesePrompts() {
        val sink = Sink()
        val login = TelnetAutoLogin("alice", "s3cret", sink.send())
        login.observe("用户名：")
        assertEquals(listOf("alice" + TelnetAutoLogin.LINE_END), sink.lines)
        login.observe("密码：")
        assertEquals(2, sink.lines.size)
    }

    /**
     * Gives up after a bounded amount of output.
     *
     * Without the cap, a device that never shows a recognised prompt would keep a password in memory
     * and armed for the whole session, ready to be sent to whatever finally looked like a prompt.
     */
    @Test
    fun givesUpAfterTooMuchUnrecognisedOutput() {
        val sink = Sink()
        val login = TelnetAutoLogin("alice", "s3cret", sink.send())
        login.observe("x".repeat(TelnetAutoLogin.MAX_SCAN_CHARS + 1))
        assertEquals(TelnetAutoLogin.State.GAVE_UP, login.state)
        login.observe("login: ")
        assertTrue("a credential must not be sent after giving up", sink.lines.isEmpty())
    }

    /** A bare word without the separator is not a prompt. */
    @Test
    fun doesNotMatchTheWordLoginInOrdinaryOutput() {
        val sink = Sink()
        val login = TelnetAutoLogin("alice", "s3cret", sink.send())
        login.observe("last login was yesterday\r\n")
        assertTrue(sink.lines.isEmpty())
    }
}
