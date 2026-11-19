import {standaloneTranscript} from './transcript.js';

export function transcriptRuntime(){
    if(process.env.ONEBOT_STANDALONE!=='1')return import('openclaw/plugin-sdk/session-transcript-runtime');
    const store=standaloneTranscript();
    return {
        readVisibleSessionTranscriptMessageEntries:t=>store.entries(t),
        appendSessionTranscriptMessageByIdentityStrict:p=>store.append(p),
        publishSessionTranscriptUpdateByIdentity:()=>{},
        appendAssistantMirrorMessageByIdentity:p=>({ok:store.append({...p,message:{role:'assistant',timestamp:Date.now(),
            content:[{type:'text',text:p.text}],idempotencyKey:p.idempotencyKey,onebotConversation:{kind:'delivered'}}}).kind==='result'}),
    };
}
