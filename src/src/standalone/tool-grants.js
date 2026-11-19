const groups={exec:['group:runtime'],process:['group:runtime'],read:['group:fs'],edit:['group:fs'],web_fetch:['group:web','group:openclaw'],session_status:['group:sessions','group:openclaw']};
function matches(name,patterns){
    const aliases=[name,...(groups[name]??[])];
    for(const pattern of patterns??[]){
        if(typeof pattern!=='string')continue;
        const parts=pattern.trim().toLowerCase().split('*');
        if(parts.length===1){if(aliases.includes(parts[0]))return true;continue;}
        // Anchored * glob, matching the host's allow/deny patterns.
        const expression=parts.map(part=>RegExp.escape(part)).join('.*');
        if(aliases.some(alias=>new RegExp('^'+expression+'$','u').test(alias)))return true;
    }
    return false;
}

export function toolAllowed(name,policy={},turnAllow){
    return !matches(name,policy.deny) && (!policy.allow?.length || matches(name,policy.allow) || matches(name,policy.alsoAllow)) &&
        (!turnAllow || matches(name,turnAllow));
}

