#!/usr/bin/env node
import {loadAiConfig,syncAiRegistry,configuredTaskRoutes,AI_CONFIG_PATH} from '../src/src/ai/config.js';
import {resolveTask} from './ai-request.mjs';
try{
 const args=process.argv.slice(2),config=loadAiConfig();
 if(args.includes('--effective')){const task=args[args.indexOf('--effective')+1];console.log(JSON.stringify(resolveTask(task,config),null,2));}
 else if(args.includes('--sync'))console.log(JSON.stringify({ok:true,revision:config.revision,changed:syncAiRegistry(config)}));
 else if(args.length&&args[0]!=='--check')throw Error('Use --check, --effective TASK or --sync; edit onebot-ai.json to change routing');
 else console.log(JSON.stringify({ok:true,path:AI_CONFIG_PATH,revision:config.revision,tasks:Object.keys(config.tasks).length,routes:Object.keys(config.routes).length,providers:Object.keys(config.providers).length}));
}catch(error){console.error(JSON.stringify({ok:false,kind:error.kind??'configuration_error'}));process.exitCode=1;}
