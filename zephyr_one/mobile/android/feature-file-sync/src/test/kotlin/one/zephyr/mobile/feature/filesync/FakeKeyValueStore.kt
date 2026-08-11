package one.zephyr.mobile.feature.filesync

/**
 * In-memory [KeyValueStore].
 *
 * Models the two properties of the real thing that matter to the callers: reads see writes
 * immediately, and a batch is applied as one unit. Values are held as `Any` because the store is
 * heterogeneous by design -- a grant row is two strings plus a boolean plus a set -- and a typed map
 * per kind would let a test pass while the production code read the wrong one.
 */
class FakeKeyValueStore(
    private val values: MutableMap<String, Any> = LinkedHashMap(),
) : KeyValueStore {

    /** Makes the next durable batch fail without changing visible or restart state. */
    var failNextEdit: Boolean = false

    /** One-based batch number to fail; useful when an operation has a prepare and commit phase. */
    var failBatch: Int? = null

    /** Number of batches applied. Proves a multi-key row is written once, not key by key. */
    var batches = 0
        private set

    override fun string(key: String): String? = values[key] as? String

    override fun boolean(key: String, defaultValue: Boolean): Boolean =
        values[key] as? Boolean ?: defaultValue

    @Suppress("UNCHECKED_CAST")
    override fun stringSet(key: String): Set<String> = values[key] as? Set<String> ?: emptySet()

    override fun keys(): Set<String> = values.keys.toSet()

    override fun edit(block: KeyValueEditor.() -> Unit): Boolean {
        batches += 1
        /* Staged and then merged, so a batch that throws part-way leaves nothing behind. The real
         * editor behaves the same way: nothing is visible until apply(). */
        val staged = LinkedHashMap<String, Any>()
        val removed = mutableSetOf<String>()
        object : KeyValueEditor {
            override fun putString(key: String, value: String) {
                staged[key] = value
                removed -= key
            }

            override fun putBoolean(key: String, value: Boolean) {
                staged[key] = value
                removed -= key
            }

            override fun putStringSet(key: String, value: Set<String>) {
                staged[key] = value.toSet()
                removed -= key
            }

            override fun remove(key: String) {
                staged -= key
                removed += key
            }
        }.block()
        if (failNextEdit || failBatch == batches) {
            failNextEdit = false
            failBatch = null
            return false
        }
        for (key in removed) values.remove(key)
        values.putAll(staged)
        return true
    }

    /** Simulates a relaunch: the same bytes, a new object graph on top of them. */
    fun surviveRestart(): FakeKeyValueStore = FakeKeyValueStore(LinkedHashMap(values))

    /** Simulates external truncation, e.g. a partially cleared preferences file. */
    fun drop(key: String) {
        values.remove(key)
    }
}
