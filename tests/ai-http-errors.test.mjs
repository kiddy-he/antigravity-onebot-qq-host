import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {requestAiJson,aiHttpError} from '../src/src/ai/http.js';
import {createAiRouter,validateAiConfig} from '../src/src/ai/router.js';
const network={error:{type:'network_error',code:'upstream_network_error',message:'private provider message'}};
test('known HTTP 400 network envelopes are retryable, real bad requests/auth/policy remain terminal',()=>{
 assert.equal(aiHttpError(400,JSON.stringify(network)).kind,'network_error');
 assert.equal(aiHttpError(400,JSON.stringify({error:{status:'INVALID_ARGUMENT',message:'URL_UNREACHABLE-UNREACHABLE_CONNECT_TIMEOUT'}})).kind,'network_error');
 for(const [status,body,kind] of [[400,{error:{code:'invalid_value',message:'network_error'}},'invalid_request'],[400,{error:{type:'network_error',code:'content_policy_violation'}},'policy_blocked'],[401,network,'authentication_error'],[403,network,'authentication_error'],[429,network,'rate_limited'],[500,network,'upstream_5xx'],[400,{},'invalid_request']])assert.equal(aiHttpError(status,JSON.stringify(body)).kind,kind);
 assert.ok(!JSON.stringify(aiHttpError(400,JSON.stringify(network))).includes('private provider'));
});
test('native HTTP transport advances configured fallback after upstream wrapped network error',async t=>{
 let calls=0;const server=http.createServer((req,res)=>{req.resume();calls++;res.setHeader('content-type','application/json');res.statusCode=calls===1?400:200;res.end(JSON.stringify(calls===1?network:{text:'fallback ready'}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const cfg={schemaVersion:1,revision:'test',enabled:true,providers:{p:{adapter:'openai-chat',baseUrl:'https://example.invalid',credential:{source:'env',name:'TEST_KEY'}}},deployments:{a:{provider:'p',model:'a',capabilities:['text']},b:{provider:'p',model:'b',capabilities:['text']}},routes:{r:{steps:[{deployment:'a',timeoutMs:1000},{deployment:'b',timeoutMs:1000}],budgetMs:3000,fallbackOn:['network_error'],stopOn:['invalid_request']}},tasks:{t:{enabled:true,route:'r',requires:['text']}}};
 const router=createAiRouter({getConfig:()=>validateAiConfig(cfg),invoke:async()=>requestAiJson(`http://127.0.0.1:${server.address().port}`,{apiKey:'test',body:{},timeoutMs:1000})});
 const result=await router.run('t',{input:{}});assert.equal(result.model,'b');assert.equal(calls,2);
});
test('curl proxy transport uses the same bounded error classification',async()=>{
 const execute=(_file,_args,_opts,cb)=>{queueMicrotask(()=>cb(null,JSON.stringify(network)+'\n400'));const stdin=new EventEmitter();stdin.end=()=>{};return {stdin};};
 await assert.rejects(requestAiJson('https://example.invalid',{apiKey:'test',body:{},transport:{mode:'proxy'},execute}),e=>e.kind==='network_error');
});
