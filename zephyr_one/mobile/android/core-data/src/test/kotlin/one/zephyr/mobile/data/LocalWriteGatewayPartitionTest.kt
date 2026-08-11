package one.zephyr.mobile.data

import one.zephyr.mobile.contracts.SyncAction
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalWriteGatewayPartitionTest {

    @Test
    fun `replace and clear split into stable disjoint operations`() {
        val partitions = partitionLocalEdit(
            primaryOpId = "op-1",
            action = SyncAction.UPSERT,
            fieldMask = listOf("name"),
            replacementFields = listOf("password"),
            clearedFields = listOf("privateKey"),
        )

        assertEquals(listOf("op-1", "op-1-clear"), partitions.map { it.opId })
        assertEquals(listOf("name"), partitions[0].fieldMask)
        assertEquals(listOf("password"), partitions[0].secretFields)
        assertTrue(partitions[0].clearSecretFields.isEmpty())
        assertTrue(partitions[1].fieldMask.isEmpty())
        assertTrue(partitions[1].secretFields.isEmpty())
        assertEquals(listOf("privateKey"), partitions[1].clearSecretFields)
    }

    @Test
    fun `single clear operation retains non-secret mask`() {
        val partition = partitionLocalEdit(
            primaryOpId = "op-1",
            action = SyncAction.UPSERT,
            fieldMask = listOf("name"),
            replacementFields = emptyList(),
            clearedFields = listOf("password"),
        ).single()

        assertEquals(listOf("name"), partition.fieldMask)
        assertTrue(partition.secretFields.isEmpty())
        assertEquals(listOf("password"), partition.clearSecretFields)
    }
}
