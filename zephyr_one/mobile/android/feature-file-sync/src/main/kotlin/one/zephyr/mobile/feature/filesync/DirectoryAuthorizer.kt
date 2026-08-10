package one.zephyr.mobile.feature.filesync

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState

/**
 * The outcome of asking the user for a directory.
 *
 * Three states rather than a nullable URI, because they need different UI. Cancelling is not a
 * failure and must not raise an error; a refused grant is a failure the user can act on by picking a
 * different directory.
 */
sealed interface DirectoryAuthorizationResult {

    data class Authorized(val grant: SafShareGrant) : DirectoryAuthorizationResult

    /** The user dismissed the picker. Nothing was changed. */
    data object Cancelled : DirectoryAuthorizationResult

    /**
     * The system refused to persist the permission.
     *
     * Reported rather than retried: a grant that cannot survive a restart would produce a share that
     * works until the process dies, which is worse than an honest refusal.
     */
    data object Refused : DirectoryAuthorizationResult
}

/**
 * Opens the system directory picker and records the grant.
 *
 * `ACTION_OPEN_DOCUMENT_TREE`, wrapped by `OpenDocumentTree`, is the only way One is allowed to reach
 * device files: the manifest deliberately omits `MANAGE_EXTERNAL_STORAGE`, and PRODUCT_REQUIREMENTS.md
 * scopes file sharing to directories the user hands over explicitly.
 *
 * ## Why the grant is taken here rather than in the caller
 *
 * `takePersistableUriPermission` has to be called while the picker's result grant is still alive, so
 * it cannot be deferred to a later screen. Doing it inside the callback means the tree URI never
 * exists in app state without a persisted permission behind it -- the pair that
 * [SafShareGrants.pruneRevoked] exists to keep honest can never start out inconsistent.
 *
 * @param requestWrite what the connection's configuration asks for. The stored grant is narrowed to
 *   what the system actually granted, so a read-only directory yields a read-only share.
 */
@Composable
fun rememberDirectoryAuthorizer(
    grants: SafShareGrants,
    requestWrite: Boolean,
    profileIdFactory: () -> String,
    shareNameFactory: () -> String,
    onResult: (DirectoryAuthorizationResult) -> Unit,
): () -> Unit {
    /* rememberUpdatedState, not a captured value: the launcher is remembered across recompositions
     * and would otherwise call the callback the composition happened to have when it was created.
     * That is the classic stale-lambda bug, and here it would report a grant to a screen that has
     * already navigated away. */
    val currentOnResult by rememberUpdatedState(onResult)
    val currentProfileId by rememberUpdatedState(profileIdFactory)
    val currentShareName by rememberUpdatedState(shareNameFactory)
    val currentRequestWrite by rememberUpdatedState(requestWrite)

    val launcher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocumentTree(),
    ) { uri ->
        if (uri == null) {
            /* Cancellation, not failure. The user backed out of the picker and nothing changed. */
            currentOnResult(DirectoryAuthorizationResult.Cancelled)
            return@rememberLauncherForActivityResult
        }
        val grant = grants.authorize(
            profileId = currentProfileId(),
            shareName = currentShareName(),
            treeUri = uri.toString(),
            requestWrite = currentRequestWrite,
        )
        currentOnResult(
            if (grant == null) {
                DirectoryAuthorizationResult.Refused
            } else {
                DirectoryAuthorizationResult.Authorized(grant)
            },
        )
    }

    return remember(launcher) {
        {
            /* Null means "no starting location", which lets the provider open wherever the user last
             * browsed. Suggesting a path would be a guess about the user's storage layout. */
            launcher.launch(null)
        }
    }
}
