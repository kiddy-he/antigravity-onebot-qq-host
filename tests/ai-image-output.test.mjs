import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeImageOutput} from '../src/src/ai/image-output.js';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrZkAAAAASUVORK5CYII=';
for(const [name,item]of[['url',{url:'data:image/png;base64,'+png}],['prefixed-base64',{b64_json:'data:image/png;base64,'+png}],['bare-base64',{b64_json:png}]])test(name+' produces plain Base64 and decoded dimensions without trusting metadata',async()=>{
 const value={data:[item],size:'300x200',quality:'medium'},out=await normalizeImageOutput(value);
 assert.equal(out.data.data[0].b64_json,png);assert.equal(out.images[0].width,1);assert.equal(out.images[0].height,1);assert.equal(out.images[0].reportedSizeMatchesImage,false);
 assert.equal(out.data.quality,'medium');assert.deepEqual(value.data[0],item);assert.ok(!out.data.data[0].url);
});
test('valid Base64 wins over an invalid redundant data URI',async()=>{const out=await normalizeImageOutput({data:[{b64_json:png,url:'data:image/png;base64,INVALID'}]});assert.equal(out.data.data[0].b64_json,png);assert.ok(!out.data.data[0].url);});
test('remote URLs stay compatible and are never fetched by normalization',async()=>{const out=await normalizeImageOutput({data:[{url:'https://example.invalid/image.png'}]});assert.deepEqual(out.images,[{source:'remote-url'}]);assert.equal(out.data.data[0].url,'https://example.invalid/image.png');});
test('incomplete Base64, non-images and unsupported inline schemes cannot count as successful final images',async()=>{
 for(const item of [{url:'data:text/html;base64,SGVsbG8='},{url:'data:image/png;base64,!!!!'},{b64_json:'dGVzdA=='},{b64_json:png.slice(0,12)},{url:'file:///tmp/private'}])await assert.rejects(normalizeImageOutput({data:[item]}),e=>e.kind==='incomplete_output');
});
