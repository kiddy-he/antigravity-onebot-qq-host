import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocketServer} from 'ws';
import {DatabaseSync} from 'node:sqlite';

const project = fileURLToPath(new URL('../',import.meta.url));
const deadline = async (check, label, diagnostics) => {
    for (let n=0; n<150; n++) {
        if (check()) return;
        await delay(100);
    }
    assert.fail(label+'\n'+diagnostics());
};
const listen = async server => {
    server.listen(0,'127.0.0.1'); await once(server,'listening');
    return server.address().port;
};
test('standalone host receives synthetic LLBot events, uses HTTP and ACP, records receipts and resumes', {timeout:50000}, async t=>{
    const dir=await mkdtemp(join(tmpdir(),'onebot-public-'));
    const config=join(dir,'config'), profile=join(dir,'profile'), sends=[], clients=new Map();
    const mock=createServer(async(req,res)=>{
        if (req.method!=='POST') {res.writeHead(404).end();return;}
        const chunks=[]; for await (const chunk of req) chunks.push(chunk);
        const body=JSON.parse(Buffer.concat(chunks));
        res.setHeader('content-type','application/json');
        if(req.url.startsWith('/v1beta/models/')){
            const review=JSON.stringify(body).includes('clean|reject');
            const text=JSON.stringify(review ? {judgement:'clean',reason:'fixture'} : {need_web_search:false,image_generation:false,official_reference:false,backend_operation:false,speech_mode:'none',reminder_action:'none',quota_action:'none'});
            apiCalls++;
            res.end(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text}]}}]}));
        } else {
            const account=req.url.split('/')[1];
            if(req.url.endsWith('/send_private_msg')||req.url.endsWith('/send_group_msg')) sends.push({account,body});
            res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:100+sends.length}}));
        }
    });
    let apiCalls=0, log='', child;
    const port=await listen(mock), ws=new WebSocketServer({server:mock});
    ws.on('connection',(socket,req)=>clients.set(new URL(req.url,'http://localhost').pathname.slice(1),socket));
    t.after(async()=>{
        if(child && child.exitCode===null && child.signalCode===null){
            const closed=once(child,'close');child.kill('SIGTERM');
            const timer=setTimeout(()=>child.kill('SIGKILL'),2500);await closed;clearTimeout(timer);
        }
        for(const socket of ws.clients) socket.terminate();
        await new Promise(done=>ws.close(done));
        mock.closeAllConnections();await new Promise(done=>mock.close(done));
        await rm(dir,{recursive:true,force:true});
    });
    // Port zero is used only by the isolated fixture after validating the real starter.
    const accounts=['default','yuexia'].map((id,i)=>({id,name:'Bot '+i,selfId:String(90001+i),privateAdminIds:['90003'],groupIds:['90004'],
        wsUrl:'ws://127.0.0.1:'+port+'/'+id,httpUrl:'http://127.0.0.1:'+port+'/'+id,tokenEnv:'DEMO_TOKEN'}));
    const spec=join(dir,'accounts.json');
    await writeFile(spec,JSON.stringify({accounts,gatewayPort:18789,cliModel:'demo-cli',geminiModel:'demo-api'}));
    await mkdir(profile);await writeFile(join(profile,'antigravity-oauth-token'),'fixture',{mode:0o600});
    const env={PATH:process.env.PATH,ONEBOT_CONFIG_ROOT:config,ONEBOT_AGY_PROFILE_DIR:profile,
        ONEBOT_AGY_BIN:join(project,'tests/fixtures/agy.py'),GEMINI_API_KEY:'fixture',DEMO_TOKEN:'fixture'};
    execFileSync(process.execPath,['scripts/init-config.mjs',spec,config],{cwd:project,env,stdio:'pipe'});
    for(const [name,change] of [
        ['onebot-ai.json',x=>{x.providers['gemini-official'].baseUrl='http://127.0.0.1:'+port+'/v1beta';}],
        ['openclaw.json',x=>{x.gateway.port=0;}]
    ]){
        const file=join(config,name),value=JSON.parse(await readFile(file,'utf8'));change(value);await writeFile(file,JSON.stringify(value));
    }
    child=spawn(process.execPath,['scripts/standalone-onebot.mjs','serve'],{cwd:project,env,stdio:['ignore','pipe','pipe']});
    for(const stream of [child.stdout,child.stderr]) stream.on('data',chunk=>{log=(log+chunk).slice(-6000);});
    await deadline(()=>{if(child.exitCode!==null) throw Error(log);return clients.size===2;},'Two sockets did not connect',()=>log);
    const incoming=(id,n,group=false)=>({post_type:'message',message_type:group?'group':'private',self_id:id==='default'?90001:90002,
        user_id:90003,message_id:n,...(group?{group_id:90004}:{}),sender:{user_id:90003,nickname:'Test sender'},time:Math.floor(Date.now()/1000),
        message:[...(group?[{type:'at',data:{qq:id==='default'?'90001':'90002'}}]:[]),{type:'text',data:{text:'hello fixture '+n}}]});
    for(const [index,[id,n,group]] of [['default',1,false],['default',2,false],['yuexia',3,true]].entries()){
        clients.get(id).send(JSON.stringify(incoming(id,n,group)));
        await deadline(()=>sends.length>index,'No QQ receipt',()=>log);
        assert.equal(sends[index].account,id);
        assert.match(JSON.stringify(sends[index].body.message),/Public fixture reply/,log);
        assert.equal(String(sends[index].body[group?'group_id':'user_id']),group?'90004':'90003');
    }
    assert.ok(apiCalls>0,'The official API route should be exercised');
    clients.get('yuexia').send(JSON.stringify(incoming('yuexia',3,true)));
    await delay(250);assert.equal(sends.length,3);
    const db=new DatabaseSync(join(config,'state/antigravity/sessions.sqlite'),{readOnly:true});
    try {assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cli_sessions WHERE confirmed=1').get().n,2);} finally {db.close();}
    const metrics=await readFile(join(config,'state/antigravity/metrics',new Date().toISOString().slice(0,10)+'.jsonl'),'utf8');
    assert.ok(metrics.split('\n').filter(Boolean).map(JSON.parse).some(e=>e.event==='native-session'&&e.resumed===true));
});
