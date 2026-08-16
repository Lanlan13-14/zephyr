package one.zephyr.mobile.feature.notes

import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.model.CapabilitySet
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SftpCapabilitiesParityTest {

    @Test
    fun desktopWriteActionsStayBehindFileWrite() {
        val write = setOf(
            SftpAction.UPLOAD, SftpAction.CREATE, SftpAction.EDIT, SftpAction.RENAME,
            SftpAction.DELETE, SftpAction.CHMOD, SftpAction.COMPRESS, SftpAction.EXTRACT, SftpAction.PASTE,
        )
        write.forEach { action ->
            assertEquals(action.name, Capability.FILE_WRITE, SftpCapabilities.required(action))
        }
        val read = setOf(
            SftpAction.LIST, SftpAction.STAT, SftpAction.READ, SftpAction.DOWNLOAD,
            SftpAction.COPY, SftpAction.PROPERTIES,
        )
        read.forEach { action ->
            assertEquals(action.name, Capability.FILE_READ, SftpCapabilities.required(action))
        }
        assertEquals(write.size + read.size, SftpAction.entries.size)
    }

    @Test
    fun writeActionsStayVisibleWhenTheGrantIsReadOnly() {
        val readOnly = CapabilitySet(setOf(Capability.FILE_READ))
        assertTrue(SftpCapabilities.gate(readOnly, SftpAction.DELETE).isVisible)
        assertTrue(!SftpCapabilities.gate(readOnly, SftpAction.DELETE).isAllowed)
        assertTrue(SftpCapabilities.gate(readOnly, SftpAction.LIST).isAllowed)
    }
}
