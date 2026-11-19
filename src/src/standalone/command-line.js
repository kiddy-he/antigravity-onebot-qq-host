import {fileURLToPath} from 'node:url';
const entry=fileURLToPath(new URL('../../../scripts/standalone-onebot.mjs',import.meta.url));
export function hostCommand(args){
    return process.env.ONEBOT_STANDALONE==='1'?{file:process.execPath,argv:[entry,...args]}:{file:'/usr/local/bin/openclaw',argv:args};
}
