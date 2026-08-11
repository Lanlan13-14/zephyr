package one.zephyr.mobile.feature.filesync

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri

/**
 * [UriPermissionStore] over `ContentResolver`'s persisted-permission list.
 *
 * A thin forward on purpose. The grant lifecycle lives in [SafShareGrants], which is testable on the
 * JVM; this is only the part that needs a real `ContentResolver`.
 */
class ContentResolverUriPermissions(
    private val resolver: ContentResolver,
) : UriPermissionStore {

    override fun persisted(): List<UriGrant> = resolver.persistedUriPermissions.map { permission ->
        UriGrant(
            uri = permission.uri.toString(),
            canRead = permission.isReadPermission,
            canWrite = permission.isWritePermission,
        )
    }

    override fun takePersistable(uri: String, allowWrite: Boolean): Boolean = runCatching {
        /* Read is always requested; write only when the share asks for it.
         *
         * Taking write unconditionally would be the wrong default twice over: it asks the user's
         * document provider for more authority than the feature needs, and it makes a read-only share
         * indistinguishable from a writable one at the permission layer, so a later bug could widen
         * the share without any grant change. */
        var flags = Intent.FLAG_GRANT_READ_URI_PERMISSION
        if (allowWrite) flags = flags or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        resolver.takePersistableUriPermission(Uri.parse(uri), flags)
        true
    }.isSuccess

    override fun releasePersistable(
        uri: String,
        releaseRead: Boolean,
        releaseWrite: Boolean,
    ): Boolean {
        if (!releaseRead && !releaseWrite) return true
        return runCatching {
            var flags = 0
            if (releaseRead) flags = flags or Intent.FLAG_GRANT_READ_URI_PERMISSION
            if (releaseWrite) flags = flags or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            resolver.releasePersistableUriPermission(
                Uri.parse(uri),
                flags,
            )
        }.isSuccess
    }
}
