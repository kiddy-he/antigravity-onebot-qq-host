import {closeSync,openSync,mkdirSync,existsSync,writeFileSync,unlinkSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AiError} from './router.js';

export const guestWorkdir='/work';
const guestProfile='/home/onebot/.gemini/antigravity-cli';

export function isolatedCommand(args,{cwd,executable,mcp}) {
    const native=executable??process.env.ONEBOT_AGY_BIN??join(homedir(),'.local/bin/agy');
    const credential=join(process.env.ONEBOT_AGY_PROFILE_DIR??join(homedir(),'.gemini','antigravity-cli'),'antigravity-oauth-token');
    if(!existsSync(credential))throw new AiError('authentication_error','Personal CLI login missing');
    if(!existsSync(native))throw new AiError('configuration_error','Native CLI executable missing');
    // A new mount namespace has an empty workspace. Only this conversation's
    // own native history persists; the host workspace and other QQ histories
    // are never mounted. Token rotation remains owned by the official CLI.
    const state=join(cwd,'.agy-profile');
    mkdirSync(state,{recursive:true,mode:0o700});
    const policy=args.includes('--settings')?args[args.indexOf('--settings')+1]:
        JSON.stringify({useG1Credits:false,toolPermission:'strict',allowNonWorkspaceAccess:false});
    const file=join(cwd,'.agy-settings-'+randomUUID());
    writeFileSync(file,policy,{flag:'wx',mode:0o600});
    let fd;
    try { fd=openSync(file,'r'); } finally { unlinkSync(file); }
    const bwrap=['--die-with-parent','--unshare-pid','--unshare-ipc','--unshare-uts','--cap-drop','ALL',
        '--ro-bind','/usr','/usr','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64','--symlink','usr/bin','/bin',
        '--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/etc','--ro-bind','/etc/ssl','/etc/ssl',
        '--ro-bind','/etc/resolv.conf','/etc/resolv.conf','--ro-bind','/etc/hosts','/etc/hosts',
        '--dir','/app','--ro-bind',native,'/app/agy','--dir','/home/onebot/.gemini',
        '--bind',state,guestProfile,'--ro-bind',credential,guestProfile+'/antigravity-oauth-token',
        '--ro-bind-data','3',guestProfile+'/settings.json','--dir',guestWorkdir,
        '--setenv','HOME','/home/onebot','--setenv','PATH','/app:/usr/bin:/bin','--chdir',guestWorkdir];
    if(mcp) bwrap.push('--ro-bind',process.execPath,'/app/node','--ro-bind',mcp.script,'/app/onebot-mcp.mjs',
        '--ro-bind',mcp.socket,'/run/onebot-mcp.socket');
    return {file:'/usr/bin/bwrap',args:[...bwrap,'/app/agy',...args],fd,close:()=>closeSync(fd)};
}
