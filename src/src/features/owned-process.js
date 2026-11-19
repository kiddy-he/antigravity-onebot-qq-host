import {onebotPath as publicPath} from '../paths.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {inspectLocal,inspectionPlan} from './owner-inspection.js';

const execute = promisify(execFile);
const approvedJobs = new Map();

// The reviewer and an eventual quoted confirmation run independently of the
// tool call that first returned the owner handle (possibly in another process).
export async function runApprovedOwnerProcess(input,executeBusiness) {
    const {store,sessionKey,operationId}=input;
    const handle=store.db.prepare('SELECT timeout_ms FROM admin_processes WHERE operation_id=?').get(operationId);
    if(!handle)return executeBusiness(input);
    const previous=approvedJobs.get(operationId);
    if(previous)return previous.done;
    const controller=new AbortController(),deadline=handle.timeout_ms?AbortSignal.timeout(handle.timeout_ms):undefined;
    const signal=AbortSignal.any([controller.signal,input.signal,deadline].filter(Boolean));
    const job={sessionKey,controller};
    approvedJobs.set(operationId,job);
    try{
        store.db.prepare("UPDATE admin_processes SET phase='approved' WHERE operation_id=?").run(operationId);
        job.done=executeBusiness({...input,run:input.run??runOwnedBusinessFile,signal});
        return await job.done;
    }finally{
        store.db.prepare("UPDATE admin_processes SET phase='settled' WHERE operation_id=? AND phase='approved'").run(operationId);
        approvedJobs.delete(operationId);
    }
}

export function cancelApprovedOwnerProcesses(sessionKey){
    const jobs=[...approvedJobs.values()].filter(job=>sessionKey===undefined||job.sessionKey===sessionKey);
    for(const job of jobs)job.controller.abort();
    return jobs;
}

// The registered business catalog supplies file and argv after the ordinary tool
// grant and approval checks. The PID namespace also contains detached workers.
export function runOwnedBusinessFile(file, argv, options) {
    if(file===process.execPath && argv.length===2 &&
        argv[0]===publicPath("onebot-onebot-custom/scripts/owner-inspect.mjs")){
        const query=argv[1],{kind}=inspectionPlan(query);
        // ps must see the host process table, and systemctl must see the
        // manager's PID namespace. These probes each launch one fixed executable.
        if(['processes','memory','listeners','nginxStatus'].includes(kind)){
            const probe=(binary,args,opts)=>execute(binary,args,{...opts,signal:options.signal,
                timeout:Math.min(opts.timeout,options.timeout??opts.timeout),killSignal:'SIGKILL'});
            return inspectLocal(query,probe).then(stdout=>({stdout:stdout+'\n',stderr:''}));
        }
    }
    const args = ['--die-with-parent', '--unshare-pid', '--bind', '/', '/', '--dev-bind', '/dev', '/dev',
        '--proc','/proc','--',file,...argv];
    return execute('/usr/bin/bwrap', args, {...options, shell: false, killSignal: 'SIGKILL'});
}
