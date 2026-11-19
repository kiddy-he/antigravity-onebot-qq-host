/** Public catalogue constraints. LLM owns intent; this module only validates identifiers. */
const unsafe=/[\u0000-\u001f\u007f<>]|\[CQ:|MEDIA:|\/(?:root|etc|tmp)\/|(?:sk|rk)-[A-Za-z0-9_-]{12,}/iu;
const text=(value,max=80)=>typeof value==='string'&&value.trim()&&value.length<=max&&!unsafe.test(value);
export function normalizeMarketCatalogue(raw){
    if(raw?.version!==1||!Array.isArray(raw.stocks)||!raw.stocks.length||raw.stocks.length>5000)throw new Error('market_catalogue_unavailable');
    const codes=new Set(),shorts=new Set();
    const stocks=raw.stocks.map(stock=>{
        if(!stock||!/^\d{6}$/u.test(stock.code)||codes.has(stock.code)||!text(stock.name)||!text(stock.sector,40)||!text(stock.industry,40)
            ||typeof stock.short_code!=='string'||(stock.short_code&&!/^[A-Z0-9]{2,12}$/u.test(stock.short_code))||stock.short_code&&shorts.has(stock.short_code))throw new Error('market_catalogue_invalid');
        codes.add(stock.code);if(stock.short_code)shorts.add(stock.short_code);
        return Object.fromEntries(['code','short_code','name','sector','industry'].map(key=>[key,stock[key]]));
    });
    return {version:1,stocks,sectors:[...new Set(stocks.map(s=>s.sector))].sort(),industries:[...new Set(stocks.map(s=>s.industry))].sort()};
}
export function cataloguePrompt(catalogue){
    if(!catalogue)return undefined;
    const c=normalizeMarketCatalogue(catalogue);
    return {sectors:c.sectors,industries:c.industries,columns:['code','short_code','name','sector','industry'],stocks:c.stocks.map(s=>[s.code,s.short_code,s.name,s.sector,s.industry])};
}
const lower=value=>String(value).trim().toLowerCase();
function matches(value,values){const v=lower(value);const exact=values.filter(x=>lower(x)===v);return exact.length?exact:values.filter(x=>v&&lower(x).includes(v));}
function stockMatches(value,stocks){const v=lower(value);const exact=stocks.filter(s=>[s.code,s.short_code,s.name].some(x=>x&&lower(x)===v));return exact.length?exact:stocks.filter(s=>v&&lower(s.name).includes(v));}
function clarification(kind,value,choices,c){
    const label=(text(value)?String(value):'该名称').replace(/[「」“”\r\n]/gu,' ').slice(0,80);
    const summary=choices.length?`${kind}“${label}”对应多个范围，请确认：${choices.slice(0,5).join('、')}。`:
        `当前市场未收录${kind}“${label}”。请确认名称，或选择已有板块：${c.sectors.slice(0,10).join('、')}；也可用 /fx 搜索 关键词 查找股票。`;
    return {decision:'clarify',question:summary.slice(0,240)};
}
export const INFERABLE_MARKET_READS=new Set(['overview','news','stock','book','chart','sector','analyze']);
export function parseReadResolution(value,tool,params){
    if(value===undefined)return undefined;
    if(tool!=='sharemarket_query'||!INFERABLE_MARKET_READS.has(params.action)||!value||typeof value!=='object'||Array.isArray(value)
        ||Object.keys(value).some(key=>!['requested','candidates'].includes(key))||!text(value.requested)||!Array.isArray(value.candidates)
        ||!value.candidates.length||value.candidates.length>8||new Set(value.candidates).size!==value.candidates.length
        ||value.candidates.some(code=>typeof code!=='string'||!/^\d{6}$/u.test(code)))throw new Error('invalid market read resolution');
    return {requested:value.requested,candidates:[...value.candidates]};
}
export function marketReadPresentation(plan,catalogue,body){
    if(!plan.resolution||!catalogue)return undefined;
    const resolution=parseReadResolution(plan.resolution,plan.tool,plan.params),c=normalizeMarketCatalogue(catalogue);
    if(!body.includes(resolution.requested))throw new Error('market read resolution input mismatch');
    const candidates=resolution.candidates.map(code=>c.stocks.find(stock=>stock.code===code));
    if(candidates.some(stock=>!stock))throw new Error('market read resolution candidate unavailable');
    return {requested:resolution.requested,candidates:candidates.map(({code,name})=>({code,name}))};
}
export function marketReadHint(presentation,scope){
    if(!presentation||!text(presentation.requested)||!Array.isArray(presentation.candidates)||!presentation.candidates.length||presentation.candidates.length>8)return '';
    if(presentation.candidates.some(stock=>!/^\d{6}$/u.test(stock?.code)||!text(stock?.name)))return '';
    const original=presentation.requested.replace(/[「」“”]/gu,'');
    return `智能匹配：根据“${original}”选择相关股票${scope?'；本次查询范围为'+scope:''}。候选股票：${presentation.candidates.map(stock=>`${stock.name}(${stock.code})`).join('、')}。这是相关性推断，不表示原名称已被收录。`;
}
export function guardMarketCatalogue(plan,catalogue,{body}={}){
    if(plan.decision!=='execute'||!catalogue)return plan;
    const c=normalizeMarketCatalogue(catalogue),p=plan.params,filters=[];
    if(plan.resolution){
        parseReadResolution(plan.resolution,plan.tool,p);
        if(body!==undefined&&!body.includes(plan.resolution.requested))throw new Error('market read resolution input mismatch');
        if(plan.resolution.candidates.some(code=>!c.stocks.some(stock=>stock.code===code)))throw new Error('market read resolution candidate unavailable');
    }
    if(p.code!==undefined){
        const found=stockMatches(p.code,c.stocks);
        if(found.length!==1)return clarification('股票',p.code,found.map(s=>`${s.name}(${s.code})`),c);
        if(plan.resolution&&!plan.resolution.candidates.includes(found[0].code))throw new Error('selected market stock missing from candidates');
        filters.push(s=>s.code===found[0].code);
    }
    if(plan.tool==='sharemarket_query'){
        for(const [key,label,values] of [['sector','板块',c.sectors],['industry','行业',c.industries]])if(p[key]!==undefined){
            const found=matches(p[key],values);if(found.length!==1)return clarification(label,p[key],found,c);
            filters.push(s=>s[key]===found[0]);
        }
        if(p.keyword!==undefined&&['overview','news','sector','analyze'].includes(p.action)){
            const v=lower(p.keyword),exact=[],partial=[];
            for(const [key,values] of [['sector',c.sectors],['industry',c.industries]])for(const value of values){
                const item={key,value,label:value+(key==='sector'?'板块':'行业')};
                if(lower(value)===v)exact.push(item);else if(v&&lower(value).includes(v))partial.push(item);
            }
            for(const stock of c.stocks){
                const item={key:'code',value:stock.code,label:`${stock.name}(${stock.code})`};
                if([stock.code,stock.short_code,stock.name].some(x=>x&&lower(x)===v))exact.push(item);
                else if(v&&lower(stock.name).includes(v))partial.push(item);
            }
            let found=exact.length?exact:partial;
            if(p.action==='sector')found=found.filter(x=>x.key==='sector');
            if(found.length!==1)return clarification('查询范围',p.keyword,found.map(x=>x.label),c);
            filters.push(s=>s[found[0].key]===found[0].value);
        }
        if(['overview','news','analyze'].includes(p.action)&&filters.length&&!c.stocks.some(s=>filters.every(fn=>fn(s))))
            return {decision:'clarify',question:'指定的板块、行业或股票没有共同匹配项，请确认筛选条件；本次未改成全市场查询。'};
    }
    return plan;
}
const publicCodes=new Set(['market_scope_not_found','market_scope_ambiguous','market_scope_conflict']);
export function publicMarketFailure(market){
    const error=market?.public_error;
    if(!publicCodes.has(error?.code)||!text(error.message,400))return null;
    // Only typed, bounded public errors are eligible; raw socket/provider errors stay local.
    const safe=error.message.replace(/[「」]/gu,'');
    return `本次股市查询未完成，具体原因：「${safe}」请确认查询范围后重新发送 /fx 指令。`;
}
