/** Normalize inline Images results without trusting provider metadata or fetching URLs. */
import sharp from 'sharp';
import {AiError} from './router.js';
function inlineBase64(value){
 if(!value.startsWith('data:'))return value;
 const match=/^data:image\/[a-z0-9.+-]+;base64,([\s\S]+)$/iu.exec(value);
 if(!match)throw new AiError('incomplete_output');
 return match[1];
}
export async function normalizeImageOutput(value){
 const data=structuredClone(value),images=[];
 if(!Array.isArray(data?.data)||!data.data.length)throw new AiError('incomplete_output');
 for(const item of data.data){
  if(!item||typeof item!=='object')throw new AiError('incomplete_output');
  const inlineUrl=typeof item.url==='string'&&item.url.startsWith('data:');
  const raw=typeof item.b64_json==='string'&&item.b64_json.trim()?item.b64_json:inlineUrl?item.url:null;
  if(raw){
   const source=raw.startsWith('data:')?'data-uri':'b64_json',b64=inlineBase64(raw).replace(/\s/gu,'');
   if(!/^[a-zA-Z0-9+/]+={0,2}$/u.test(b64)||b64.length%4===1)throw new AiError('incomplete_output');
   const bytes=Buffer.from(b64,'base64');
   if(!bytes.length||bytes.toString('base64').replace(/=+$/u,'')!==b64.replace(/=+$/u,''))throw new AiError('incomplete_output');
   let meta;try{meta=await sharp(bytes).metadata();}catch{throw new AiError('incomplete_output');}
   if(!meta.width||!meta.height||!['png','jpeg','webp','gif','avif','heif','tiff'].includes(meta.format))throw new AiError('incomplete_output');
   item.b64_json=b64;if(inlineUrl)delete item.url;
   const size=meta.width+'x'+meta.height;
   images.push({source,width:meta.width,height:meta.height,format:meta.format,bytes:bytes.length,reportedSizeMatchesImage:data.size===undefined?undefined:data.size===size});
  }else if(typeof item.url==='string'&&item.url.trim()){
   const url=new URL(item.url);if(!['https:','http:'].includes(url.protocol))throw new AiError('incomplete_output');
   images.push({source:'remote-url'});
  }else throw new AiError('incomplete_output');
 }
 return {data,images};
}
