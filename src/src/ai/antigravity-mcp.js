import {createServer,request} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline';

function reply(res,code,value) {
    res.writeHead(code,{'content-type':'application/json'});
    res.end(JSON.stringify(value));
}
async function body(stream,limit) {
    const pieces=[];let size=0;
    for await(const chunk of stream){size+=chunk.length;if(size>limit) throw new Error('Message too large');pieces.push(chunk);}
    return JSON.parse(Buffer.concat(pieces).toString());
}

// The agent child gets a stdio MCP server with one short-lived capability.
// Authority is re-resolved by the gateway for each call, outside the CLI.
export async function withTurnTools(tools,signal,run,bindMetrics=handler=>handler){
    if(!tools?.list().length) return run([],undefined);
    const dir=await mkdtemp(join(tmpdir(),'onebot-mcp-')),socket=join(dir,'turn'),ticket=randomUUID();
    const lifetime=new AbortController(),bounded=signal?AbortSignal.any([lifetime.signal,signal]):lifetime.signal;
    const calls=new Map();
    // The accepted socket is a new async resource. Tool activity belongs to the
    // originating QQ turn, including any fixed business script started by it.
    const server=createServer(bindMetrics(async(req,res)=>{
        if(req.headers.authorization!=='Bearer '+ticket||req.method!=='POST'||req.url!=='/'||bounded.aborted)return reply(res,403,{});
        try{
            const event=await body(req,1024*1024);
            if(event.method==='list')return reply(res,200,{tools:tools.list()});
            if(event.method!=='call'||typeof event.id!=='string'||event.id.length>128||!tools.list().some(t=>t.name===event.name))
                return reply(res,403,{});
            const args=JSON.stringify([event.name,event.arguments]);
            const prior=calls.get(event.id);
            if(prior && prior.args!==args) return reply(res,409,{});
            if(!prior) {
                if(calls.size>=128)return reply(res,429,{});
                calls.set(event.id,{args,result:Promise.resolve().then(()=>tools.call(event.name,event.arguments,event.id,bounded))});
            }
            const value=await calls.get(event.id).result;
            reply(res,200,{content:value.content,isError:!!value.isError});
        }catch{reply(res,400,{error:'Tool operation failed'});}
    }));
    try {
        await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
        const definition={name:'onebot',command:process.execPath,args:[fileURLToPath(import.meta.url),socket],env:[{name:'ONEBOT_MCP_TICKET',value:ticket}]};
        const permission=params=>{
            const name=params.toolCall?.name;
            if(typeof name!=='string'||!tools.list().some(t=>name==='mcp_onebot_'+t.name || name==='mcp__onebot__'+t.name))return;
            return params.options.find(o=>o.kind==='allow_once')?.optionId;
        };
        return await run([definition],permission);
    }finally{
        lifetime.abort();server.closeAllConnections();
        await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});
    }
}

function post(socket,event){
    return new Promise((resolve,reject)=>{
        const req=request({socketPath:socket,path:'/',method:'POST',headers:{authorization:'Bearer '+process.env.ONEBOT_MCP_TICKET}},
            res=>{body(res,1024*1024).then(value=>res.statusCode===200?resolve(value):reject(new Error('Denied')),reject);});
        req.on('error',reject);req.end(JSON.stringify(event));
    });
}
async function serve(socket){
    const send=message=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
    for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
        let message;try{message=JSON.parse(line);}catch{continue;}
        if(message.id==null)continue;
        try{
            let result;
            if(message.method==='initialize') result={protocolVersion:['2025-11-25','2025-06-18','2025-03-26','2024-11-05'].includes(message.params?.protocolVersion)?message.params.protocolVersion:'2025-06-18',
                capabilities:{tools:{}},serverInfo:{name:'onebot',version:'1'}};
            else if(message.method==='ping')result={};
            else if(message.method==='tools/list')result=await post(socket,{method:'list'});
            else if(message.method==='tools/call') result=await post(socket,{method:'call',id:String(message.id),name:message.params?.name,arguments:message.params?.arguments??{}});
            else {send({id:message.id,error:{code:-32601,message:'Unknown method'}});continue;}
            send({id:message.id,result});
        }catch{send({id:message.id,error:{code:-32603,message:'OneBot tool unavailable'}});}
    }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) serve(process.argv[2]).catch(()=>{process.exitCode=1;});
