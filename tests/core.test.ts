import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import type { Client } from 'discord.js';
import { attachDiscordBot } from '../src/discord/bot.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/core/engine.js';
import { splitOutput } from '../src/core/split.js';
import { Store } from '../src/store.js';
import {AsideSettings} from '../src/aside/settings.js';
import { BackendFailureError, type Backend, type BotConfig, type Outbound } from '../src/types.js';

const config:BotConfig={ownerUserId:'owner',guildId:'guild',channelId:'parent'};
function setup(backend?:Backend,outbound?:Outbound) {
  const dir=mkdtempSync(join(tmpdir(),'aside-core-'));
  const file=join(dir,'data.sqlite');
  const store=new Store(file);
  store.bindThread({threadId:'thread',guildId:'guild',parentChannelId:'parent',ownerUserId:'owner'},'origin');
  const impl=backend??{health:async()=>{},createSession:async()=> 'backend-session',runTurn:async()=>({text:'Answer'}),stop:async()=>({confirmed:true})};
  const sent:Array<{threadId:string;content:string;nonce:string}>=[];
  const sink=outbound??{send:async(threadId:string,content:string,nonce:string)=>{sent.push({threadId,content,nonce});return 'msg-'+sent.length;}};
  const settings=new AsideSettings('/test/aside',async()=>`ASIDE_BOT_JSON:${JSON.stringify({modelCategories:{fast:{provider:'openai-codex',modelId:'gpt-6-luna',thinkingLevel:'max',fastMode:true}},defaultModel:{}})}`);
  const engine=new Engine(config,store,impl,sink,undefined,settings);
  const turn=(sourceId:string,content='Question')=>({sourceId,userId:'owner',guildId:'guild',channelId:'thread',content});
  return {dir,file,store,engine,turn,sent,cleanup:()=>{engine.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
async function until(fn:()=>boolean) {
  for(let i=0;i<100;i++) {if(fn()) return; await new Promise(r=>setTimeout(r,5));}
  assert.fail('timed out');
}

test('missing old session tells the owner to start a new conversation without blocking other work',async()=>{
 let turns=0;
 const t=setup({health:async()=>{},createSession:async()=> 'sid',runTurn:async()=>{turns++;if(turns===1)throw new BackendFailureError('session_unavailable');return {text:'new answer'};},stop:async()=>({confirmed:true})});
 try{
  t.engine.submit(t.turn('missing-session'));
  await until(()=>t.store.requestBySource('missing-session')?.state==='failed'&&t.sent.length===1);
  assert.equal(t.store.requestBySource('missing-session')?.errorCode,'session_unavailable');assert.equal(t.store.hasUncertain(),false);
  assert.match(t.sent[0]?.content??'',/새 대화/);assert.equal(t.store.outputParts(t.store.requestBySource('missing-session')!.id,'answer').length,0);
  t.engine.submit(t.turn('next-question'));await until(()=>t.store.requestBySource('next-question')?.state==='completed');
 }finally{t.cleanup();}
});

test('transport without dedupe never retries ambiguous delivery, including after restart',async()=>{
 const t=setup();let sends=0;
 Reflect.set(t.engine.outbound,'retrySafe',false);
 t.engine.outbound.send=async()=>{sends++;throw new Error('connection lost after send');};
 try{
  const req=t.store.enqueue('delivery','thread','question');assert.equal(req.kind,'queued');
  const id=t.store.requestBySource('delivery')!.id;
  t.store.addOutput(id,'thread',['answer']);
  await t.engine.flushOutbox();await t.engine.flushOutbox();
  assert.equal(sends,1);assert.equal(t.engine.status().deliveryUncertain,1);
  t.store.enqueue('restart-delivery','thread','question');
  t.store.addOutput(t.store.requestBySource('restart-delivery')!.id,'thread',['pending at crash']);
  const row=t.store.outbox()[0]!;t.store.markSending(row.id);
  const reopened=new Store(t.file),restarted=new Engine(config,reopened,t.engine.backend,t.engine.outbound);
  try{await restarted.flushOutbox();}finally{restarted.close();reopened.close();}
  assert.equal(sends,1);assert.equal(t.engine.status().deliveryUncertain,2);
 }finally{t.cleanup();}
});

test('only initial requests rename once and rename failure never blocks answers',async()=>{
 for(const renameFails of [false,true]){
  const options:unknown[]=[],renames:string[]=[];
  const t=setup();
  t.engine.backend.runTurn=async(_id,_prompt,_signal,_selection,...extra:unknown[])=>{
   options.push(extra[0]);return {text:'Answer',threadTitle:'AI title'};
  };
  Reflect.set(t.engine.outbound,'setThreadTitle',async(_id:string,title:string)=>{renames.push(title);if(renameFails)throw Error('rename unavailable');});
  try{
   t.engine.submit(t.turn('first'),{publishQuestion:true,inputKind:'initial'});
   await until(()=>t.store.outputParts(t.store.requestBySource('first')!.id,'answer').every(p=>p.state==='sent')&&t.sent.some(p=>p.content.endsWith('\n\nAnswer')));
   assert.deepEqual(options,[{generateThreadTitle:true}]);assert.deepEqual(renames,['AI title']);
   for(const kind of ['message','comparison'] as const){
    t.engine.submit(t.turn(kind),{inputKind:kind});await until(()=>t.store.requestBySource(kind)?.state==='completed');
   }
   assert.deepEqual(options,[{generateThreadTitle:true},undefined,undefined]);assert.deepEqual(renames,['AI title']);
   assert.equal(t.engine.status().uncertain,0);
  }finally{t.cleanup();}
 }
});

test('authorization, exact channel binding, attachment and length rejection',()=>{
  const t=setup();
  try {
    assert.equal(t.engine.submit({...t.turn('x'),userId:'other'}).kind,'rejected');
    assert.equal(t.engine.submit({...t.turn('x'),guildId:'other'}).kind,'rejected');
    assert.equal(t.engine.submit({...t.turn('x'),channelId:'parent'}).kind,'rejected');
    assert.equal(t.engine.submit({...t.turn('x'),channelId:'other-thread'}).kind,'rejected');
    assert.equal(t.engine.submit({...t.turn('x'),isDm:true}).kind,'rejected');
    assert.equal(t.engine.submit({...t.turn('x'),attachments:[{id:'22',name:'a.txt',size:3,contentType:'text/plain'}]}).kind,'rejected');
    assert.equal(t.engine.submit(t.turn('x',' '.repeat(10))).kind,'rejected');
    assert.equal(t.engine.submit(t.turn('x','x'.repeat(8001))).kind,'rejected');
    assert.equal(t.store.pendingCount(),0);
    assert.equal(t.engine.allowedCommandChannel('other-thread'),false);
    assert.equal(t.engine.allowedCommandChannel('thread','wrong-parent','guild'),false);
    assert.equal(t.engine.allowedCommandChannel('thread','parent','wrong-guild'),false);
    assert.equal(t.engine.allowedCommandChannel('thread','parent','guild'),true);
  } finally { t.cleanup(); }
});

test('dedupes source IDs and caps queue at five while one task runs',async()=>{
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let running=0,maxRunning=0,started=0;
  const backend:Backend={health:async()=>{},createSession:async()=> 'sid',runTurn:async()=>{running++;started++;maxRunning=Math.max(maxRunning,running);await gate;running--;return {text:'Done'};},stop:async()=>({confirmed:true})};
  const t=setup(backend);
  try {
    const first=t.engine.submit(t.turn('first'));
    assert.equal(first.kind,'queued');
    await until(()=>started===1);
    assert.equal(t.engine.submit(t.turn('first')).kind,'duplicate');
    for(let i=0;i<5;i++) assert.equal(t.engine.submit(t.turn('p'+i)).kind,'queued');
    assert.deepEqual(t.engine.submit(t.turn('overflow')),{kind:'rejected',reason:'queue_full'});
    release();
    await until(()=>t.store.counts().queued===0 && t.store.counts().running===0);
    assert.equal(maxRunning,1);
    assert.equal(started,6);
  } finally {release();t.cleanup();}
});

test('restart converts running to uncertain and never replays',()=>{
  const t=setup();
  const first=t.store.enqueue('a','thread','Question');
  assert.equal(first.kind,'queued');
  if(first.kind==='queued') assert.equal(t.store.startRequest(first.requestId),true);
  // Simulate abrupt process death by reopening a DB with a running marker.
  const reopened=new Store(t.file);
  try {
    assert.equal(reopened.requestBySource('a')?.state,'uncertain');
    assert.equal(reopened.hasUncertain(),true);
    assert.equal(reopened.enqueue('b','thread','new').kind,'blocked');
    assert.equal(reopened.session('thread')?.blocked,1);
  } finally {reopened.close();t.cleanup();}
});

test('unconfirmed stop blocks subsequent execution',async()=>{
  let calls=0;
  const t=setup({health:async()=>{},createSession:async()=> 'sid',runTurn:async()=>{calls++;return new Promise(()=>{});},stop:async()=>({confirmed:false})});
  try {
    t.engine.submit(t.turn('a'));
    await until(()=>calls===1);
    assert.equal(await t.engine.stop('thread','owner','guild'),'uncertain');
    assert.equal(t.store.requestBySource('a')?.state,'uncertain');
    assert.deepEqual(t.engine.submit(t.turn('b')),{kind:'rejected',reason:'blocked'});
    assert.equal(calls,1);
  } finally {t.cleanup();}
});

test('health failure launches no session or turn and records safe failure',async()=>{
  let created=0,runs=0;
  const t=setup({health:async()=>{throw new Error('secret')},createSession:async()=>{created++;return 'sid'},runTurn:async()=>{runs++;return {text:'x'}},stop:async()=>({confirmed:true})});
  try {
    t.engine.submit(t.turn('x'));
    await until(()=>t.store.requestBySource('x')?.state==='failed');
    assert.equal(created,0);assert.equal(runs,0);
    assert.equal(t.store.requestBySource('x')?.errorCode,'health_failed');
    assert.equal(t.store.requestBySource('x')?.prompt,null);
  } finally {t.cleanup();}
});

test('safe splitting preserves full text and stable nonce allows bounded retry',async()=>{
  const text='a'.repeat(1899)+'🌲'.repeat(300)+'\n'+'b'.repeat(2040);
  const parts=splitOutput(text);
  assert.equal(parts.join(''),text);
  assert.ok(parts.every(p=>Array.from(p).length<=1900));
  let attempts=0;
  const nonces:string[]=[];
  const t=setup(undefined,{send:async(_thread,_content,nonce)=>{attempts++;nonces.push(nonce);if(attempts===1) throw Error('unknown send');return 'delivered';}});
  try {
    t.engine.submit(t.turn('x'));
    await until(()=>t.store.outbox().some(r=>r.state==='sending'));
    await t.engine.flushOutbox();
    await until(()=>t.store.outbox().length===0);
    assert.equal(attempts,2);
    assert.equal(nonces[0],nonces[1]);
    assert.ok(nonces[0]!.length<=25);
  } finally {t.cleanup();}
});

test('generic run error blocks all new execution; confirmed failure does not',async()=>{
  let calls=0;
  const t=setup({health:async()=>{},createSession:async()=> 'sid',runTurn:async()=>{calls++;throw Error('timeout secret')},stop:async()=>({confirmed:false})});
  try {
    t.engine.submit(t.turn('ambiguous'));
    await until(()=>t.store.requestBySource('ambiguous')?.state==='uncertain');
    assert.equal(t.store.requestBySource('ambiguous')?.errorCode,'execution_unknown');
    assert.equal(t.store.requestBySource('ambiguous')?.prompt,null);
    assert.deepEqual(t.engine.submit(t.turn('next')),{kind:'rejected',reason:'blocked'});
    assert.equal(calls,1);
  } finally {t.cleanup();}
  const safe=setup({health:async()=>{},createSession:async()=> 'sid',runTurn:async()=>{throw new BackendFailureError('not_started')},stop:async()=>({confirmed:true})});
  try {
    safe.engine.submit(safe.turn('safe'));
    await until(()=>safe.store.requestBySource('safe')?.state==='failed');
    assert.equal(safe.store.hasUncertain(),false);
  } finally {safe.cleanup();}
});

test('createSession timeout defaults to uncertain, never launches turn',async()=>{
  let runs=0;
  const t=setup({health:async()=>{},createSession:async()=>{throw Error('unknown remote session')},runTurn:async()=>{runs++;return {text:'x'}},stop:async()=>({confirmed:false})});
  try {
    t.engine.submit(t.turn('create'));
    await until(()=>t.store.requestBySource('create')?.state==='uncertain');
    assert.equal(t.store.requestBySource('create')?.errorCode,'session_creation_unknown');
    assert.equal(runs,0);
  } finally {t.cleanup();}
});

test('stop during create waits for created session and remote confirmation',async()=>{
  let resolveCreate!:(id:string)=>void;
  const creation=new Promise<string>(resolve=>{resolveCreate=resolve;});
  let stops=0,runs=0;
  const t=setup({health:async()=>{},createSession:()=>creation,runTurn:async()=>{runs++;return {text:'bad'}},stop:async()=>{stops++;return {confirmed:true}}});
  try {
    t.engine.submit(t.turn('create-stop'));
    await until(()=>t.store.requestBySource('create-stop')?.state==='running');
    // Wait until create actually begins, not merely the running DB marker.
    await until(()=>Boolean((t.engine as unknown as {active?:{phase:string}}).active?.phase==='creating'));
    let settled=false;
    const stopping=t.engine.stop('thread','owner','guild').then(r=>{settled=true;return r;});
    await new Promise(r=>setTimeout(r,10));
    assert.equal(settled,false);
    assert.equal(t.store.requestBySource('create-stop')?.state,'cancel_requested');
    resolveCreate('sid');
    assert.equal(await stopping,'stopped');
    await until(()=>t.store.requestBySource('create-stop')?.state==='cancelled');
    assert.equal(stops,1);
    assert.equal(runs,0);
    assert.equal(t.store.session('thread')?.backendId,'sid');
  } finally {resolveCreate('sid');t.cleanup();}
});

test('confirmed stop permits queued work after remote confirms',async()=>{
  let calls=0,stops=0;
  const t=setup({health:async()=>{},createSession:async()=> 'sid',runTurn:async()=>{calls++;if(calls===1) return new Promise(()=>{});return {text:'next answer'};},stop:async()=>{stops++;return {confirmed:true}}});
  try {
    t.engine.submit(t.turn('first'));
    await until(()=>calls===1);
    t.engine.submit(t.turn('next'));
    assert.equal(await t.engine.stop('thread','other','guild'),'not_found');
    // Stopping a thread cancels queued work in that thread by design.
    assert.equal(await t.engine.stop('thread','owner','guild'),'stopped');
    await until(()=>t.store.requestBySource('first')?.state==='cancelled');
    assert.equal(t.store.requestBySource('next')?.state,'cancelled');
    assert.equal(stops,1);
    t.engine.submit(t.turn('after-stop'));
    await until(()=>t.store.requestBySource('after-stop')?.state==='completed');
    assert.equal(calls,2);
  } finally {t.cleanup();}
});

test('actual command channel must be designated or bound thread with correct parent',async()=>{
  const t=setup();
  const client=new EventEmitter();
  attachDiscordBot(client as Client,t.engine);
  try {
    const replies:string[]=[];
    const fake=(parentId:string)=>({
      id:`command-${parentId}`,
      isChatInputCommand:()=>true,commandName:'aside',user:{id:'owner'},guildId:'guild',channelId:'thread',
      channel:{id:'thread',guildId:'guild',parentId,isThread:()=>true},
      options:{getSubcommand:()=> 'status'},
      reply:async(o:{content:string})=>{replies.push(o.content);},
      deferred:false,replied:false,
    });
    client.emit('interactionCreate',fake('other-parent'));
    await until(()=>replies.length===1);
    assert.match(replies[0]!,/권한/);
    client.emit('interactionCreate',fake('parent'));
    await until(()=>replies.length===2);
    assert.match(replies[1]!,/대기/);
  } finally {t.cleanup();}
});

test('initial question is durable; restart aged unknown delivery blocks later parts',async()=>{
  const t=setup(undefined,{send:async()=>{throw Error('transport unknown')}});
  try {
    const result=t.engine.submit(t.turn('slash','Q'.repeat(4000)),{publishQuestion:true});
    assert.equal(result.kind,'queued');
    await until(()=>t.store.outbox().some(r=>r.state==='sending'));
    const rows=t.store.db.prepare('SELECT part,state,content FROM outbox ORDER BY part').all() as Array<{part:number;state:string;content:string}>;
    assert.ok(rows.length>=3);
    assert.ok(rows.every(r=>r.part<0));
    assert.match(rows[0]!.content,/질문:/);
    t.engine.close();
    t.store.db.prepare("UPDATE outbox SET attempted_at=? WHERE state='sending'").run(Date.now()-5*60_000);
    const reopened=new Store(t.file);
    let sends=0;
    const recovered=new Engine(config,reopened,{health:async()=>{},createSession:async()=> 'sid',runTurn:async()=>({text:'x'}),stop:async()=>({confirmed:true})},{send:async()=>{sends++;return 'id'}});
    try {
      await recovered.flushOutbox();
      const saved=reopened.db.prepare('SELECT part,state FROM outbox ORDER BY part').all() as Array<{part:number;state:string}>;
      assert.equal(saved[0]!.state,'uncertain');
      assert.ok(saved.slice(1).every(r=>r.state==='pending'));
      assert.equal(sends,0);
    } finally {recovered.close();reopened.close();}
  } finally {t.cleanup();}
});

test('stop during ambiguous create becomes uncertain and blocks queue',async()=>{
  let rejectCreate!:(error:Error)=>void;
  const creation=new Promise<string>((_resolve,reject)=>{rejectCreate=reject;});
  let stops=0,runs=0;
  const t=setup({health:async()=>{},createSession:()=>creation,runTurn:async()=>{runs++;return {text:'bad'}},stop:async()=>{stops++;return {confirmed:true}}});
  try {
    t.engine.submit(t.turn('ambiguous-create'));
    await until(()=>Boolean((t.engine as unknown as {active?:{phase:string}}).active?.phase==='creating'));
    const pending=t.engine.stop('thread','owner','guild');
    rejectCreate(Error('unknown result'));
    assert.equal(await pending,'uncertain');
    assert.equal(t.store.requestBySource('ambiguous-create')?.state,'uncertain');
    assert.equal(runs,0);
    assert.equal(stops,0);
    assert.deepEqual(t.engine.submit(t.turn('later')),{kind:'rejected',reason:'blocked'});
  } finally {t.cleanup();}
});

test('restart retries unknown send inside nonce window with identical nonce',async()=>{
  const t=setup(undefined,{send:async()=>{throw Error('response lost')}});
  try {
    const queued=t.engine.submit(t.turn('output'));
    assert.equal(queued.kind,'queued');
    await until(()=>t.store.outbox().some(r=>r.state==='sending'));
    const pending=t.store.outbox()[0]!;
    t.engine.close();
    const restarted=new Store(t.file);
    const seen:string[]=[];
    const recovered=new Engine(config,restarted,{health:async()=>{},createSession:async()=> 'sid',runTurn:async()=>({text:'x'}),stop:async()=>({confirmed:true})},{send:async(_thread,_content,nonce)=>{seen.push(nonce);return 'confirmed-message';}});
    try {
      await recovered.flushOutbox();
      assert.deepEqual(seen,[pending.nonce]);
      assert.equal(restarted.outbox().length,0);
      const row=restarted.db.prepare('SELECT state,discord_message_id FROM outbox WHERE id=?').get(pending.id) as {state:string;discord_message_id:string};
      assert.equal(row.state,'sent');
      assert.equal(row.discord_message_id,'confirmed-message');
    } finally {recovered.close();restarted.close();}
  } finally {t.cleanup();}
});

test('typed failure from stop after create still blocks as uncertain',async()=>{
  let resolveCreate!:(id:string)=>void;
  const creation=new Promise<string>(resolve=>{resolveCreate=resolve;});
  const t=setup({health:async()=>{},createSession:()=>creation,runTurn:async()=>({text:'never'}),stop:async()=>{throw new BackendFailureError('stop_request_failed')}});
  try {
    t.engine.submit(t.turn('stop-error'));
    await until(()=>Boolean((t.engine as unknown as {active?:{phase:string}}).active?.phase==='creating'));
    const result=t.engine.stop('thread','owner','guild');
    resolveCreate('sid');
    assert.equal(await result,'uncertain');
    assert.equal(t.store.requestBySource('stop-error')?.state,'uncertain');
    assert.equal(t.store.hasUncertain(),true);
  } finally {resolveCreate('sid');t.cleanup();}
});

test('output splitting respects UTF-16 Discord length with emoji',()=>{
  const text='🌲'.repeat(2000)+' 끝';
  const parts=splitOutput(text);
  assert.equal(parts.join(''),text);
  assert.ok(parts.every(part=>part.length<=1900));
  assert.ok(parts.every(part=>!part.includes('\uFFFD')));
});

test('thread sessions are isolated and reused after reopening the store',async()=>{
 let creates=0;const ids:string[]=[];
 const backend:Backend={health:async()=>{},createSession:async()=>`sid-${++creates}`,runTurn:async id=>{ids.push(id);return {text:'Answer'};},stop:async()=>({confirmed:true})};
 const t=setup(backend);
 try {
  t.store.bindThread({threadId:'thread-b',guildId:'guild',parentChannelId:'parent',ownerUserId:'owner'},'origin-b');
  for(const [source,channel] of [['one','thread'],['two','thread'],['three','thread-b']]) {
   t.engine.submit({...t.turn(source!),channelId:channel!});await until(()=>t.store.requestBySource(source!)?.state==='completed');
  }
  assert.deepEqual(ids,['sid-1','sid-1','sid-2']);assert.equal(creates,2);t.engine.close();
  const reopened=new Store(t.file);const engine=new Engine(config,reopened,backend,{send:async()=> 'sent'});
  try {engine.submit(t.turn('four'));await until(()=>reopened.requestBySource('four')?.state==='completed');assert.equal(ids.at(-1),'sid-1');assert.equal(creates,2);}
  finally {engine.close();reopened.close();}
 } finally {t.cleanup();}
});

test('new and ask handlers both bind and execute a fresh conversation',async()=>{
 let created=0;const t=setup({health:async()=>{},createSession:async()=>`handler-${++created}`,runTurn:async()=>({text:'Answer'}),stop:async()=>({confirmed:true})}),client=new EventEmitter();let count=0;const replies:string[]=[];
 const destination={type:0,guildId:'guild',threads:{create:async()=>({id:`new-${++count}`,delete:async()=>{}})}};
 const api=Object.assign(client,{channels:{fetch:async()=>destination}});
 attachDiscordBot(api as unknown as Client,t.engine);
 try {
 for(const sub of ['new','ask']) {
 client.emit('interactionCreate',{
 id:`origin-${sub}`,isChatInputCommand:()=>true,commandName:'aside',user:{id:'owner'},guildId:'guild',channelId:'parent',
 channel:{id:'parent',guildId:'guild',type:0,isThread:()=>false},client:api,
 options:{getSubcommand:()=>sub,getString:(name:string)=>name==='question'?'Hello':null},deferReply:async()=>{},
 editReply:async(o:{content:string})=>{replies.push(o.content);},reply:async(o:{content:string})=>{replies.push(o.content);},
 });
 await until(()=>t.store.requestBySource(`origin-${sub}`)?.state==='completed');
 assert.ok(t.store.sessionByOrigin(`origin-${sub}`));
 }
 assert.equal(count,2);assert.equal(replies.length,2);
 } finally {t.cleanup();}
});

test('stop retries only stop-related uncertainty and clears its block after acknowledgement',async()=>{
 let calls=0;
 const t=setup({health:async()=>{},createSession:async()=> 'sid',runTurn:async()=>({text:'Answer'}),stop:async()=>{calls++;return {confirmed:false,accepted:true};}});
 try {
 t.store.setBackendId('thread','sid');
 const q=t.store.enqueue('old-stop','thread','Old');assert.equal(q.kind,'queued');if(q.kind!=='queued')return;
 t.store.startRequest(q.requestId);t.store.transition(q.requestId,'running','uncertain','stop_unconfirmed');
 assert.equal(await t.engine.stop('thread','other','guild'),'not_found');assert.equal(calls,0);
 assert.equal(await t.engine.stop('thread','owner','guild'),'requested');
 assert.equal(t.store.request(q.requestId)?.state,'cancelled');assert.equal(t.store.request(q.requestId)?.errorCode,'stop_requested');assert.equal(t.store.hasUncertain(),false);assert.equal(t.store.session('thread')?.blocked,0);
 const q2=t.store.enqueue('unknown-execution','thread','New');if(q2.kind!=='queued')assert.fail();
 t.store.startRequest(q2.requestId);t.store.transition(q2.requestId,'running','uncertain','execution_unknown');
 assert.equal(await t.engine.stop('thread','owner','guild'),'uncertain');assert.equal(calls,1);assert.equal(t.store.hasUncertain(),true);
 }finally{t.cleanup();}
});

test('acknowledged interruption cancels local answer and permits a follow-up',async()=>{
 let runs=0;
 const t=setup({health:async()=>{},createSession:async()=> 'sid',runTurn:async()=>{if(++runs===1)return new Promise(()=>{});return {text:'next'};},stop:async()=>({confirmed:false,accepted:true})});
 try {t.engine.submit(t.turn('first'));await until(()=>runs===1);
 assert.equal(await t.engine.stop('thread','owner','guild'),'requested');
 assert.equal(t.store.requestBySource('first')?.state,'cancelled');
 t.engine.submit(t.turn('follow-up'));await until(()=>t.store.requestBySource('follow-up')?.state==='completed');assert.equal(runs,2);
 }finally{t.cleanup();}
});

test('attachment pipeline dedupes, prepares before Aside, and preserves the session',async()=>{
 const {AttachmentFiles}=await import('../src/attachments.js');
 let creates=0;const prompts:string[]=[];
 const t=setup({health:async()=>{},createSession:async()=>{creates++;return 'same-sid';},runTurn:async(s,p)=>{assert.equal(s,'same-sid');prompts.push(p);return {text:'Read'};},stop:async()=>({confirmed:true})});
 let resolutions=0;
 const ref={id:'22',name:'note.txt',size:3,contentType:'text/plain'};
 const files=new AttachmentFiles(join(t.dir,'attachments'),async()=>{resolutions++;return [{...ref,url:'https://cdn.discordapp.com/a'}];},async()=>new Response('abc'));
 t.store.bindThread({threadId:'33',guildId:'guild',parentChannelId:'parent',ownerUserId:'owner'},'attachment-origin');
 const engine=new Engine(config,t.store,t.engine.backend,{send:async()=> 'msg'},files);
 const turn={...t.turn('11'),channelId:'33',attachments:[ref]};
 try{
 assert.equal(engine.submit(turn).kind,'queued');assert.equal(engine.submit(turn).kind,'duplicate');
 await until(()=>t.store.requestBySource('11')?.state==='completed');
 assert.match(prompts[0]!,/abc/);assert.equal(resolutions,1);
 assert.equal(engine.submit({...t.turn('12'),channelId:'33'}).kind,'queued');
 await until(()=>t.store.requestBySource('12')?.state==='completed');assert.equal(creates,1);assert.equal(prompts.length,2);
 }finally{engine.close();t.cleanup();}
});

test('stopping attachment preparation never launches or stops an Aside session',async()=>{
 const {AttachmentFiles}=await import('../src/attachments.js');let started=false,calls=0;
 const t=setup({health:async()=>{},createSession:async()=>{calls++;return 'sid';},runTurn:async()=>{calls++;return {text:'bad'};},stop:async()=>{calls++;return {confirmed:true};}});
 const ref={id:'22',name:'a.txt',size:3,contentType:'text/plain'};
 const files=new AttachmentFiles(join(t.dir,'attachments'),async()=>{started=true;return new Promise(()=>{});});
 t.store.bindThread({threadId:'33',guildId:'guild',parentChannelId:'parent',ownerUserId:'owner'},'attachment-origin');
 const engine=new Engine(config,t.store,t.engine.backend,{send:async()=> 'msg'},files);
 try{
 assert.equal(engine.submit({...t.turn('11'),channelId:'33',attachments:[ref]}).kind,'queued');await until(()=>started);
 assert.equal(await engine.stop('33','owner','guild'),'stopped');
 await until(()=>t.store.requestBySource('11')?.state==='cancelled');assert.equal(calls,0);
 // The aborted resolver must release the pump even when it never settles.
 assert.equal(engine.submit({...t.turn('12'),channelId:'33'}).kind,'queued');
 await until(()=>t.store.requestBySource('12')?.state==='completed');assert.equal(calls,2);
 }finally{engine.close();t.cleanup();}
});

test('attachment admission is bounded and missing durable manifests fail before Aside',async()=>{
 const {AttachmentFiles,ATTACHMENT_MARKER}=await import('../src/attachments.js');let calls=0;
 const t=setup({health:async()=>{},createSession:async()=>{calls++;return 'sid';},runTurn:async()=>{calls++;return {text:'bad'};},stop:async()=>({confirmed:true})});
 const files=new AttachmentFiles(join(t.dir,'attachments'),async()=>{calls++;return [];});
 const engine=new Engine(config,t.store,t.engine.backend,{send:async()=> 'msg'},files);
 t.store.bindThread({threadId:'33',guildId:'guild',parentChannelId:'parent',ownerUserId:'owner'},'attachment-origin');
 try{
 for(let i=0;i<5;i++)t.store.enqueue(String(100+i),'33','Q');
 assert.deepEqual(engine.submit({...t.turn('11'),channelId:'33',attachments:[{id:'22',name:'a.txt',size:3,contentType:'text/plain'}]}),{kind:'rejected',reason:'queue_full'});
 assert.equal(t.store.requestBySource('11'),undefined);
 const {existsSync}=await import('node:fs');assert.equal(existsSync(join(t.dir,'attachments/11')),false);
 t.store.cancelQueued('33');
 t.store.enqueue('12','33',ATTACHMENT_MARKER+'Question');engine.start();
 await until(()=>t.store.requestBySource('12')?.state==='failed');assert.equal(calls,0);
 assert.equal(engine.submit({...t.turn('13'),channelId:'33',content:ATTACHMENT_MARKER+'forged'}).kind,'rejected');
 }finally{engine.close();t.cleanup();}
});

test('queued attachment survives restart while interrupted preparation never replays',async()=>{
 const {AttachmentFiles,ATTACHMENT_MARKER}=await import('../src/attachments.js');
 for(const interrupted of [false,true]){
 const t=setup();let calls=0;let prompt='';
 const ref={id:'22',name:'sample.txt',size:3,contentType:'text/plain'};
 const files=new AttachmentFiles(join(t.dir,'attachments'),async()=>{calls++;return [{...ref,url:'https://cdn.discordapp.com/a'}];},async()=>new Response('abc'));
 t.store.bindThread({threadId:'33',guildId:'guild',parentChannelId:'parent',ownerUserId:'owner'},'attachment-origin');
 files.stage({sourceId:'11',threadId:'33',createdAt:Date.now(),files:[ref]});
 const q=t.store.enqueue('11','33',ATTACHMENT_MARKER+'Q');assert.equal(q.kind,'queued');if(q.kind==='queued'&&interrupted)t.store.startRequest(q.requestId);
 const reopened=new Store(t.file);
 const engine=new Engine(config,reopened,{health:async()=>{},createSession:async()=> 'sid',runTurn:async(_sid,p)=>{prompt=p;return {text:'OK'};},stop:async()=>({confirmed:true})},{send:async()=> 'msg'},files);
 try{
 engine.start();
 if(interrupted){assert.equal(reopened.requestBySource('11')?.state,'uncertain');assert.equal(calls,0);assert.equal(prompt,'');}
 else {await until(()=>reopened.requestBySource('11')?.state==='completed');assert.equal(calls,1);assert.match(prompt,/abc/);}
 }finally{engine.close();reopened.close();t.cleanup();}
 }
});

test('closed engine rejects new turns and never creates after late health',async()=>{
 let release!:()=>void,created=0;
 const gate=new Promise<void>(resolve=>release=resolve);
 const t=setup({health:()=>gate,createSession:async()=>{created++;return 'sid';},runTurn:async()=>({text:'late'}),stop:async()=>({confirmed:false})});
 try{
  t.engine.submit(t.turn('before'));t.engine.close();
  assert.deepEqual(t.engine.submit(t.turn('after')),{kind:'rejected',reason:'service_stopping'});
  assert.equal(typeof (t.engine as any).waitForIdle,'function');
  release();await (t.engine as any).waitForIdle();assert.equal(created,0);assert.equal(t.sent.length,0);
 }finally{release();t.cleanup();}
});
test('shutdown preserves uncertain stop and waits for outstanding delivery',async()=>{
 let release!:()=>void;const gate=new Promise<string>(resolve=>release=()=>resolve('sent'));
 const t=setup(undefined,{send:()=>gate});
 try{
  t.engine.submit(t.turn('request'));await until(()=>t.store.outbox().some(r=>r.state==='sending'));
  t.engine.close();let idle=false;const waiting=(t.engine as any).waitForIdle().then(()=>idle=true);
  await new Promise(r=>setTimeout(r,5));assert.equal(idle,false);release();await waiting;assert.equal(idle,true);
 }finally{release();t.cleanup();}
});

test('late session creation during shutdown preserves an unconfirmed remote stop',async()=>{
 let release!:(id:string)=>void;const creation=new Promise<string>(resolve=>release=resolve);let creates=0,turns=0;
 const t=setup({health:async()=>{},createSession:()=>{creates++;return creation;},runTurn:async()=>{turns++;return {text:'late'};},stop:async()=>({confirmed:false})});
 try{
  t.engine.submit(t.turn('late-create'));await until(()=>creates===1);t.engine.close();
  const stopping=t.engine.stop('thread','owner','guild');release('late-session');assert.equal(await stopping,'uncertain');
  t.engine.abortLocalWork();await t.engine.waitForIdle();assert.equal(turns,0);assert.equal(t.store.requestBySource('late-create')?.state,'uncertain');assert.equal(t.sent.length,0);
 }finally{release('late-session');t.cleanup();}
});
