package one.zephyr.mobile.feature.filesync

/**
 * The narrow persistence seam the file-sync bookkeeping is written against.
 *
 * Exists for the same reason as [SafDocumentTree] and [UriPermissionStore]: `SharedPreferences` is an
 * Android interface, so anything written directly against it can only be exercised on a device or
 * under Robolectric. This module deliberately has neither -- there is no Gradle wrapper here and the
 * Android tree compiles only in CI -- so persistence behind a seam is the difference between rules
 * that are tested and rules that are merely written down.
 *
 * The rules being protected are not incidental. A grant row that fails to persist means the app holds
 * a SAF permission with no row describing it: access the user granted that the UI can no longer show
 * or revoke. A stale connection choice means a session reports "no directory is authorised" while the
 * editor still shows one as selected. Both are silent, and both are checked by JVM tests because of
 * this interface.
 */
interface KeyValueStore {

    fun string(key: String): String?

    fun boolean(key: String, defaultValue: Boolean): Boolean

    fun stringSet(key: String): Set<String>

    /** Every key currently stored. Used to find rows whose owner has gone. */
    fun keys(): Set<String>

    /**
     * Applies a batch of writes.
     *
     * A batch rather than individual setters: a grant row spans three keys plus the id index, and a
     * process death between two of them would leave a row that names a directory with no share name
     * or, worse, an id in the index with no URI behind it.
     */
    fun edit(block: KeyValueEditor.() -> Unit)
}

/** Accumulates one batch of writes. */
interface KeyValueEditor {

    fun putString(key: String, value: String)

    fun putBoolean(key: String, value: Boolean)

    fun putStringSet(key: String, value: Set<String>)

    fun remove(key: String)
}
