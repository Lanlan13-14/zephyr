package one.zephyr.mobile.data

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class LocalImportPlannerTest {
    private fun row(type: String, id: String, json: String) = LocalImportSource(type, id, Json.parseToJsonElement(json).jsonObject)
    private fun plan(rows: List<LocalImportSource>, types: Set<String>) = LocalImportPlanner.plan(rows, types) { type, id -> "new-$type-$id" }

    @Test fun `all copies use new ids and only editable payload`() {
        val source = row("connection", "a", """{"name":"A","host":"localhost","password":"never-copy","ownerUserId":"local","revision":77,"rdpPipeline":{"private":1},"ephemeral":true}""")
        val copy = plan(listOf(source), setOf("connection")).single()
        assertEquals("new-connection-a", copy.newId)
        assertEquals(setOf("name", "host"), copy.values.keys)
        assertEquals("local", source.payload["ownerUserId"]?.jsonPrimitive?.content)
    }

    @Test fun `references are remapped across selected types including cycles`() {
        val rows = listOf(
            row("connection", "a", """{"name":"A","jumpHostIds":["j"],"sshKeyId":"k","proxyId":"p"}"""),
            row("jumpHost", "j", """{"name":"J","connectionId":"a"}"""),
            row("sshKey", "k", """{"name":"K"}"""), row("proxy", "p", """{"name":"P"}"""),
            row("note", "n", """{"title":"N","linkedConnectionIds":["a"],"shareWithUsers":true,"shareWithAdmins":true,"visibility":"public"}"""),
        )
        val copies = plan(rows, rows.map { it.type }.toSet()).associateBy { it.type }
        assertEquals("new-jumpHost-j", copies.getValue("connection").values.getValue("jumpHostIds").jsonArray.single().jsonPrimitive.content)
        assertEquals("new-connection-a", copies.getValue("jumpHost").values.getValue("connectionId").jsonPrimitive.content)
        assertEquals("new-connection-a", copies.getValue("note").values.getValue("linkedConnectionIds").jsonArray.single().jsonPrimitive.content)
        assertEquals(JsonPrimitive(false), copies.getValue("note").values["shareWithUsers"])
        assertEquals(JsonPrimitive(false), copies.getValue("note").values["shareWithAdmins"])
        assertEquals(JsonPrimitive("private"), copies.getValue("note").values["visibility"])
        assertEquals("proxy", copies.values.first().type)
    }

    @Test fun `ai history references are remapped without rewriting nested free form config`() {
        val rows = listOf(
            row("aiProvider", "p", """{"name":"P","config":{"providerId":"opaque-not-an-entity","nested":{"connectionId":"text"}}}"""),
            row("aiConversation", "c", """{"title":"C","providerId":"p"}"""),
            row("aiMessage", "m", """{"conversationId":"c","role":"user","content":"hi"}"""),
        )
        val copies = plan(rows, rows.map { it.type }.toSet()).associateBy { it.type }
        assertEquals("new-aiProvider-p", copies.getValue("aiConversation").values.getValue("providerId").jsonPrimitive.content)
        assertEquals("new-aiConversation-c", copies.getValue("aiMessage").values.getValue("conversationId").jsonPrimitive.content)
        assertEquals(rows.first().payload["config"], copies.getValue("aiProvider").values["config"])
    }

    @Test fun `nested credential aliases never enter durable plan`() {
        val copies = plan(listOf(row("aiProvider", "p", """{"name":"P","config":{"apiKey":"SECRET","nested":{"password":"SECRET"},"region":"r"}}""")), setOf("aiProvider"))
        assertFalse(copies.single().values.toString().contains("SECRET"))
        assertEquals(JsonPrimitive("r"), copies.single().values.getValue("config").jsonObject["region"])
    }

    @Test fun `unselected and unresolved dependencies fail before any write`() {
        val rows = listOf(row("connection", "a", """{"proxyId":"p"}"""), row("proxy", "p", """{"name":"P"}"""))
        assertThrows(IllegalStateException::class.java) { plan(rows, setOf("connection")) }
        assertThrows(IllegalArgumentException::class.java) { plan(rows.take(1), setOf("connection")) }
    }

    @Test fun `settings devices tokens acls metadata and unknown types cannot be copied as new`() {
        for (type in listOf("oneUserSettings", "serverSettings", "backupMetadata", "resourceAcl", "clientToken", "fileSyncConfig", "workspaceState", "activityEvent", "unknown")) {
            assertFalse(type, LocalImportPlanner.eligible(type))
            assertThrows(IllegalArgumentException::class.java) { LocalImportPlanner.plan(emptyList(), setOf(type)) }
        }
    }

    @Test fun `duplicate blank reused and colliding ids fail closed`() {
        val a = row("proxy", "a", """{"name":"P"}""")
        assertThrows(IllegalArgumentException::class.java) { plan(listOf(a, a), setOf("proxy")) }
        for (id in listOf("", "a")) assertThrows(IllegalArgumentException::class.java) { LocalImportPlanner.plan(listOf(a), setOf("proxy")) { _, _ -> id } }
        assertThrows(IllegalArgumentException::class.java) { LocalImportPlanner.plan(listOf(a, a.copy(id = "b")), setOf("proxy")) { _, _ -> "same" } }
        assertThrows(IllegalArgumentException::class.java) { plan(listOf(a), emptySet()) }
        assertThrows(IllegalArgumentException::class.java) { plan(listOf(a.copy(id = "")), setOf("proxy")) }
    }

    @Test fun `null and empty references are preserved numeric object and malformed references rejected`() {
        val copy = plan(listOf(row("connection", "a", """{"name":"A","proxyId":null,"sshKeyId":"","jumpHostIds":[]}""")), setOf("connection")).single()
        assertEquals(JsonNull, copy.values["proxyId"])
        assertEquals(JsonPrimitive(""), copy.values["sshKeyId"])
        for (json in listOf("""{"proxyId":5}""", """{"proxyId":{}}""")) assertThrows(IllegalArgumentException::class.java) {
            plan(listOf(row("connection", "a", json)), setOf("connection"))
        }
    }
}
