import {transcriptRuntime} from './standalone/transcript-runtime.js';
import { captureMediaTranscriptTarget } from './media-transcript.js';
import { contentText, evidenceReference } from './conversation-projection.js';

/** Scope and database come exclusively from the trusted active session, never tool arguments. */
export async function readConversationEvidence({ sessionKey, agentId, reference, offset = 0, limit = 4000 }, {
    capture = captureMediaTranscriptTarget,
    read = async target => (await transcriptRuntime()).readVisibleSessionTranscriptMessageEntries(target),
} = {}) {
    if (!/^[a-f0-9]{64}$/u.test(reference ?? '') || !Number.isInteger(offset) || offset < 0
        || !Number.isInteger(limit) || limit < 1 || limit > 12000) throw new Error('invalid evidence range');
    const target = capture({sessionKey,agentId});
    if (!target) throw new Error('current conversation unavailable');
    {
        const entries=await read(target);
        let found;
        for (const entry of entries.toReversed()) {
            const message=entry.message;
            if (message?.role!=='toolResult' || !['read','exec','process'].includes(message.toolName) || !message.toolCallId) continue;
            if (evidenceReference(target.sessionId,message.toolCallId) === reference) { found=message;break; }
        }
        if (!found || capture({sessionKey,agentId})?.sessionId !== target.sessionId) throw new Error('evidence not found in current conversation');
        const text=contentText(found.content);
        return {status:'succeeded',reference,tool:found.toolName,historical:true,untrusted:true,
            isOriginalError:found.isError===true,totalChars:text.length,offset,
            nextOffset:offset+limit<text.length?offset+limit:null,text:text.slice(offset,offset+limit)};
    }
}
