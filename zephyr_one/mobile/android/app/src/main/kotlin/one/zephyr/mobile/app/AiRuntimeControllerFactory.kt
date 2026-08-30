package one.zephyr.mobile.app

import kotlinx.coroutines.CoroutineScope
import kotlinx.serialization.json.JsonObject
import one.zephyr.mobile.app.di.AccountContainer
import one.zephyr.mobile.feature.ai.AiRuntimeController
import one.zephyr.mobile.feature.ai.AiWorkspaceChrome

/**
 * Selects the AI authority for one account.
 *
 * Bound accounts run through the main end: provider credentials stay on the server and only the
 * authenticated `/api/ai/runtime/…` control plane reaches the device. Local-only accounts run the
 * packaged Go runtime against the device-local provider catalog. Crossing those two paths makes a
 * bound device resolve provider DNS itself and duplicates server-held secrets, so the decision is
 * centralized here rather than left to individual screens.
 */
internal object AiRuntimeControllerFactory {

    fun create(
        account: AccountContainer,
        scope: CoroutineScope,
        chrome: () -> AiWorkspaceChrome,
        context: () -> JsonObject,
        persistChrome: suspend (AiWorkspaceChrome) -> Unit,
        localPlatformHost: () -> AndroidAiPlatformHost,
    ): AiRuntimeController = if (account.isLocalMode) {
        LocalAndroidAiRuntimeController(
            account = account,
            scope = scope,
            context = context,
            persistChrome = persistChrome,
            platformHost = localPlatformHost(),
        )
    } else {
        AndroidAiRuntimeController(
            account = account,
            scope = scope,
            chrome = chrome,
            context = context,
            persistChrome = persistChrome,
        )
    }
}
