package one.zephyr.mobile.feature.notes

/**
 * Library SFTP tabs. Same shape as the terminal session rail: first pick opens one host,
 * plus adds another, close drops that connection, last close returns to the picker.
 */
data class SftpHostTabs(
    val openIds: List<String> = emptyList(),
    val focusedId: String? = null,
) {
    val isEmpty: Boolean get() = openIds.isEmpty()

    fun open(id: String): SftpHostTabs {
        if (id.isBlank()) return this
        val next = if (id in openIds) openIds else openIds + id
        return copy(openIds = next, focusedId = id)
    }

    fun focus(id: String): SftpHostTabs =
        if (id in openIds) copy(focusedId = id) else this

    fun close(id: String): SftpHostTabs {
        val next = openIds.filterNot { it == id }
        val focused = when {
            focusedId != id -> focusedId
            next.isEmpty() -> null
            else -> next.last()
        }
        return copy(openIds = next, focusedId = focused)
    }
}
