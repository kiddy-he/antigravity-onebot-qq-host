let runtime=null;
export function setOneBotRuntime(value){runtime=value;}
export function clearOneBotRuntime(){runtime=null;}
export function tryGetOneBotRuntime(){return runtime;}
export function getOneBotRuntime(){
    if(!runtime)throw new Error('OneBot runtime not initialized');
    return runtime;
}
