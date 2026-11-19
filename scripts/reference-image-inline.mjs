/** Download public reference bytes locally before handing them to vision providers. */
import {pathToFileURL} from 'node:url';
import sharp from 'sharp';
import {loadAiConfig} from '../src/src/ai/config.js';
import {fetchReference,referenceNetworkSettings,validReferenceUrl} from '../src/src/features/reference-network.js';
const officialHosts=new Set(['wutheringwaves.kurogames.com','act-upload.hoyoverse.com','act-webstatic.hoyoverse.com','upload-static.hoyoverse.com']);
export const inlineReferenceUrlAllowed=url=>validReferenceUrl(url,'reference')&&(['wikipedia','moegirl','baidu'].some(s=>validReferenceUrl(url,s))||officialHosts.has(new URL(url).hostname));
export async function inlineReference(url,{config=loadAiConfig(),fetch=fetchReference,now=Date.now}={}){
 const settings=referenceNetworkSettings(config);
 const source=['wikipedia','moegirl','baidu'].find(s=>validReferenceUrl(url,s))??'reference';
 if(!inlineReferenceUrlAllowed(url))throw Error('reference_url_rejected');
 const result=await fetch({source,args:[url],settings,deadline:now()+settings.downloadBudgetMs,
  allowUrl:inlineReferenceUrlAllowed,onEvent:e=>console.error(`reference_transport=${JSON.stringify(e)}`)});
 if(!result.ok)throw Error(result.reason);
 const bytes=result.body;
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>settings.maxResponseBytes)throw Error('reference_image_unavailable');
 let metadata;try{metadata=await sharp(bytes,{limitInputPixels:40000000}).metadata();}catch{throw Error('reference_image_unavailable');}
 const mime={png:'image/png',jpeg:'image/jpeg',webp:'image/webp'}[metadata.format];
 if(!mime||!metadata.width||!metadata.height||metadata.width*metadata.height>40000000)throw Error('reference_image_unavailable');
 return `data:${mime};base64,${bytes.toString('base64')}`;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{process.stdout.write(await inlineReference(process.argv[2]));}
 catch(e){const allowed=['reference_url_rejected','reference_timeout','reference_image_unavailable','search_network_error','challenge_required'];console.error('reference_reason='+ (allowed.includes(e.message)?e.message:'reference_image_unavailable'));process.exitCode=1;}
}
