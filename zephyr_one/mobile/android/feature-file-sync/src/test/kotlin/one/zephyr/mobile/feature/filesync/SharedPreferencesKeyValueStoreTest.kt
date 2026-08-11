package one.zephyr.mobile.feature.filesync

import android.content.SharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedPreferencesKeyValueStoreTest {

    @Test
    fun editUsesSynchronousCommitAndPropagatesFalse() {
        val preferences = RecordingSharedPreferences(commitResult = false)
        val store = SharedPreferencesKeyValueStore(preferences)

        assertFalse(store.edit { putString("pending", "content://tree") })
        assertEquals(1, preferences.editor.commitCalls)
        assertEquals(0, preferences.editor.applyCalls)
    }

    @Test
    fun aSuccessfulCommitIsReported() {
        val preferences = RecordingSharedPreferences(commitResult = true)

        assertTrue(SharedPreferencesKeyValueStore(preferences).edit { remove("pending") })
        assertEquals(1, preferences.editor.commitCalls)
    }
}

private class RecordingSharedPreferences(
    commitResult: Boolean,
) : SharedPreferences {
    val editor = RecordingEditor(commitResult)
    private val values = LinkedHashMap<String, Any>()

    override fun getAll(): Map<String, *> = values
    override fun getString(key: String?, defaultValue: String?): String? = values[key] as? String ?: defaultValue
    @Suppress("UNCHECKED_CAST")
    override fun getStringSet(key: String?, defaultValues: Set<String>?): Set<String>? =
        values[key] as? Set<String> ?: defaultValues
    override fun getInt(key: String?, defaultValue: Int): Int = values[key] as? Int ?: defaultValue
    override fun getLong(key: String?, defaultValue: Long): Long = values[key] as? Long ?: defaultValue
    override fun getFloat(key: String?, defaultValue: Float): Float = values[key] as? Float ?: defaultValue
    override fun getBoolean(key: String?, defaultValue: Boolean): Boolean =
        values[key] as? Boolean ?: defaultValue
    override fun contains(key: String?): Boolean = values.containsKey(key)
    override fun edit(): SharedPreferences.Editor = editor
    override fun registerOnSharedPreferenceChangeListener(
        listener: SharedPreferences.OnSharedPreferenceChangeListener?,
    ) = Unit
    override fun unregisterOnSharedPreferenceChangeListener(
        listener: SharedPreferences.OnSharedPreferenceChangeListener?,
    ) = Unit
}

private class RecordingEditor(
    private val commitResult: Boolean,
) : SharedPreferences.Editor {
    var commitCalls = 0
    var applyCalls = 0

    override fun putString(key: String?, value: String?): SharedPreferences.Editor = this
    override fun putStringSet(key: String?, values: Set<String>?): SharedPreferences.Editor = this
    override fun putInt(key: String?, value: Int): SharedPreferences.Editor = this
    override fun putLong(key: String?, value: Long): SharedPreferences.Editor = this
    override fun putFloat(key: String?, value: Float): SharedPreferences.Editor = this
    override fun putBoolean(key: String?, value: Boolean): SharedPreferences.Editor = this
    override fun remove(key: String?): SharedPreferences.Editor = this
    override fun clear(): SharedPreferences.Editor = this
    override fun commit(): Boolean {
        commitCalls += 1
        return commitResult
    }
    override fun apply() {
        applyCalls += 1
    }
}
