package one.zephyr.mobile.feature.filesync

import android.content.SharedPreferences

/**
 * [KeyValueStore] over `SharedPreferences`.
 *
 * A thin forward on purpose: every rule about what to store and when to drop it lives above this
 * class, where a JVM test can reach it. This is only the part that needs the platform.
 */
class SharedPreferencesKeyValueStore(
    private val preferences: SharedPreferences,
) : KeyValueStore {

    override fun string(key: String): String? = preferences.getString(key, null)

    override fun boolean(key: String, defaultValue: Boolean): Boolean =
        preferences.getBoolean(key, defaultValue)

    override fun stringSet(key: String): Set<String> =
        preferences.getStringSet(key, emptySet()).orEmpty()

    override fun keys(): Set<String> = preferences.all.keys

    override fun edit(block: KeyValueEditor.() -> Unit): Boolean {
        val editor = preferences.edit()
        object : KeyValueEditor {
            override fun putString(key: String, value: String) {
                editor.putString(key, value)
            }

            override fun putBoolean(key: String, value: Boolean) {
                editor.putBoolean(key, value)
            }

            override fun putStringSet(key: String, value: Set<String>) {
                editor.putStringSet(key, value)
            }

            override fun remove(key: String) {
                editor.remove(key)
            }
        }.block()
        /* The caller uses the return as the commit point for a system permission. apply() would let
         * the process die after ContentResolver persisted access but before the row reached disk,
         * leaving an ambient grant with no owner record. These batches are tiny and user-driven. */
        return editor.commit()
    }
}
