import test from 'node:test';
import assert from 'node:assert/strict';
import {createShortTermModelContext} from '../src/src/short-term-model-context.js';
const user=(timestamp,text)=>({role:'user',timestamp,content:[{type:'text',text}]});
const assistant=text=>({role:'assistant',content:[{type:'text',text}]});
test('short-term projection preserves actual sent background while native transcript remains clean',()=>{
 const restore=createShortTermModelContext();const raw=[user(1,'问题')],sent=[user(1,'问题\n冻结的本轮背景')];
 assert.equal(restore({scope:'a',sourceMessages:raw,modelMessages:sent}),sent);
 const next=[{...raw[0],content:'问题'},assistant('已送达'),user(2,'继续')];
 const result=restore({scope:'a',sourceMessages:next,modelMessages:next});
 assert.equal(result[0].content[0].text,'问题\n冻结的本轮背景');assert.equal(next[0].content,'问题');assert.equal(result[1],next[1]);
 result[0].content[0].text='外部修改';
 assert.equal(restore({scope:'a',sourceMessages:next,modelMessages:next})[0].content[0].text,'问题\n冻结的本轮背景');
});
test('short-term projections isolate users groups roles modes and models',()=>{
 const restore=createShortTermModelContext();
 for(const scope of ['private-a','private-b','group-a','group-b','role-b','mode-isolated','model-b'])restore({scope,sourceMessages:[user(1,'相同正文')],modelMessages:[user(1,scope)]});
 for(const scope of ['private-a','private-b','group-a','group-b','role-b','mode-isolated','model-b'])assert.equal(restore({scope,sourceMessages:[user(1,'相同正文')],modelMessages:[user(1,'相同正文')]})[0].content[0].text,scope);
});
test('edited input, reset and compaction cannot resurrect old background',()=>{
 const restore=createShortTermModelContext();restore({scope:'s',sourceMessages:[user(1,'旧问题')],modelMessages:[user(1,'旧问题 SECRET')]});
 assert.equal(restore({scope:'s',sourceMessages:[user(1,'已编辑')],modelMessages:[user(1,'已编辑')]})[0].content[0].text,'已编辑');
 restore({scope:'s',sourceMessages:[],modelMessages:[]});
 assert.equal(restore({scope:'s',sourceMessages:[user(1,'旧问题')],modelMessages:[user(1,'旧问题')]})[0].content[0].text,'旧问题');
});
test('multimodal inputs, tools and assistant output remain intact',()=>{
 const restore=createShortTermModelContext(),m=user(1,'看图');m.content.push({type:'image',data:'AAAA',mimeType:'image/png'});
 const projected=structuredClone(m);projected.content[0].text+=' 背景';
 restore({scope:'s',sourceMessages:[m],modelMessages:[projected]});
 const tool={role:'toolResult',toolCallId:'x',content:'结果'},model=[m,assistant('输出'),tool];
 const result=restore({scope:'s',sourceMessages:model,modelMessages:model});assert.equal(result[0].content[1].data,'AAAA');assert.equal(result[2],tool);assert.equal(result[1],model[1]);
});
test('message and scope limits evict memory passively without changing current request',()=>{
 const restore=createShortTermModelContext({maxScopes:1,maxMessages:1,maxBytes:1024});
 restore({scope:'a',sourceMessages:[user(1,'一')],modelMessages:[user(1,'一 OLD')]});
 restore({scope:'b',sourceMessages:[user(1,'二')],modelMessages:[user(1,'二 NEW')]});
 assert.equal(restore({scope:'a',sourceMessages:[user(1,'一')],modelMessages:[user(1,'一')]})[0].content[0].text,'一');
 const noTime=[{role:'user',content:'无时间戳'}];assert.equal(restore({scope:'x',sourceMessages:noTime,modelMessages:noTime}),noTime);
});

test('host millisecond to second timestamp replay retains projections without merging duplicate messages',()=>{
 const restore=createShortTermModelContext();
 const raw=[user(1794573755910,'相同原文'),user(1794573755990,'相同原文')];
 const sent=[user(1794573755910,'第一份背景'),user(1794573755990,'第二份背景')];
 restore({scope:'sdk',sourceMessages:raw,modelMessages:sent});
 const reloaded=[user(1794573755000,'相同原文'),user(1794573755000,'相同原文')];
 const result=restore({scope:'sdk',sourceMessages:reloaded,modelMessages:reloaded});
 assert.equal(result[0].content[0].text,'第一份背景');assert.equal(result[1].content[0].text,'第二份背景');
 const edited=[user(1794573755000,'已编辑')];
 assert.equal(restore({scope:'sdk',sourceMessages:edited,modelMessages:edited})[0].content[0].text,'已编辑');
});
test('queued input event time can differ from processing time across seconds',()=>{
 const restore=createShortTermModelContext(),raw=[user(1794574108987,'排队的同一问题')];
 restore({scope:'queued',sourceMessages:raw,modelMessages:[user(1794574108987,'排队的同一问题\n首次背景')]});
 const replay=[user(1794574099000,'排队的同一问题'),user(1794574113000,'继续')];
 assert.equal(restore({scope:'queued',sourceMessages:replay,modelMessages:replay})[0].content[0].text,'排队的同一问题\n首次背景');
});
test('trimmed duplicate sequence invalidates snapshots rather than guessing which duplicate remains',()=>{
 const restore=createShortTermModelContext(),raw=[user(1000,'相同'),user(2000,'相同')];
 restore({scope:'trim',sourceMessages:raw,modelMessages:[user(1000,'第一份背景'),user(2000,'第二份背景')]});
 const trimmed=[user(2000,'相同')];
 assert.equal(restore({scope:'trim',sourceMessages:trimmed,modelMessages:trimmed})[0].content[0].text,'相同');
});
