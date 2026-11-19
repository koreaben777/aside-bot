import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/core/engine.js';
import {Store} from '../src/store.js';
import {createSlackOutbound,type SlackApi} from '../src/slack/bot.js';
import type {Backend} from '../src/types.js';

const config={ownerUserId:'U12345678',guildId:'T12345678',channelId:'D12345678'};
const threadId=config.channelId+':1700000000.000001';
type Source={id?:string;title:string;url:string};
const until=async(check:()=>boolean)=>{for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,2));}assert.fail('timed out');};
type Block={type:string;text?:string|{type:string;text:string};elements?:Array<{type:string;text:string}>};
const blockBody=(block:Block)=>typeof block.text==='string'?block.text:block.text?.text??'';
async function present(sourceText:string,sources:Source[]=[],legacyText?:string){
 const store=new Store(':memory:');store.bindThread({threadId,guildId:config.guildId,parentChannelId:config.channelId,ownerUserId:config.ownerUserId},'origin');
 const posts:Array<Record<string,unknown>>=[];
 const api:SlackApi=async(method,body={})=>{if(method==='chat.postMessage')posts.push(body);return {ok:true,ts:'1700000001.000001'};};
 const backend:Backend={health:async()=>{},createSession:async()=> 'session',runTurn:async()=>({text:legacyText??sourceText,sourceText,sources}),stop:async()=>({confirmed:true})};
 const engine=new Engine(config,store,backend,createSlackOutbound(api,config,store));
 try{
  engine.submit({sourceId:'source',userId:config.ownerUserId,guildId:config.guildId,channelId:threadId,content:'question'});
  await until(()=>store.requestBySource('source')?.state==='completed'&&!Reflect.get(engine,'delivering'));
  const blocks=posts.flatMap(p=>p.blocks as Block[]);
  return {posts,body:blocks.filter(b=>b.type==='markdown'||b.type==='section'&&typeof b.text==='object'&&b.text.type==='plain_text').map(blockBody).join(''),contexts:blocks.filter(b=>b.type==='context').flatMap(b=>b.elements!).map(e=>e.text).concat(blocks.filter(b=>b.type==='section'&&typeof b.text==='object'&&b.text.type==='mrkdwn').map(blockBody)),outbox:store.outputParts(store.requestBySource('source')!.id,'answer')};
 }finally{engine.close();store.close();}
}

test('Slack sends model Markdown through its native Markdown block with citations intact',async()=>{
 const raw='62,500 크레딧은 **약 $2,500 상당**, **약 340만 원**이에요.\n\n## 참고\n- *추정*이며 ~~확정 아님~~\n> 환율에 따라 달라집니다.\n[직접 링크](https://example.org/)\n`**literal**`\n```ts\nconst amount = 2500;\n```\n\n| 항목 | 값 |\n| --- | --- |\n| 크레딧 | 62500 |\n\n<citation refs="s">근거</citation>';
 const result=await present(raw,[{id:'s',title:'출처',url:'https://source.example/'}]);
 const first=(result.posts[0]!.blocks as Block[])[0]!;
 assert.equal(first.type,'markdown');
 assert.equal(first.text,'(00분 00초 경과)\n\n'+raw.replace('<citation refs="s">근거</citation>','근거[1]'));
 assert.deepEqual(result.contexts,['<https://source.example/|[1] 출처>']);
 assert.equal(result.posts[0]!.mrkdwn,false);
 assert.equal(result.posts[0]!.unfurl_links,false);
});

test('Slack converts visual HTML comparisons to readable text before splitting and citation rendering',async()=>{
 const visual='<!doctype html><html><head><title>metadata</title><style>body{color:red}</style></head><body><table><tr><th>항목</th><th>Mini</th><th>Fender</th></tr><tr><td>무게</td><td><b>1.5kg</b><br><small>휴대용</small></td><td>4.0kg</td></tr><tr><td>공통점</td><td colspan="2">USB &amp; IR 지원</td></tr></table><p>조건 확인<citation refs="s">공식 자료</citation></p><script>alert("never run")</script></body></html>';
 const result=await present('비교입니다.\n\n```visual\n'+visual+'\n```\n\n끝.\n```html\n<b>코드 예제</b>\n```',[{id:'s',title:'매뉴얼',url:'https://example.org/manual'}]);
 assert.equal(result.body,'(00분 00초 경과)\n\n비교입니다.\n\n**무게**\n- Mini: 1.5kg / 휴대용\n- Fender: 4.0kg\n\n**공통점**\n- Mini / Fender: USB & IR 지원\n\n조건 확인공식 자료[1]\n\n끝.\n```html\n<b>코드 예제</b>\n```');
 assert.deepEqual(result.contexts,['<https://example.org/manual|[1] 매뉴얼>']);
 assert.ok(result.outbox.every(part=>!part.content.includes('```visual')&&!part.content.includes('<style>')));
});

test('Slack splits long visual comparisons without exposing HTML or losing rows',async()=>{
 const rows=Array.from({length:60},(_,i)=>`<tr><td>항목 ${i}</td><td>Mini 값 ${i}</td><td>Fender 값 ${i}</td></tr>`).join('');
 const result=await present('~~~visual\n<table><tr><th>항목</th><th>Mini</th><th>Fender</th></tr>'+rows+'</table>\n~~~');
 assert.ok(result.posts.length>1);
 assert.ok(!/```|~~~|<\/?(?:table|tr|td|th)>/.test(result.body));
 for(let i=0;i<60;i++)assert.ok(result.body.includes(`**항목 ${i}**\n- Mini: Mini 값 ${i}\n- Fender: Fender 값 ${i}`));
 for(const post of result.posts)assert.ok(blockBody((post.blocks as Block[])[0]!).length<=1900);
});

test('Slack preserves visual text, entities and safe link destinations without exposing active markup',async()=>{
 const result=await present('```visual\n<p>전원 &#53;V &amp; 2A&nbsp;필요</p><p><a href="https://example.org/manual?x=1&amp;y=2">매뉴얼</a> · <a href="javascript:alert(1)">위험 링크</a></p><style>hidden css</style><script>hidden script</script>\n```');
 assert.equal(result.body,'(00분 00초 경과)\n\n전원 5V & 2A 필요\n\n매뉴얼 (https://example.org/manual?x=1&y=2) · 위험 링크');
});

test('Slack preserves source IDs inside visual citation attributes',async()=>{
 for(const [open,close] of [['<','>'],['&lt;','&gt;'],['&amp;lt;','&amp;gt;']]){
  const result=await present('```visual\n<p>'+open+'citation refs="source_A"'+close+'공식 자료'+open+'/citation'+close+'</p>\n```',[{id:'source_A',title:'자료',url:'https://example.org/'}]);
  assert.equal(result.body,'(00분 00초 경과)\n\n공식 자료[1]');
  assert.deepEqual(result.contexts,['<https://example.org/|[1] 자료>']);
 }
});

test('Slack converts unfinished visuals but preserves visual fence examples inside ordinary code',async()=>{
 const example='````markdown\n```visual\n<p>코드 안의 예제</p>\n```\n````';
 const result=await present(example+'\n\n```visual\n<p>미완결 시각 자료</p>');
 assert.equal(result.body,'(00분 00초 경과)\n\n'+example+'\n\n미완결 시각 자료');
});

test('Slack displays native mention tokens as code without changing existing code examples',async()=>{
 const result=await present('**설명** <@UOTHER123> <!channel> <#C12345678|general>\n`<@UOTHER123>`\n```xml\n<!here>\n```');
 assert.equal(result.body,'(00분 00초 경과)\n\n**설명** `<@UOTHER123>` `<!channel>` `<#C12345678|general>`\n`<@UOTHER123>`\n```xml\n<!here>\n```');
 assert.ok(!String(result.posts[0]!.text).includes('<@UOTHER123>'));
});

test('Slack separates a trailing citation explanation from a completed sentence',async()=>{
 for(const [open,close] of [['<','>'],['&lt;','&gt;'],['&amp;lt;','&amp;gt;']]){
  const raw=`제 추천은 스마일삼겹 본점이에요. ${open}citation refs="s"${close}주소·가격 확인${open}/citation${close}\n\n가격은 바뀔 수 있어요.`;
  const result=await present(raw,[{id:'s',title:'자료',url:'https://example.org/'}]);
  assert.equal(result.body,'(00분 00초 경과)\n\n제 추천은 스마일삼겹 본점이에요.\n\n근거: 주소·가격 확인 [1]\n\n가격은 바뀔 수 있어요.');
 }
 const unknown=await present('확정은 어렵습니다.<citation refs="missing">추정이며 확인 필요</citation>');
 assert.equal(unknown.body,'(00분 00초 경과)\n\n확정은 어렵습니다.\n\n근거: 추정이며 확인 필요');
});

test('Slack preserves inline, nonterminal, unclosed and code citations when separation is uncertain',async()=>{
 for(const [raw,expected] of [
  ['<citation refs="s">두 장소의 주소</citation>를 비교하세요.','두 장소의 주소[1]를 비교하세요.'],
  ['첫 문장.<citation refs="s">근거</citation> 뒤의 설명도 필요합니다.','첫 문장.근거[1] 뒤의 설명도 필요합니다.'],
  ['본문.<citation refs="s">미완결 근거','본문.미완결 근거'],
  ['본문.<citation refs="s"></citation>','본문.[1]'],
  ['본문. `<citation refs="s">코드</citation>`','본문. `<citation refs="s">코드</citation>`'],
  ['첫 문장.<citation refs="s">이 값</citation>`x`를 비교하세요.','첫 문장.이 값[1]`x`를 비교하세요.'],
 ]){
  const result=await present(raw!,[{id:'s',title:'자료',url:'https://example.org/'}]);
  assert.equal(result.body,'(00분 00초 경과)\n\n'+expected);
 }
});

test('Slack keeps long detached evidence and its references through output splitting',async()=>{
 const evidence='주소·메뉴 가격 및 후기 확인 '.repeat(180);
 const result=await present('추천해요.<citation refs="s">'+evidence+'</citation>',[{id:'s',title:'자료',url:'https://example.org/'}]);
 assert.equal(result.body,'(00분 00초 경과)\n\n추천해요.\n\n근거: '+evidence+' [1]');
 assert.ok(result.posts.length>1);
 assert.equal(result.contexts.length,1);
});

test('Slack preserves citation wording and links only exact cited search sources, once',async()=>{
 const raw='확정은 어렵습니다. <citation refs="sourceA#1,sourceB#2">두 장소의 주소</citation>를 비교하세요. <citation refs="sourceA#1">같은 근거</citation>도 참고하세요.';
 const result=await present(raw,[{id:'sourceA',title:'주소 A',url:'https://a.example/place?a=1&b=2'},{id:'sourceB',title:'주소 B',url:'https://b.example/place'},{id:'unused',title:'Unrelated',url:'https://unused.example/'}],raw+'\n\nSources:\n- Unrelated: https://unused.example/');
 assert.equal(result.body,'(00분 00초 경과)\n\n확정은 어렵습니다. 두 장소의 주소[1, 2]를 비교하세요. 같은 근거[1]도 참고하세요.');
 assert.equal(result.contexts.length,1);
 assert.deepEqual(result.contexts,['<https://a.example/place?a=1&amp;b=2|[1] 주소 A>\n<https://b.example/place|[2] 주소 B>']);
 assert.equal((result.posts[0]!.blocks as Block[])[1]!.type,'divider');
 assert.deepEqual((result.posts[0]!.blocks as Block[])[2],{type:'header',text:{type:'plain_text',text:'출처',emoji:false}});
 const sourcesBlock=(result.posts[0]!.blocks as Array<{text?:{type:string;verbatim?:boolean}}>)[3]!;
 assert.equal(sourcesBlock.text?.type,'mrkdwn');assert.equal(sourcesBlock.text?.verbatim,true);
 assert.match(result.contexts[0]!,/<https:\/\/a\.example\/place\?a=1&amp;b=2\|\[1\] 주소 A>/);
 assert.match(result.contexts[0]!,/<https:\/\/b\.example\/place\|\[2\] 주소 B>/);
 assert.equal(result.contexts[0]!.includes('unused'),false);
 assert.equal(result.posts.some(p=>String(p.text).includes('https://a.example')),false);
});

test('Slack renders native citation markers as verified references instead of leaking internal glyphs',async()=>{
 const raw='가입 조건은 [공식 안내](https://example.org/guide)를 확인하세요. \uE200cite\uE202u6gCzQM4f_c4ERAwsh_J1\uE201';
 const result=await present(raw,[{id:'u6gCzQM4f_c4ERAwsh_J1',title:'공식 안내',url:'https://example.org/guide'}]);
 assert.equal(result.body,'(00분 00초 경과)\n\n가입 조건은 [공식 안내](https://example.org/guide)를 확인하세요. [1]');
 assert.deepEqual(result.contexts,['<https://example.org/guide|[1] 공식 안내>']);
 assert.ok(result.outbox.every(part=>!/[\uE200\uE201\uE202]/.test(part.content)));
});

test('Slack numbers mixed citation formats in reading order and removes unverified native references',async()=>{
 const raw='<citation refs="a">첫 근거</citation> 다음 \uE200cite\uE202b#1\uE202a\uE202missing\uE202unsafe\uE202conflict\uE201 끝 \uE200cite\uE202missing\uE201';
 const result=await present(raw,[{id:'a',title:'A',url:'https://a.example/'},{id:'b',title:'B',url:'https://b.example/'},{id:'unsafe',title:'Unsafe',url:'javascript:alert(1)'},{id:'conflict',title:'C',url:'https://c.example/'},{id:'conflict',title:'D',url:'https://d.example/'}]);
 assert.equal(result.body,'(00분 00초 경과)\n\n첫 근거[1] 다음 [2, 1] 끝 ');
 assert.deepEqual(result.contexts,['<https://a.example/|[1] A>\n<https://b.example/|[2] B>']);
});

test('Slack removes unmapped native citations but preserves normal emoji and literal code examples',async()=>{
 const marker='\uE200cite\uE202unknown_id\uE201';
 const examples='`'+marker+'`\n```text\n'+marker+'\n```';
 const result=await present('안내 🚢 🚶 :ship: :walking: '+marker+'\n'+examples);
 assert.equal(result.body,'(00분 00초 경과)\n\n안내 🚢 🚶 :ship: :walking: \n'+examples);
 assert.deepEqual(result.contexts,[]);
});

test('Slack handles escaped citation tags without decoding unrelated text or altering code and user URLs',async()=>{
 for(const [open,close] of [['<','>'],['&lt;','&gt;'],['&amp;lt;','&amp;gt;']]){
  const code='`<citation refs="literal">literal</citation>`\n```xml\n< citation >\n<citation refs="code">keep code</citation>\n```\n~~~xml\n<citation refs="tilde">keep tilde</citation>\n~~~';
  const raw=`불확실: ${open}citation refs="unknown#1"${close}추정이며 확인 필요${open}/citation${close}\nhttps://user.example/path?q=1&keep=2\nSources:\n직접 작성한 목록\n<citation-example>HTML example</citation-example>\n&lt;div&gt; &amp; ${code}`;
  const result=await present(raw);
  assert.equal(result.body,'(00분 00초 경과)\n\n불확실: 추정이며 확인 필요\nhttps://user.example/path?q=1&keep=2\nSources:\n직접 작성한 목록\n<citation-example>HTML example</citation-example>\n&lt;div&gt; &amp; '+code);
  assert.deepEqual(result.contexts,[]);
 }
});

test('Slack rejects ambiguous or unsafe source mappings and bounds deduplicated citations',async()=>{
 const sources:Source[]=[{id:'ambiguous',title:'A',url:'https://a.example/'},{id:'ambiguous',title:'B',url:'https://b.example/'},{id:'bad',title:'Bad',url:'javascript:alert(1)'},{id:'credentials',title:'Private',url:'https://user:password@example.org/'},{id:'long',title:'Long',url:'https://example.org/'+ 'a'.repeat(1000)},...Array.from({length:8},(_,i)=>({id:'s'+i,title:'Title '+i,url:'https://example.org/'+i})),{id:'alias',title:'Alias',url:'https://example.org/0'}];
 const raw='<citation refs="ambiguous,bad,credentials,long,missing">증거 미확인</citation> '+Array.from({length:8},(_,i)=>`<citation refs="s${i}">근거 ${i}</citation>`).join(' ')+' <citation refs="alias">같은 URL</citation>';
 const result=await present(raw,sources);
 assert.match(result.body,/증거 미확인 근거 0\[1\]/);
 assert.match(result.body,/근거 7 같은 URL\[1\]/);
 assert.equal(result.contexts.join('').match(/<https:/g)?.length,5);
 assert.ok(!result.contexts.join('').includes('password')&&!result.contexts.join('').includes('a.example'));
 assert.ok(result.contexts.join('').length<=1900);
});

test('Slack splits cleaned text without breaking citation tags or code and places compact sources on the last part',async()=>{
 const raw='😀'.repeat(950)+' <citation refs="sourceA#1">긴 답변의 중요한 문구</citation> 끝.\n`https://user.example/keep`';
 const result=await present(raw,[{id:'sourceA',title:'Source <@UOTHER123> & | `code`',url:'https://example.org/path'}]);
 assert.ok(result.posts.length>1);assert.ok(result.body.includes('긴 답변의 중요한 문구[1] 끝.'));
 assert.equal(result.body.includes('citation refs'),false);assert.ok(result.body.includes('`https://user.example/keep`'));
 for(const p of result.posts){const body=blockBody((p.blocks as Block[])[0]!);assert.ok(body.length<=1900);assert.ok(!/[\uD800-\uDBFF]$/.test(body));assert.equal(p.mrkdwn,false);}
 assert.equal(result.posts.slice(0,-1).some(p=>(p.blocks as Array<{type:string}>).some(b=>b.type==='divider')),false);
 assert.equal(result.contexts.length,1);assert.ok(!result.contexts[0]!.includes('<@UOTHER123>'));
});

test('Slack periodic progress is absent while the default transport keeps ten-second updates',async t=>{
 for(const destination of ['dm','channel','default'])await t.test(destination,async c=>{
  const parent=destination==='channel'?'C12345678':config.channelId,thread=parent+':1700000000.000001',store=new Store(':memory:');
  store.bindThread({threadId:thread,guildId:config.guildId,parentChannelId:parent,ownerUserId:config.ownerUserId},'origin');
  const messages:string[]=[];let running=false,release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let now=0;c.mock.method(Date,'now',()=>now);c.mock.timers.enable({apis:['setInterval']});
  const api:SlackApi=async(method,body={})=>{if(method==='conversations.info')return {ok:true,channel:{id:parent,is_channel:true,is_member:true}};if(method==='chat.postMessage')messages.push(String(body.text));return {ok:true,ts:'1700000001.000001'};};
  const outbound=destination==='default'?{send:async(_thread:string,text:string)=>{messages.push(text);return 'msg-'+messages.length;}}:createSlackOutbound(api,config,store,destination==='channel');
  const backend:Backend={health:async()=>{},createSession:async()=> 'session',runTurn:async()=>{running=true;await gate;return {text:'완료'};},stop:async()=>({confirmed:true})};
  const engine=new Engine(config,store,backend,outbound,undefined,undefined,p=>p===parent);
  try{
   engine.submit({sourceId:'source',userId:config.ownerUserId,guildId:config.guildId,channelId:thread,content:'question'},{publishQueueNotice:true});
   await until(()=>running&&!Reflect.get(engine,'delivering'));
   now=10_000;c.mock.timers.tick(10_000);await new Promise<void>(r=>setImmediate(r));await until(()=>!Reflect.get(engine,'delivering'));
   now=20_000;c.mock.timers.tick(10_000);await new Promise<void>(r=>setImmediate(r));await until(()=>!Reflect.get(engine,'delivering'));
   const id=store.requestBySource('source')!.id;
   assert.equal(store.outputParts(id,'progress_notice').length,destination==='default'?2:0);
   assert.equal(messages.filter(m=>m.startsWith('답변 중...')).length,destination==='default'?2:0);
   release();await until(()=>store.request(id)?.state==='completed'&&!Reflect.get(engine,'delivering'));
   assert.ok(messages.some(m=>m.includes('(00분 20초 경과)')));
  }finally{release();engine.close();await new Promise<void>(r=>setImmediate(r));store.close();}
 });
});

test('Slack does not send a pending periodic notice recovered from an earlier version',async()=>{
 const store=new Store(':memory:');store.bindThread({threadId,guildId:config.guildId,parentChannelId:config.channelId,ownerUserId:config.ownerUserId},'origin');
 store.enqueue('source',threadId,'question');const id=store.requestBySource('source')!.id;
 store.addOutput(id,threadId,['답변 중... (00분 10초)'],'progress_notice');
 const sent:string[]=[];const engine=new Engine(config,store,{health:async()=>{},createSession:async()=> 'session',runTurn:async()=>({text:'done'}),stop:async()=>({confirmed:true})},createSlackOutbound(async(_method,body={})=>{sent.push(String(body.text));return {ok:true,ts:'1700000001.000001'};},config,store));
 try{await engine.flushOutbox();assert.deepEqual(sent,[]);assert.equal(store.outbox().length,0);}finally{engine.close();store.close();}
});

test('Slack persists compact citation rendering for later delivery and keeps JSON-shaped notices literal',async()=>{
 const store=new Store(':memory:');store.bindThread({threadId,guildId:config.guildId,parentChannelId:config.channelId,ownerUserId:config.ownerUserId},'origin');
 store.enqueue('source',threadId,'question');const id=store.requestBySource('source')!.id;
 store.startRequest(id);store.transition(id,'running','completed');
 const posts:Array<Record<string,unknown>>=[];
 const outbound=createSlackOutbound(async(method,body={})=>{if(method==='chat.postMessage')posts.push(body);return {ok:true,ts:'1700000001.000001'};},config,store);
 const encoded=outbound.formatAnswer!({text:'<citation refs="s">자료</citation>',sources:[{id:'s',title:'Source',url:'https://example.org/'}]},'00분 01초');
 store.addOutput(id,threadId,encoded,'notice');
 store.addOutput(id,threadId,encoded,'answer');
 const backend:Backend={health:async()=>{},createSession:async()=>{assert.fail('must not recreate');},runTurn:async()=>{assert.fail('must not rerun');},stop:async()=>({confirmed:true})};
 const engine=new Engine(config,store,backend,outbound);
 try{
  await engine.flushOutbox();await engine.flushOutbox();
  assert.equal(posts.length,2);
  assert.equal((posts[0]!.blocks as Array<{text:{text:string}}>)[0]!.text.text,encoded[0]);
  assert.equal((posts[0]!.blocks as unknown[]).length,1);
  assert.equal(blockBody((posts[1]!.blocks as Block[])[0]!),'(00분 01초 경과)\n\n자료[1]');
  assert.equal((posts[0]!.blocks as Block[])[0]!.type,'section');
  assert.equal((posts[1]!.blocks as Block[])[0]!.type,'markdown');
  assert.equal((posts[1]!.blocks as unknown[]).length,4);
 }finally{engine.close();store.close();}
});

test('Slack keeps each split code fence independently renderable without losing code',async()=>{
 const code='const x = 1;\n'.repeat(200);
 const result=await present('```ts\n'+code+'```\n끝.');
 const chunks=result.posts.map(p=>blockBody((p.blocks as Block[])[0]!));
 assert.ok(chunks.length>1);
 for(const chunk of chunks){assert.ok(chunk.length<=1900);assert.equal((chunk.match(/```/g)?.length??0)%2,0);}
 assert.equal(chunks.flatMap(chunk=>[...chunk.matchAll(/```ts\n([\s\S]*?)\n```/g)].map(match=>match[1])).join(''),code.slice(0,-1));
 assert.ok(chunks.at(-1)!.endsWith('\n끝.'));
});

test('Slack keeps emphasis and links complete at message boundaries',async()=>{
 const emphasized='중요한 내용 '.repeat(300).trimEnd();
 const result=await present('앞부분 '.repeat(370)+'[문서](https://example.org/docs)\n\n**'+emphasized+'**');
 for(const post of result.posts){
  const chunk=blockBody((post.blocks as Block[])[0]!);
  assert.ok(chunk.length<=1900);
  assert.equal((chunk.match(/\*\*/g)?.length??0)%2,0);
  if(chunk.includes('https://example.org'))assert.ok(chunk.includes('[문서](https://example.org/docs)'));
 }
 assert.equal(result.body.replaceAll('**',''),'(00분 00초 경과)\n\n'+'앞부분 '.repeat(370)+'[문서](https://example.org/docs)\n\n'+emphasized);
});

test('Slack delivers legacy references at the previous length boundary without marking delivery uncertain',async()=>{
 const store=new Store(':memory:');store.bindThread({threadId,guildId:config.guildId,parentChannelId:config.channelId,ownerUserId:config.ownerUserId},'origin');
 store.enqueue('legacy',threadId,'question');const id=store.requestBySource('legacy')!.id;
 store.startRequest(id);store.transition(id,'running','completed');
 store.addOutput(id,threadId,[JSON.stringify({type:'slack_answer',body:'이전 답변[1]',references:[{number:1,title:'T'.repeat(60),url:'https://example.org/?'+'&'.repeat(362)}]})],'answer');
 const posts:Array<Record<string,unknown>>=[];
 const backend:Backend={health:async()=>{},createSession:async()=>{assert.fail('must not recreate');},runTurn:async()=>{assert.fail('must not rerun');},stop:async()=>({confirmed:true})};
 const engine=new Engine(config,store,backend,createSlackOutbound(async(method,body={})=>{if(method==='chat.postMessage')posts.push(body);return {ok:true,ts:'1700000001.000001'};},config,store));
 try{
  await engine.flushOutbox();await engine.flushOutbox();
  assert.equal(posts.length,1);assert.equal(store.deliveryUncertainCount(),0);
  const blocks=posts[0]!.blocks as Block[];
  assert.equal(blockBody(blocks[0]!),'이전 답변[1]');
  assert.equal(blocks[2]!.type,'header');assert.ok(blockBody(blocks[3]!).length<=1900);
 }finally{engine.close();store.close();}
});

test('Slack delivers references truncated at a whitespace boundary',async()=>{
 const result=await present('<citation refs="s">Answer</citation>',[{id:'s',title:'a'.repeat(59)+' trailing title',url:'https://source.example/'}]);
 assert.equal(result.posts.length,1);
 assert.equal(result.outbox[0]?.state,'sent');
});
