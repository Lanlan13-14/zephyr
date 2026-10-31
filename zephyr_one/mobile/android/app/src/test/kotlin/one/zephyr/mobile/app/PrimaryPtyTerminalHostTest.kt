package one.zephyr.mobile.app

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.serialization.json.*
import one.zephyr.mobile.feature.sessions.*
import one.zephyr.mobile.model.Protocol
import org.junit.Assert.*
import org.junit.Test

class PrimaryPtyTerminalHostTest {
    private val owned = object : TerminalHost {
        override val isAvailable = true
        override suspend fun open(request: TerminalOpenRequest): TerminalOpenOutcome = error("must not open upstream")
        override fun output(sessionId: String) = emptyFlow<ByteArray>()
        override fun transportFor(sessionId: String): TerminalTransport = error("must not use direct input")
        override suspend fun close(sessionId: String) = Unit
    }
    private fun request(id: String) = TerminalOpenRequest(id, Protocol.SSH, "unused", 22, "unused", password="secret".toCharArray())
    private fun prepared() = buildJsonObject {
        put("ok",true);put("prepareId","p");putJsonObject("snapshot") {
            put("data","\u001bcSCREEN");put("snapshotHash","hash");put("outputSequence",3);put("cols",80);put("rows",24)
        }
    }
    private fun committed() = buildJsonObject {put("ok",true);put("sessionEpoch",2);put("nextSeq",3);put("hasMore",false);putJsonArray("frames") {}}

    @Test fun `no control commit or input before same bytes consumed and screen rendered`() = runBlocking {
        val calls=mutableListOf<JsonObject>()
        val commit=CompletableDeferred<Unit>()
        val screen=CompletableDeferred<Unit>()
        val rendered=CompletableDeferred<Unit>()
        val host=PrimaryPtyTerminalHost("owner",owned) { body ->
            calls+=body
            when(body["op"]!!.jsonPrimitive.content) {
                "handoff.prepare" -> prepared()
                "handoff.commit" -> {commit.complete(Unit);committed()}
                "pty.read" -> committed()
                else -> buildJsonObject {put("ok",true)}
            }
        }
        val id=host.select(PrimaryPtyCandidate("server-pty","connection","Work"))
        val req=request(id)
        assertTrue(host.open(req) is TerminalOpenOutcome.Opened)
        assertTrue(req.password!!.all{it=='\u0000'})
        assertEquals(80 to 24,host.initialSize(id));assertTrue(host.isPrimaryPty(id))
        val job=launch {host.output(id).collect{bytes->screen.complete(Unit);rendered.await();host.outputApplied(id,bytes)}}
        withTimeout(2000){screen.await()};yield()
        assertFalse(commit.isCompleted)
        assertTrue(runCatching { host.transportFor(id).write(byteArrayOf(1)) }.isFailure)
        rendered.complete(Unit)
        withTimeout(2000){commit.await()}
        assertEquals(listOf("handoff.prepare","handoff.commit"),calls.take(2).map{it["op"]!!.jsonPrimitive.content})
        host.transportFor(id).write("pwd\n".toByteArray())
        val input=calls.last{it["op"]!!.jsonPrimitive.content=="pty.input"}
        assertEquals(2,input["sessionEpoch"]!!.jsonPrimitive.int);assertEquals(1,input["inputSeq"]!!.jsonPrimitive.int)
        host.close(id);job.cancel();job.join()
    }

    @Test fun `wrong byte array does not acknowledge snapshot and close cannot claim source`() = runBlocking {
        val seen=mutableListOf<String>()
        val received=CompletableDeferred<ByteArray>()
        val host=PrimaryPtyTerminalHost("owner",owned) {body->
            val op=body["op"]!!.jsonPrimitive.content;seen+=op
            when(op){"handoff.prepare"->prepared();"handoff.commit"->error("must not commit");else->buildJsonObject{put("ok",true)}}
        }
        val id=host.select(PrimaryPtyCandidate("pty","connection","Work"));host.open(request(id))
        val job=launch {host.output(id).collect{received.complete(it)}}
        withTimeout(2000){received.await()};yield()
        host.outputApplied(id,"different".toByteArray());yield()
        assertFalse(seen.contains("handoff.commit"));assertTrue(host.requiresRenderAck(id))
        host.close(id);job.cancel();job.join()
        assertTrue(seen.contains("handoff.abort"));assertFalse(seen.contains("handoff.commit"))
    }

    @Test fun `uncertain input closes lease and never retries with new sequence`() = runBlocking {
        var inputs=0;val ready=CompletableDeferred<Unit>()
        val host=PrimaryPtyTerminalHost("owner",owned){body->when(body["op"]!!.jsonPrimitive.content){
            "handoff.prepare"->prepared()
            "handoff.commit"->{ready.complete(Unit);committed()}
            "pty.input"->{inputs++;error("lost reply")}
            else->committed()
        }}
        val id=host.select(PrimaryPtyCandidate("pty","connection","Work"));host.open(request(id))
        val job=launch{host.output(id).collect{host.outputApplied(id,it)}}
        withTimeout(2000){ready.await()};yield()
        assertTrue(runCatching{host.transportFor(id).write(byteArrayOf(1))}.isFailure)
        assertTrue(runCatching{host.transportFor(id).write(byteArrayOf(1))}.isFailure)
        assertEquals(1,inputs);host.close(id);job.cancel();job.join()
    }
}
