import {exportOwnerEdit} from '../src/src/standalone/owner-edit.js';
try{
    if(process.argv.length!==3)throw Error('请提供机主修改草案编号');
    process.stdout.write(await exportOwnerEdit(process.argv[2]));
}catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
