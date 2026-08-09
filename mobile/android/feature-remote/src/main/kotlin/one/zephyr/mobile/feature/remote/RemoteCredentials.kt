package one.zephyr.mobile.feature.remote

/**
 * Decrypted connection secrets for one attempt.
 *
 * A holder rather than a bare CharArray because the wipe is the point: SECURITY_MODEL.md keeps
 * plaintext secrets to the narrowest possible lifetime, and a caller that receives two independent
 * arrays has two chances to forget one. [wipe] clears every field it owns, so the call site needs to
 * remember one thing instead of three.
 *
 * Not a data class on purpose: the generated toString would print the password, and the generated
 * equals would compare array identity rather than content - both wrong for this type.
 */
class RemoteCredentials(
    val password: CharArray? = null,
) {

    /** Overwrites the plaintext in place. Safe to call more than once. */
    fun wipe() {
        password?.fill(NUL)
    }

    /** Redacted: SECURITY_MODEL.md forbids a secret reaching logs or diagnostics. */
    override fun toString(): String =
        "RemoteCredentials(password=" + (if (password == null) "absent" else "present") + ")"

    companion object {
        const val NUL = '\u0000'
    }
}
