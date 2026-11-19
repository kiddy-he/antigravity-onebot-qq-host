#!/usr/bin/env node
import http from 'node:http';
import {onebotPath} from '../src/src/paths.js';
process.env.ONEBOT_STANDALONE='1';
const args=process.argv.slice(2);
if(args.length===0 || args[0]==='serve'){
    await import('./ai-transport-preload.mjs');
    const {serve}=await import('../src/src/standalone/server.js');
    const stop=new AbortController();
    process.once('SIGINT',()=>stop.abort());process.once('SIGTERM',()=>stop.abort());
    await serve({signal:stop.signal});
}else{
    const response=await new Promise((resolve,reject)=>{
        const request=http.request({socketPath:onebotPath('state','standalone','control.sock'),path:'/command',method:'POST'},resolve);
        request.on('error',reject);request.end(JSON.stringify(args));
    });
    const chunks=[];for await(const chunk of response)chunks.push(chunk);
    const body=Buffer.concat(chunks).toString('utf8');
    if(response.statusCode!==200)throw Error(JSON.parse(body).error??'Control request failed');
    console.log(body);
}
