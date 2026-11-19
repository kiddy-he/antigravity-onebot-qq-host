import {createConfiguredAiFetch} from '../src/src/ai/fetch.js';
import {createTrustedGeminiFetch} from '../src/src/gemini-trusted-transport.js';
const installed=Symbol.for('openclaw.configuredAiTransport');
if(!globalThis[installed]){
 globalThis.fetch=createTrustedGeminiFetch(createConfiguredAiFetch(globalThis.fetch));
 globalThis[installed]=true;
}
