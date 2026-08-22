package one.zephyr.mobile.feature.connections

import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.JumpHost
import one.zephyr.mobile.model.Protocol
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Hop picker contents.
 *
 * The editor used to drop the first inventory emission while the form was still
 * InitialLoading, then never ask Room again, so a user with many SSH hosts saw
 * "没有可用的 SSH 连接可作跳板". These cases pin the list the sheet actually
 * renders, including the merge that must happen after that dropped emission is
 * replayed onto the opened form.
 */
class JumpPickerTest {

    private val target = Fixtures.connection(id = "c-target", name = "target", host = "10.0.0.9")
    private val hopA = Fixtures.connection(id = "c-a", name = "jump-a", host = "10.0.0.1")
    private val hopB = Fixtures.connection(id = "c-b", name = "jump-b", host = "10.0.0.2")
    private val rdp = Fixtures.connection(id = "c-rdp", name = "desk", host = "10.0.0.3", protocol = Protocol.RDP)
    private val deleted = Fixtures.connection(id = "c-dead", name = "gone", host = "10.0.0.4", deletedAt = 1L)
    private val noUse = Fixtures.connection(
        id = "c-view",
        name = "view-only",
        host = "10.0.0.5",
        capabilities = CapabilitySet.none,
    )
    private val alias = JumpHost(
        id = "j-a",
        ownerUserId = Fixtures.OWNER,
        name = "named-jump",
        connectionId = "c-a",
    )

    @Test
    fun `lists every live SSH host except the one being edited`() {
        val listed = JumpPicker.connections(
            rows = listOf(target, hopA, hopB, rdp, deleted, noUse),
            editingId = target.id,
        )
        assertEquals(listOf("c-a", "c-b"), listed.map { it.id })
    }

    @Test
    fun `a create form with a null id still lists every live SSH host`() {
        val listed = JumpPicker.connections(
            rows = listOf(hopA, hopB, rdp),
            editingId = null,
        )
        assertEquals(listOf("c-a", "c-b"), listed.map { it.id })
    }

    @Test
    fun `addable excludes hops already in the chain and jump aliases of those hops`() {
        val connections = listOf(hopA, hopB)
        val usable = JumpPicker.usableIds(connections, listOf(alias))
        val addable = JumpPicker.addable(
            connections = connections,
            jumps = listOf(alias),
            chain = listOf(hopA.id),
            usableIds = usable,
        )
        assertEquals(listOf("c-b"), addable.map { it.first })
        assertFalse(addable.any { it.first == "j-a" })
    }

    @Test
    fun `addable includes a jump-host alias when its connection is not already in the chain`() {
        val connections = listOf(hopA, hopB)
        val usable = JumpPicker.usableIds(connections, listOf(alias))
        val addable = JumpPicker.addable(
            connections = connections,
            jumps = listOf(alias),
            chain = emptyList(),
            usableIds = usable,
        )
        assertEquals(listOf("c-a", "c-b", "j-a"), addable.map { it.first })
        assertEquals("named-jump", addable.last().second)
    }

    @Test
    fun `replaying inventory onto a freshly opened form fills the picker`() {
        /* This is the race: Room emitted while load() was still in find(), mutate
         * no-op'd, and the form opened with the default empty jumpConnections. */
        val opened = ConnectionEditorUiState(draft = ConnectionDraft.edit(target))
        assertTrue(opened.jumpConnections.isEmpty())
        assertTrue(opened.inventory.usableJumpHostIds.isEmpty())

        val filled = opened.withJumpInventory(
            JumpInventory(rows = listOf(target, hopA, hopB, rdp), jumps = listOf(alias)),
            editingId = target.id,
        )
        assertEquals(listOf("c-a", "c-b"), filled.jumpConnections.map { it.id })
        assertTrue(filled.inventory.usableJumpHostIds.containsAll(listOf("c-a", "c-b", "j-a")))
        assertFalse(filled.inventory.usableJumpHostIds.contains("c-target"))

        val addable = JumpPicker.addable(
            connections = filled.jumpConnections,
            jumps = filled.jumpHosts,
            chain = filled.draft.current.jumpHostIds,
            usableIds = filled.inventory.usableJumpHostIds,
        )
        assertEquals(listOf("c-a", "c-b", "j-a"), addable.map { it.first })
        assertTrue(addable.any { it.second.contains("10.0.0.1") })
    }

    @Test
    fun `labels prefer the connection name then host colon port`() {
        val unnamed = hopA.copy(name = "")
        val labels = JumpPicker.labels(listOf(unnamed, hopB), listOf(alias))
        assertEquals("10.0.0.1 · 10.0.0.1:22", labels.getValue("c-a"))
        assertEquals("jump-b · 10.0.0.2:22", labels.getValue("c-b"))
        assertEquals("named-jump", labels.getValue("j-a"))
    }
}
