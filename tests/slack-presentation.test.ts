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
async function present(sourceText:string,sources:Source[]=[],legacyText?:string){
 const store=new Store(':memory:');store.bindThread({threadId,guildId:config.guildId,parentChannelId:config.channelId,ownerUserId:config.ownerUserId},'origin');
 const posts:Array<Record<string,unknown>>=[];
 const api:SlackApi=async(method,body={})=>{if(method==='chat.postMessage')posts.push(body);return {ok:true,ts:'1700000001.000001'};};
 const backend:Backend={health:async()=>{},createSession:async()=> 'session',runTurn:async()=>({text:legacyText??sourceText,sourceText,sources}),stop:async()=>({confirmed:true})};
 const engine=new Engine(config,store,backend,createSlackOutbound(api,config,store));
 try{
  engine.submit({sourceId:'source',userId:config.ownerUserId,guildId:config.guildId,channelId:threadId,content:'question'});
  await until(()=>store.requestBySource('source')?.state==='completed'&&!Reflect.get(engine,'delivering'));
  const blocks=posts.flatMap(p=>p.blocks as Array<{type:string;text?:{type:string;text:string};elements?:Array<{type:string;text:string}>}>);
  return {posts,body:blocks.filter(b=>b.type==='section').map(b=>b.text!.text).join(''),contexts:blocks.filter(b=>b.type==='context').flatMap(b=>b.elements!).map(e=>e.text),outbox:store.outputParts(store.requestBySource('source')!.id,'answer')};
 }finally{engine.close();store.close();}
}

test('Slack preserves citation wording and links only exact cited search sources, once',async()=>{
 const raw='확정은 어렵습니다. <citation refs="sourceA#1,sourceB#2">두 장소의 주소</citation>를 비교하세요. <citation refs="sourceA#1">같은 근거</citation>도 참고하세요.';
 const result=await present(raw,[{id:'sourceA',title:'주소 A',url:'https://a.example/place?a=1&b=2'},{id:'sourceB',title:'주소 B',url:'https://b.example/place'},{id:'unused',title:'Unrelated',url:'https://unused.example/'}],raw+'\n\nSources:\n- Unrelated: https://unused.example/');
 assert.equal(result.body,'(00분 00초 경과)\n\n확정은 어렵습니다. 두 장소의 주소[1, 2]를 비교하세요. 같은 근거[1]도 참고하세요.');
 assert.equal(result.contexts.length,1);
 assert.match(result.contexts[0]!,/<https:\/\/a\.example\/place\?a=1&amp;b=2\|\[1\] 주소 A>/);
 assert.match(result.contexts[0]!,/<https:\/\/b\.example\/place\|\[2\] 주소 B>/);
 assert.equal(result.contexts[0]!.includes('unused'),false);
 assert.equal(result.posts.some(p=>String(p.text).includes('https://a.example')),false);
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
 for(const p of result.posts){const sections=(p.blocks as Array<{type:string;text?:{text:string}}>).filter(b=>b.type==='section');assert.ok(sections[0]!.text!.text.length<=1900);assert.ok(!/[\uD800-\uDBFF]$/.test(sections[0]!.text!.text));assert.equal(p.mrkdwn,false);}
 assert.equal(result.posts.slice(0,-1).some(p=>(p.blocks as Array<{type:string}>).some(b=>b.type==='context')),false);
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
  assert.equal((posts[1]!.blocks as Array<{text:{text:string}}>)[0]!.text.text,'(00분 01초 경과)\n\n자료[1]');
  assert.equal((posts[1]!.blocks as unknown[]).length,2);
 }finally{engine.close();store.close();}
});
