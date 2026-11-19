/** Private executor progress, independent of model text and curl output. */
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const phases = new Set(['setup','reference_resolution','reference_download','prompt_planning','generation_request','quality_review']);
export function parseImageProgress(text) {
    let phase = null, generationStarted = false;
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { return null; }
        if (!phases.has(event.phase) || Object.keys(event).some(key => key !== 'phase')) return null;
        phase = event.phase;
        if (phase === 'generation_request') generationStarted = true;
    }
    return phase ? {phase, generationStarted} : null;
}
export async function runImageWorkflow(command, options, run, saveProbe) {
    const directory = await mkdtemp(join(tmpdir(), 'onebot-image-workflow-'));
    const progressFile = join(directory, 'progress.jsonl');
    const progress = async () => {
        try {
            const text = await readFile(progressFile, 'utf8');
            return text.length <= 65536 ? parseImageProgress(text) : null;
        } catch { return null; }
    };
    try {
        const output = await run(command.file, command.argv, {...options,
            env: {...options.env, AGY_IMAGE_PROGRESS_FILE: progressFile, ...(saveProbe?{ONEBOT_IMAGE_PROBE_DIR:directory}:{})}});
        if(saveProbe){
            const probe=join(directory,'agy-proxy-image-probe.jpg');
            const lines=output.stdout.split(/\r?\n/u);
            if(!lines.includes('image_output='+probe) || !lines.some(line=>/^image_probe_http=2\d\d$/u.test(line)))
                throw Error('出图探针未返回本次请求的图片');
            const safe=lines.filter(line=>/^(?:image_probe_http=\d{3}|image_model=[A-Za-z0-9_./-]{1,160}|image_count=\d{1,5}|image_bytes=\d{1,10}|b64_present=(?:true|false)|warning=probe_consumes_image_quota)$/u.test(line));
            safe.push('image_output='+await saveProbe(probe));
            return {...output,stdout:safe.join('\n'),imageWorkflow:await progress()};
        }
        return {...output, imageWorkflow: await progress()};
    } catch (error) {
        error.imageWorkflow = await progress();
        throw error;
    } finally { await rm(directory, {recursive: true, force: true}); }
}
export function imageFailedBeforeGeneration(error) {
    const progress = error.imageWorkflow;
    return progress?.generationStarted === false
        && ['setup','reference_resolution','reference_download','prompt_planning'].includes(progress.phase);
}

// Bounded enum extraction only. Tool stdout is never a trusted progress channel.
const referenceReasons = ['ambiguous','selector_unavailable','reference_timeout','challenge_required','reference_url_rejected','reference_network_configuration','search_network_error','search_invalid_response','reference_image_unavailable','no_match','no_candidates'];
export function imageFailureDiagnostic(output = '', phase = 'reference_resolution') {
    // Earlier sources can fail before a later source succeeds. Never attribute
    // their no_match to a subsequent download, planning or generation failure.
    if (phase !== 'reference_resolution') return undefined;
    const seen = new Set([...String(output).slice(-65536).matchAll(/^reference_reason=([a-z_]+)\r?$/gmu)].map(m => m[1]));
    const reason = referenceReasons.find(reason => seen.has(reason));
    return reason ? {reason} : undefined;
}
export function imagePreparationFailureText(result) {
    if (result?.workflow?.generationStarted !== false || result?.failureStage !== result?.workflow?.phase) return null;
    const stage = result.failureStage;
    const reasons = {
        reference_timeout: '参考图检索已达到等待上限，仍未取得可用图片。稍后可以重试，或直接提供参考图。',
        challenge_required: '参考图来源要求人工安全验证，未能继续取得图片。可以换用参考来源，或直接提供参考图。',
        reference_url_rejected: '参考图返回了不符合来源要求的地址，已停止使用该地址。可以直接提供参考图。',
        reference_network_configuration: '参考图网络配置暂时不可用，未能完成检索。',
        ambiguous: '检索到了多个可能的角色，暂时无法确定你指的是哪一位。请补充作品名、角色全名或参考图。',
        no_match: '没有从检索结果中确认到匹配的角色参考图。可以补充作品名、角色全名或直接提供参考图。',
        no_candidates: '角色检索没有返回可用候选。可以补充作品名、角色全名或直接提供参考图。',
        selector_unavailable: '角色身份核对服务暂时未能完成，无法可靠选择参考图。稍后可以重试，或直接提供参考图。',
        search_network_error: '参考图检索遇到了网络故障，未能取得可核对的结果。稍后可以重试，或直接提供参考图。',
        search_invalid_response: '参考图检索返回的数据无法解析，未能完成角色核对。稍后可以重试，或直接提供参考图。',
        reference_image_unavailable: '已找到角色页面，但没有取得符合要求的参考图片。可以直接提供角色参考图。',
    };
    const stages = {
        setup: '图片生成的初始化步骤失败。',
        reference_resolution: reasons[result.diagnostic?.reason] ?? '角色参考图的查找或身份核对未能完成。可以补充作品名、角色全名或直接提供参考图。',
        reference_download: '参考图下载或读取失败。可以换一张可访问的参考图后重试。',
        prompt_planning: '图片提示词的准备步骤失败，未能进入生成阶段。稍后可以重试。',
    };
    return stages[stage] ? `${stages[stage]}这次尚未提交生图请求，也没有生成或发送图片。` : null;
}
