import type {AnswerSource,BackendAnswer} from '../types.js';
import {splitOutput} from '../core/split.js';

interface Reference {number:number;title:string;url:string}
interface AnswerPart {type:'slack_answer';body:string;references:Reference[]}
const escape=(text:string)=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
function sourceUrl(value:string):string|undefined {
  if(value.length>500||/[\s<>|\u0000-\u001f]/.test(value))return;
  try{const u=new URL(value);if(!['https:','http:'].includes(u.protocol)||!u.hostname||u.username||u.password)return;return u.href;}catch{return;}
}
function label(title:string):string {
  return Array.from(title.replace(/[<>|`*_~\r\n\u0000-\u001f]/g,' ').replace(/\s+/g,' ').trim()).slice(0,60).join('')||'출처';
}
function context(references:Reference[]):string {
  return references.map(r=>`<${escape(r.url)}|[${r.number}] ${escape(r.title)}>`).join(' · ');
}

/** Process citation markup in prose only; code and unrelated HTML/entities/URLs are literal. */
function proseOnly(text:string,transform:(prose:string)=>string):string {
  let at=0,result='';const runs=/`+|~{3,}/g;
  while(at<text.length){
    runs.lastIndex=at;const run=runs.exec(text);
    if(!run){result+=transform(text.slice(at));break;}
    result+=transform(text.slice(at,run.index));
    const end=text.indexOf(run[0],run.index+run[0].length);
    // Conservatively keep an unclosed code span/fence unchanged through EOF.
    if(end<0){result+=text.slice(run.index);break;}
    const after=end+run[0].length;result+=text.slice(run.index,after);at=after;
  }
  return result;
}

export function formatSlackAnswer(answer:BackendAnswer,elapsed:string):string[] {
  const sources=new Map<string,AnswerSource>();const ambiguous=new Set<string>();
  for(const source of answer.sources??[]){
    if(!source.id||!/^[-A-Za-z0-9_]{1,128}$/.test(source.id))continue;
    const url=sourceUrl(source.url);if(!url){ambiguous.add(source.id);continue;}
    if(sources.has(source.id)&&sources.get(source.id)!.url!==url)ambiguous.add(source.id);
    sources.set(source.id,{...source,url});
  }
  const references:Reference[]=[],byUrl=new Map<string,number>(),stack:string[][]=[];
  const cite=(ids:string[])=>{
    const numbers:number[]=[];
    for(const id of ids){
      if(ambiguous.has(id))continue;
      const source=sources.get(id);if(!source)continue;
      let number=byUrl.get(source.url);
      if(number===undefined){
        if(references.length>=5)continue;
        const ref={number:references.length+1,title:label(source.title),url:source.url};
        if(context([...references,ref]).length>1900)continue;
        references.push(ref);number=ref.number;byUrl.set(source.url,number);
      }
      if(!numbers.includes(number))numbers.push(number);
    }
    return numbers.length?'['+numbers.join(', ')+']':'';
  };
  const body=proseOnly(answer.sourceText??answer.text,prose=>prose.replace(/(?:<|&lt;|&amp;lt;)(\/?)citation(?=[\s>]|&(?:amp;)?gt;)([^<>\r\n]{0,1024}?)(?:>|&gt;|&amp;gt;)/g,(_tag,closing:string,attributes:string)=>{
    if(closing)return cite(stack.pop()??[]);
    const decoded=attributes.replaceAll('&amp;quot;','"').replaceAll('&quot;','"').replaceAll('&#34;','"').replaceAll('&amp;apos;',"'").replaceAll('&apos;',"'").replaceAll('&#39;',"'");
    const refs=/\brefs\s*=\s*["']([^"']*)["']/.exec(decoded)?.[1]??'';
    stack.push(refs.split(/[,\s]+/).flatMap(ref=>{const id=/^([-A-Za-z0-9_]{1,128})(?:#\d+)?$/.exec(ref)?.[1];return id?[id]:[];}));
    return '';
  }));
  const parts=splitOutput(`(${elapsed} 경과)\n\n${body||'(답변 내용이 없습니다.)'}`);
  // Persist the rendered parts, so delivery after restart never reconstructs citations differently.
  return parts.map((body,i)=>JSON.stringify({type:'slack_answer',body,references:i===parts.length-1?references:[]} satisfies AnswerPart));
}

/** Called only for a completed answer part identified in the durable outbox. */
export function slackAnswerPart(content:string):{body:string;context?:string}|undefined {
  let value:unknown;try{value=JSON.parse(content);}catch{return;}
  if(!value||typeof value!=='object'||(value as AnswerPart).type!=='slack_answer')return;
  const part=value as AnswerPart;
  if(typeof part.body!=='string'||!part.body||part.body.length>1900||!Array.isArray(part.references)||part.references.length>5)throw new Error('invalid_slack_answer_part');
  for(const ref of part.references)if(!ref||!Number.isInteger(ref.number)||ref.number<1||ref.number>5||typeof ref.title!=='string'||ref.title!==label(ref.title)||typeof ref.url!=='string'||!sourceUrl(ref.url))throw new Error('invalid_slack_reference');
  const links=context(part.references);if(links.length>1900)throw new Error('invalid_slack_reference_length');
  return {body:part.body,...(links?{context:links}:{})};
}
