package one.zephyr.mobile.feature.connections

import one.zephyr.mobile.model.JumpHost
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Source mutation: if `show()` stops replaying the inventory that arrived during
 * load(), a device full of SSH hosts renders "没有可用的 SSH 连接可作跳板".
 */
class JumpPickerMutationTest {

    private val vmSource: String by lazy {
        val relative = "src/main/kotlin/one/zephyr/mobile/feature/connections/ConnectionEditorViewModel.kt"
        val start = File(".").canonicalFile
        val file = generateSequence(start) { it.parentFile }
            .flatMap { root ->
                sequenceOf(
                    File(root, relative),
                    File(root, "feature-connections/$relative"),
                    File(root, "zephyr_one/mobile/android/feature-connections/$relative"),
                )
            }
            .first { it.exists() }
        file.readText()
    }

    @Test
    fun `editor viewmodel still replays inventory dropped during load`() {
        val vm = vmSource
        assertTrue(
            "latestInventory must be kept across InitialLoading",
            vm.contains("private var latestInventory: JumpInventory? = null"),
        )
        assertTrue(
            "show() must stamp the held snapshot onto the opened form",
            vm.contains("latestInventory?.let(::applyInventory)"),
        )
        assertTrue(
            "applyInventory must not depend on page already being Content to remember the snapshot",
            vm.contains("latestInventory = snapshot"),
        )
        val show = vm.substringAfter("private fun show(").substringBefore("private fun applyInventory")
        val applyIndex = show.indexOf("latestInventory?.let(::applyInventory)")
        val contentIndex = show.indexOf("page.value = PageState.Content(")
        assertTrue("show() must become Content before replaying", contentIndex in 0 until applyIndex)
    }

    @Test
    fun `a picker with hosts is not empty after the dropped-then-replayed merge`() {
        val hop = Fixtures.connection(id = "c-a", name = "jump-a", host = "10.0.0.1")
        val target = Fixtures.connection(id = "c-target", name = "target", host = "10.0.0.9")
        val alias = JumpHost(id = "j-a", ownerUserId = Fixtures.OWNER, name = "named-jump", connectionId = "c-a")
        val emptyForm = ConnectionEditorUiState(draft = ConnectionDraft.edit(target))
        /* The mutation: skip withJumpInventory and the addable list stays empty. */
        val skipped = JumpPicker.addable(
            connections = emptyForm.jumpConnections,
            jumps = emptyForm.jumpHosts,
            chain = emptyForm.draft.current.jumpHostIds,
            usableIds = emptyForm.inventory.usableJumpHostIds,
        )
        assertTrue(skipped.isEmpty())
        val replayed = emptyForm.withJumpInventory(
            JumpInventory(rows = listOf(target, hop), jumps = listOf(alias)),
            editingId = target.id,
        )
        val addable = JumpPicker.addable(
            connections = replayed.jumpConnections,
            jumps = replayed.jumpHosts,
            chain = replayed.draft.current.jumpHostIds,
            usableIds = replayed.inventory.usableJumpHostIds,
        )
        assertEquals(listOf("c-a", "j-a"), addable.map { it.first })
    }
}
