package one.zephyr.mobile.data.mapper

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.data.EntityCodec
import one.zephyr.mobile.data.db.MirrorEntityRow
import one.zephyr.mobile.model.ConnectionMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConnectionMapperBlankIdTest {

    @Test
    fun `empty sshKeyId from the owned-sync wire is absent not a live dependency`() {
        val connection = ConnectionMapper.fromRow(
            row(
                JsonObject(
                    mapOf(
                        "name" to JsonPrimitive("Yunyo FRA"),
                        "host" to JsonPrimitive("10.0.0.1"),
                        "port" to JsonPrimitive(22),
                        "protocol" to JsonPrimitive("SSH"),
                        "username" to JsonPrimitive("root"),
                        "connectionMode" to JsonPrimitive("direct"),
                        "sshKeyId" to JsonPrimitive(""),
                        "proxyId" to JsonPrimitive(""),
                    ),
                ),
            ),
            pending = false,
            conflicted = false,
        )

        assertNull(connection.sshKeyId)
        assertNull(connection.proxyId)
        assertEquals(ConnectionMode.DIRECT, connection.connectionMode)
        assertEquals(emptyList<String>(), connection.dependencyIds)
    }

    @Test
    fun `edit values emit JSON null for a cleared sshKeyId`() {
        val connection = ConnectionMapper.fromRow(
            row(
                JsonObject(
                    mapOf(
                        "name" to JsonPrimitive("n"),
                        "host" to JsonPrimitive("h"),
                        "port" to JsonPrimitive(22),
                        "protocol" to JsonPrimitive("SSH"),
                    ),
                ),
            ),
            pending = false,
            conflicted = false,
        )
        val values = ConnectionMapper.editValues(connection, listOf("sshKeyId", "proxyId"))
        assertEquals(JsonNull, values["sshKeyId"])
        assertEquals(JsonNull, values["proxyId"])
    }

    private fun row(payload: JsonObject): MirrorEntityRow = MirrorEntityRow(
        entityType = "connection",
        entityId = "c-1",
        ownerUserId = "user-1",
        revision = 1,
        payloadJson = EntityCodec.encode(payload),
        secretPresenceJson = "{}",
        deletedAt = null,
        serverUpdatedAt = 1L,
        localUpdatedAt = 1L,
    )
}
