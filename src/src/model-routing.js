import {onebotPath} from './paths.js';
import {readFileSync} from 'node:fs';
import {loadAiConfig,configuredTaskRoutes,firstTaskRoute,watchAiConfig} from './ai/config.js';
export const MODEL_ROUTING_PATH=onebotPath('onebot-model-routing.json');
export function loadModelRouting(path){
  // Explicit legacy files are accepted for offline fixtures/migration only.
  if(path){const c=JSON.parse(readFileSync(path,'utf8')),p=c.presets?.[c.activePreset];if(!p)throw Error('Invalid routing preset');return {presetName:c.activePreset,...p,flashLiteFallbacks:c.flashLiteFallbacks??p.errorFallbacks};}
  const config=loadAiConfig();
  return {presetName:config.bindings?.activePreset??config.revision,
    conversation:firstTaskRoute('chat.reply',{config}),textReview:firstTaskRoute('chat.text.review',{config}),
    contentFallbacks:configuredTaskRoutes('chat.content.fallback',{config}),errorFallbacks:configuredTaskRoutes('chat.error.fallback',{config}),
    flashLiteFallbacks:configuredTaskRoutes('inbound.intent',{config})};
}
export function currentRouting(){return new Proxy({}, {get(_target,key){return loadModelRouting()[key];}});}
