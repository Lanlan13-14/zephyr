package one.zephyr.mobile.network

import kotlinx.serialization.Serializable
import one.zephyr.mobile.network.dto.BootstrapPageDto
import one.zephyr.mobile.network.dto.CapabilitiesDto
import one.zephyr.mobile.network.dto.ChangePageDto
import one.zephyr.mobile.network.dto.toDomain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProductionSyncWireFixtureTest {

    @Test
    fun `production generators decode through MobileJson and domain mappers`() {
        val raw = requireNotNull(javaClass.classLoader?.getResourceAsStream(FIXTURE)) {
            "missing $FIXTURE"
        }.bufferedReader().use { it.readText() }

        val fixture = MobileJson.instance.decodeFromString(ProductionSyncWireFixture.serializer(), raw)
        val capabilities = fixture.capabilities.toDomain()
        val bootstrap = fixture.bootstrap.toDomain()
        val changes = fixture.changes.toDomain()

        assertEquals(listOf(1), capabilities.protocolVersions)
        assertNull(capabilities.serverEncryption)
        assertTrue(bootstrap.complete)
        assertNull(bootstrap.nextPageToken)
        assertEquals(2, bootstrap.entities.size)
        assertEquals(1L, bootstrap.entities[0].changedAt)
        assertEquals("oneUserSettings", bootstrap.entities[1].entityType)
        assertTrue(bootstrap.entities[1].fieldMask.isEmpty())
        assertTrue(bootstrap.entities[1].payload.containsKey("appearance.customCss"))
        assertEquals(0L, changes.fromCursor)
        assertEquals(1L, changes.nextCursor)
        assertEquals(2L, changes.changes.single().changedAt)
    }

    private companion object {
        const val FIXTURE = "production-sync-wire.json"
    }
}

@Serializable
internal data class ProductionSyncWireFixture(
    val capabilities: CapabilitiesDto,
    val bootstrap: BootstrapPageDto,
    val changes: ChangePageDto,
)
