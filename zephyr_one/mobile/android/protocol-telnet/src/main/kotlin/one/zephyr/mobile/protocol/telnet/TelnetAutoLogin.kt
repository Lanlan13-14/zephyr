package one.zephyr.mobile.protocol.telnet

/**
 * Optional prompt-driven auto-login (DEVELOPMENT.md 14.2).
 *
 * Telnet has no authentication layer: credentials are typed into the terminal, so automating it
 * means watching output for a prompt and replying. Two safety rules shape this class:
 *
 * - **It gives up.** After [MAX_SCAN_CHARS] of output with no prompt, or once login completes, the
 *   matcher stops. Otherwise a "password:" appearing later in an interactive session - from `su`,
 *   from a log line, from a file the user happened to `cat` - would make the client type the
 *   account password into whatever is listening.
 * - **It never returns the secret.** [State] and [lastSentField] describe what happened; the
 *   password itself only ever passes through the send callback, so a UI that surfaces auto-login
 *   progress cannot accidentally render or log it.
 */
class TelnetAutoLogin(
    private val username: String?,
    private val password: String?,
    private val send: (String) -> Unit,
    private val loginPattern: Regex = DEFAULT_LOGIN_PATTERN,
    private val passwordPattern: Regex = DEFAULT_PASSWORD_PATTERN,
) {

    enum class State { AWAITING_LOGIN, AWAITING_PASSWORD, COMPLETE, DISABLED, GAVE_UP }

    enum class Field { USERNAME, PASSWORD }

    var state: State = if (username.isNullOrEmpty()) State.DISABLED else State.AWAITING_LOGIN
        private set

    /** Which field was last sent. Never the value. */
    var lastSentField: Field? = null
        private set

    private val window = StringBuilder()
    private var scanned = 0

    /**
     * Feeds decoded terminal output.
     *
     * Matching runs over a rolling window rather than the current chunk, because a prompt can be
     * split across packets, and the window is cleared after a match so the same prompt text cannot
     * trigger twice.
     */
    fun observe(text: String) {
        if (text.isEmpty()) return
        if (state == State.COMPLETE || state == State.DISABLED || state == State.GAVE_UP) return

        scanned += text.length
        window.append(text)
        if (window.length > WINDOW_CHARS) window.delete(0, window.length - WINDOW_CHARS)

        when (state) {
            State.AWAITING_LOGIN ->
                if (loginPattern.containsMatchIn(window)) {
                    send((username ?: "") + LINE_END)
                    lastSentField = Field.USERNAME
                    window.setLength(0)
                    // With no password configured the job is done at the username; a server that
                    // then asks for one gets nothing rather than an empty line.
                    state = if (password.isNullOrEmpty()) State.COMPLETE else State.AWAITING_PASSWORD
                    return
                }

            State.AWAITING_PASSWORD ->
                if (passwordPattern.containsMatchIn(window)) {
                    send((password ?: "") + LINE_END)
                    lastSentField = Field.PASSWORD
                    window.setLength(0)
                    state = State.COMPLETE
                    return
                }

            else -> return
        }

        if (scanned >= MAX_SCAN_CHARS) state = State.GAVE_UP
    }

    companion object {
        /** `CR LF` is what a Telnet NVT expects for end of line, not a bare `\n`. */
        const val LINE_END = "\r\n"

        /** Enough to hold a banner-separated prompt without rescanning the whole session. */
        const val WINDOW_CHARS = 512

        /** Roughly a screenful of banner. Past this, a prompt is not part of login. */
        const val MAX_SCAN_CHARS = 8192

        /** Full-width colon included: Chinese network gear commonly prompts that way. */
        val DEFAULT_LOGIN_PATTERN = Regex("(?:login|user\\s?name|username|用户名|登录名)\\s*[::]\\s*\$", RegexOption.IGNORE_CASE)

        val DEFAULT_PASSWORD_PATTERN = Regex("(?:password|passwd|密码|口令)\\s*[::]\\s*\$", RegexOption.IGNORE_CASE)
    }
}
