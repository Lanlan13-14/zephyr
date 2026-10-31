import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import ssh2 from 'ssh2';
import crypto from 'node:crypto';
import { TestServer } from './test-server.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function queue(socket) {
    const messages = [], waiting = [];
    socket.on('message', bytes => {
        const message = JSON.parse(String(bytes));
        const index = waiting.findIndex(item => item.matches(message));
        if (index < 0) messages.push(message);
        else { const [item] = waiting.splice(index, 1); clearTimeout(item.timer); item.resolve(message); }
    });
    function next(matches) {
        const index = messages.findIndex(matches);
        if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
        return new Promise((resolve, reject) => {
            const item = { matches, resolve, timer: setTimeout(() => { waiting.splice(waiting.indexOf(item), 1); reject(new Error('PTY message timeout')); }, 8000) };
            waiting.push(item);
        });
    }
    return { next, async rpc(body) {
        const requestId = crypto.randomUUID();
        socket.send(JSON.stringify({type:'handoff.rpc',requestId,body}));
        return (await next(v=>v.type==='handoff.reply' && v.requestId===requestId)).body;
    }};
}
async function open(app,cookie) {
    const socket=new WebSocket(app.url('/ssh').replace(/^http/,'ws'),{headers:{Cookie:cookie}}), inbox=queue(socket);
    await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
    return {socket,...inbox};
}

test('real server retains ONE SSH PTY while target receives snapshot, input and resize; old socket cannot reclaim/destroy', {timeout:60000}, async()=>{
    const peers=new Set(), streams=new Set(), inputs=[]; let shells=0, ptyStream, size;
    const ssh=new ssh2.Server({hostKeys:[ssh2.utils.generateKeyPairSync('ed25519').private]},client=>{
        peers.add(client); client.on('error',()=>{}); client.on('close',()=>peers.delete(client));
        client.on('authentication',ctx=>ctx.method==='password' && ctx.username==='pty' && ctx.password==='pty-pass'?ctx.accept():ctx.reject());
        client.on('ready',()=>client.on('session',accept=>{
            const session=accept();
            session.on('pty',acceptPty=>acceptPty());
            session.on('window-change',(acceptWindow,_reject,info)=>{size=info;acceptWindow?.();});
            session.on('shell',acceptShell=>{
                shells++; ptyStream=acceptShell();streams.add(ptyStream);ptyStream.on('error',()=>{});
                ptyStream.write('\x1b[2J\x1b[Hprimary-before-transfer');
                ptyStream.on('data',bytes=>{inputs.push(Buffer.from(bytes));ptyStream.write('echo:'+bytes.toString());});
            });
            session.on('exec',acceptExec=>{const stream=acceptExec();stream.on('error',()=>{});stream.exit(0);stream.end();});
        }));
    });
    await new Promise(resolve=>ssh.listen(0,'127.0.0.1',resolve));
    const app=await new TestServer().start(), sockets=[];
    try {
        const {cookie}=await app.bootstrapAdmin('pty-handoff-admin-pass');
        const created=await app.api(cookie,'POST','/api/connections',{name:'Real primary',protocol:'SSH',host:'127.0.0.1',port:ssh.address().port,username:'pty',password:'pty-pass',connectionMode:'direct'});
        assert.equal(created.status,200,JSON.stringify(created.body));
        const source=await open(app,cookie);sockets.push(source.socket);
        source.socket.send(JSON.stringify({type:'connect',sessionId:'real-primary-pty',connectionId:created.body.connection.id,cols:80,rows:24}));
        await source.next(v=>v.type==='ready');
        await source.next(v=>v.type==='data' && v.data.includes('primary-before-transfer'));
        const enabled=await source.rpc({op:'handoff.enable'});assert.equal(enabled.ok,true,JSON.stringify(enabled));
        const receiver=await open(app,cookie);sockets.push(receiver.socket);
        const listed=await receiver.rpc({op:'handoff.list'}); assert.equal(listed.sessions.length,1);
        const prepared=await receiver.rpc({op:'handoff.prepare',sessionId:'real-primary-pty'});
        assert.equal(prepared.ok,true,JSON.stringify(prepared));assert.match(prepared.snapshot.data,/primary-before-transfer/);
        assert.equal(shells,1);
        const noAck=await receiver.rpc({op:'handoff.commit',prepareId:prepared.prepareId,snapshotHash:'bad',appliedSequence:prepared.snapshot.outputSequence});
        assert.equal(noAck.error.code,'snapshot_not_applied');
        const commit=await receiver.rpc({op:'handoff.commit',prepareId:prepared.prepareId,snapshotHash:prepared.snapshot.snapshotHash,appliedSequence:prepared.snapshot.outputSequence});
        assert.equal(commit.ok,true,JSON.stringify(commit));assert.equal(commit.sessionEpoch,2);
        assert.equal((await source.next(v=>v.type==='HANDOFF_TRANSFERRED')).sessionEpoch,2);
        source.socket.send(JSON.stringify({type:'input',data:'forbidden-old-input\n'}));
        source.socket.send(JSON.stringify({type:'disconnect'}));
        await pause(80); assert.equal(shells,1);assert.equal(ptyStream.destroyed,false);assert.equal(inputs.length,0);
        const input={op:'pty.input',sessionId:'real-primary-pty',sessionEpoch:2,inputSeq:1,data:Buffer.from('accepted-once\n').toString('base64')};
        assert.equal((await receiver.rpc(input)).ok,true);assert.equal((await receiver.rpc(input)).ok,true);
        for(let i=0;i<50 && !inputs.length;i++)await pause(20);
        assert.equal(Buffer.concat(inputs).toString(),'accepted-once\n');
        assert.equal((await receiver.rpc({op:'pty.resize',sessionId:'real-primary-pty',sessionEpoch:2,cols:100,rows:35})).ok,true);
        for(let i=0;i<50 && !size;i++)await pause(20);
        assert.equal(size.cols,100);assert.equal(size.rows,35);
        let output='';
        for(let i=0;i<50;i++){
            const result=await receiver.rpc({op:'pty.read',sessionId:'real-primary-pty',sessionEpoch:2,afterSeq:commit.nextSeq});
            assert.equal(result.ok,true,JSON.stringify(result));
            output=Buffer.concat(result.frames.map(frame=>Buffer.from(frame.data,'base64'))).toString();
            if(output.includes('accepted-once'))break;
            await pause(20);
        }
        assert.match(output,/accepted-once/);assert.equal(shells,1);
        const reconnect=await open(app,cookie);sockets.push(reconnect.socket);
        reconnect.socket.send(JSON.stringify({type:'connect',sessionId:'real-primary-pty',connectionId:created.body.connection.id}));
        assert.equal((await reconnect.next(v=>v.type==='error')).code,'handoff_required');
        assert.equal(shells,1);
        assert.equal((await receiver.rpc({...input,sessionEpoch:1,inputSeq:2})).error.code,'stale_owner');
    } finally {
        for(const socket of sockets)socket.terminate();
        await app.cleanup();
        for(const stream of streams)stream.destroy();
        for(const peer of peers)peer.destroy();
        await new Promise(resolve=>ssh.close(resolve));
    }
});
