import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Store} from '../src/store.js';
import {Engine} from '../src/core/engine.js';
import type {Backend} from '../src/types.js';
import {mkdtempSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AttachmentFiles} from '../src/attachments.js';
const cfg={ownerUserId:'owner',guildId:'guild',channelId:'parent'};
const ok:Backend={health:async()=>{},createSession:async()=> 'test-session',runTurn:async()=>({text:'answer'}),stop:async()=>({confirmed:true})};
function fixture(backend:Backend=ok){
 const store=new Store(':memory:');for(const id of ['a','b','c','d'])store.bindThread({threadId:id,guildId:'guild',parentChannelId:'parent',ownerUserId:'owner'},'origin-'+id);
 const sent:Array<{thread:string;text:string}>=[];
 const engine=new Engine(cfg,store,backend,{progressNotices:false,send:async(thread,text)=>{sent.push({thread,text});return 'sent-'+sent.length;}});
 const submit=(sourceId:string,thread='a')=>engine.submit({sourceId,channelId:thread,userId:'owner',guildId:'guild',content:'synthetic question'});
 return {store,engine,sent,submit,close:async()=>{engine.close();await engine.waitForIdle();store.close();}};
}
async function until(f:()=>boolean){for(let i=0;i<200;i++){if(f())return;await new Promise(r=>setTimeout(r,5));}assert.fail('condition timed out');}
function enqueue(store:Store,id:string,thread='a',notice?:string){const r=store.enqueue(id,thread,'synthetic',5,[],{queueNotice:notice});assert.equal(r.kind,'queued');if(r.kind!=='queued')throw Error();return r.requestId;}
function uncertain(store:Store,id:number,code:string|null='session_creation_unknown'){store.startRequest(id);store.transition(id,'running','uncertain',code);}

test('creation uncertainty notifies once, quarantines its thread, and permits new input without replay',async()=>{
 let creates=0,runs=0;const t=fixture({...ok,createSession:async()=>{if(++creates===1)throw Error('private diagnostic');return 'new-session';},runTurn:async()=>{runs++;return {text:'answer'};}});
 try{t.submit('first');await t.engine.waitForIdle();assert.equal(t.sent.length,1);assert.match(t.sent[0]!.text,/제출하지 않았/);assert.ok(!t.sent[0]!.text.includes('private diagnostic'));
 assert.equal(t.engine.status().blocked,false);assert.equal(t.engine.status('a').blocked,true);assert.equal(t.submit('first').kind,'duplicate');assert.deepEqual(t.submit('same-thread'),{kind:'rejected',reason:'blocked'});
 assert.equal(t.submit('new-input','b').kind,'queued');await t.engine.waitForIdle();assert.equal(t.store.requestBySource('new-input')?.state,'completed');assert.equal(creates,2);assert.equal(runs,1);assert.equal(t.store.requestBySource('first')?.prompt,null);
 t.engine.start();await t.engine.waitForIdle();assert.equal(t.sent.filter(x=>x.thread==='a').length,1);
 }finally{await t.close();}
});
test('startup backfills a legacy creation-uncertain notice once without retry or binding mutation',async()=>{
 let calls=0;const t=fixture({...ok,createSession:async()=>{calls++;return 'bad';}});
 try{uncertain(t.store,enqueue(t.store,'legacy'));t.engine.start();await t.engine.waitForIdle();assert.equal(t.sent.length,1);t.engine.start();await t.engine.waitForIdle();assert.equal(t.sent.length,1);assert.equal(calls,0);assert.equal(t.store.session('a')?.backendId,null);}finally{await t.close();}
});
test('quarantine terminates same-thread waiting work with notice and releases queue capacity',async()=>{
 let reject!:(e:Error)=>void;const t=fixture({...ok,createSession:()=>new Promise<string>((_,r)=>{reject=r;})});
 try{t.submit('active');await until(()=>Boolean(reject));t.submit('waiting');reject(Error('unknown'));await t.engine.waitForIdle();assert.equal(t.store.requestBySource('waiting')?.state,'failed');assert.equal(t.store.requestBySource('waiting')?.prompt,null);assert.equal(t.store.pendingCount(),0);assert.equal(t.sent.filter(x=>/대기 요청/.test(x.text)).length,1);}finally{await t.close();}
});
test('queue expiry works under genuine remote uncertainty while new execution stays blocked',async()=>{
 const t=fixture();try{const r=enqueue(t.store,'remote');enqueue(t.store,'old','b');uncertain(t.store,r,'execution_unknown');t.store.db.prepare("UPDATE requests SET created_at=? WHERE source_id='old'").run(Date.now()-16*60_000);
 t.engine.start();await t.engine.waitForIdle();assert.equal(t.store.requestBySource('old')?.state,'failed');assert.equal(t.store.requestBySource('old')?.errorCode,'queue_expired');assert.equal(t.store.requestBySource('old')?.prompt,null);assert.equal(t.engine.status().blocked,true);assert.deepEqual(t.submit('new','c'),{kind:'rejected',reason:'blocked'});}finally{await t.close();}
});
test('one platform uncertainty does not block another store or replay the unknown turn',async()=>{
 const slack=fixture({...ok,runTurn:async()=>{throw Error('remote unknown');}}),discord=fixture();try{slack.submit('slack');await slack.engine.waitForIdle();assert.equal(slack.engine.status().blocked,true);discord.submit('discord');await discord.engine.waitForIdle();assert.equal(discord.store.requestBySource('discord')?.state,'completed');assert.equal(slack.submit('slack').kind,'duplicate');}finally{await slack.close();await discord.close();}
});
test('three unverified bootstraps trigger a persistent safety budget without automatic retry',async()=>{
 let calls=0;const t=fixture({...ok,createSession:async()=>{calls++;throw Error('unknown');}});try{for(const [i,thread] of ['a','b','c'].entries()){assert.equal(t.submit('new-'+i,thread).kind,'queued');await t.engine.waitForIdle();}
 assert.equal(calls,3);assert.equal(t.engine.status().blocked,true);assert.deepEqual(t.submit('fourth','d'),{kind:'rejected',reason:'blocked'});assert.match(t.sent.at(-1)!.text,/3건 누적/);assert.ok(!t.sent.at(-1)!.text.includes('새 스레드에 직접 질문'));t.engine.start();await t.engine.waitForIdle();assert.equal(calls,3);}finally{await t.close();}
});
test('unknown and bound failures remain global; expired events dedupe while new events can proceed',async()=>{
 for(const code of [null,'new_unknown_code','session_creation_unknown']){const t=fixture();try{t.store.setBackendId('a','bound');uncertain(t.store,enqueue(t.store,'x'),code);assert.equal(t.engine.status().blocked,true);}finally{await t.close();}}
 const t=fixture();try{enqueue(t.store,'expired','a','QUEUED');t.store.db.prepare('UPDATE requests SET created_at=?').run(Date.now()-16*60_000);t.engine.start();await t.engine.waitForIdle();assert.equal(t.submit('expired').kind,'duplicate');assert.deepEqual(t.sent.map(x=>x.text.includes('만료')?'EXPIRED':x.text),['QUEUED','EXPIRED']);assert.equal(t.submit('new-event').kind,'queued');await t.engine.waitForIdle();assert.equal(t.store.requestBySource('new-event')?.state,'completed');}finally{await t.close();}
});
test('lost queue acknowledgement cannot suppress terminal notice or be replayed',async()=>{
 for(const kind of ['creation','expiration']){const t=fixture();try{const id=enqueue(t.store,'notice-loss','a','DO NOT REPLAY');t.store.db.prepare("UPDATE outbox SET state='uncertain' WHERE request_id=? AND kind='queue_notice'").run(id);
 if(kind==='creation')uncertain(t.store,id);else t.store.db.prepare('UPDATE requests SET created_at=? WHERE id=?').run(Date.now()-16*60_000,id);
 t.engine.start();await t.engine.waitForIdle();assert.equal(t.sent.length,1);assert.ok(!t.sent[0]!.text.includes('DO NOT REPLAY'));assert.match(t.sent[0]!.text,kind==='creation'?/제출하지 않았/:/만료/);assert.equal(t.store.db.prepare("SELECT state FROM outbox WHERE request_id=? AND kind='queue_notice'").get(id)?.state,'uncertain');}finally{await t.close();}}
});

test('expiry boundary removes only unstarted payloads and retains active attachments',async context=>{
 const now=10_000_000;context.mock.timers.enable({apis:['Date'],now});
 const dir=mkdtempSync(join(tmpdir(),'aside-queue-expiry-'));
 const store=new Store(':memory:');
 for(const threadId of ['31','32','33'])store.bindThread({threadId,guildId:'guild',parentChannelId:'parent',ownerUserId:'owner'},threadId);
 const files=new AttachmentFiles(join(dir,'files'),async()=>{throw Error('must not download');});
 const engine=new Engine(cfg,store,ok,{send:async()=> 'sent'},files);
 try {
  for(const [i,id] of ['11','12','13'].entries()){
   const threadId=String(31+i),refs=[{id:'22',name:'note.txt',size:3,contentType:'text/plain'}];
   files.stage({sourceId:id,threadId,createdAt:now,files:refs});
   store.enqueue(id,threadId,'synthetic',5,refs.map(ref=>ref.id));
  }
  store.startRequest(store.requestBySource('13')!.id);
  store.db.prepare('UPDATE requests SET created_at=? WHERE source_id=?').run(now-15*60_000,'11');
  store.db.prepare('UPDATE requests SET created_at=? WHERE source_id=?').run(now-15*60_000+1,'12');
  store.db.prepare('UPDATE requests SET created_at=? WHERE source_id=?').run(now-30*60_000,'13');
  engine.maintainQueue();
  assert.equal(store.requestBySource('11')?.errorCode,'queue_expired');assert.equal(store.requestBySource('11')?.prompt,null);
  assert.equal(existsSync(join(dir,'files','11')),false);
  assert.equal(store.requestBySource('12')?.state,'queued');assert.equal(existsSync(join(dir,'files','12')),true);
  assert.equal(store.requestBySource('13')?.state,'running');assert.equal(existsSync(join(dir,'files','13')),true);
 }finally{engine.close();await engine.waitForIdle();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('uncertain failure-notice delivery never replays and cancelled recovery gets no late notice',async()=>{
 const t=fixture();let sends=0;t.engine.outbound.retrySafe=false;t.engine.outbound.send=async()=>{sends++;throw Error('lost acknowledgement');};
 try {
  const cancelled=enqueue(t.store,'cancelled','b');t.store.startRequest(cancelled);t.store.transition(cancelled,'running','cancelled','operator_abandoned_result_unknown');
  uncertain(t.store,enqueue(t.store,'unknown'));
  t.engine.start();await t.engine.waitForIdle();t.engine.start();await t.engine.waitForIdle();
  assert.equal(sends,1);assert.equal(t.store.deliveryUncertainCount(),1);
  assert.equal(t.store.db.prepare('SELECT COUNT(*) n FROM outbox WHERE request_id=?').get(cancelled)?.n,0);
  assert.equal(t.store.db.prepare('SELECT COUNT(*) n FROM outbox').get()?.n,1);
 }finally{await t.close();}
});
