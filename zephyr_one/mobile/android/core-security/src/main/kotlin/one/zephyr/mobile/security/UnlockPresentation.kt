package one.zephyr.mobile.security

/** Maps a platform-auth result onto lock-gate / settings copy. */
object UnlockPresentation {
    fun failureMessage(result: AuthResult, unavailable: String): String? = when (result) {
        AuthResult.Success, AuthResult.Cancelled -> null
        is AuthResult.Failed -> if (result.availability.canAuthenticate) result.message else unavailable
    }
}
