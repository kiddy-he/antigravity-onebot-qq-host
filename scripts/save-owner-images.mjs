import {saveOwnerImages} from '../src/src/features/owner-attachments.js';
try{
    if(process.argv.length!==4)throw Error('invalid arguments');
    const result=await saveOwnerImages(process.argv[2],JSON.parse(process.argv[3]));
    console.log(JSON.stringify(result));
}catch{console.error('本轮图片未能全部保存，请核对原操作记录。');process.exitCode=1;}
