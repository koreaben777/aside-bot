import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {Engine} from '../src/core/engine.js';
import {createSlackApi,createSlackOutbound,type SlackApi} from '../src/slack/bot.js';
const config={ownerUserId:'U12345678',guildId:'T12345678',channelId:'D12345678'};
const thread=config.channelId+':1700000000.000001';
const backend={health:async()=>{},createSession:async()=> 'sid',runTurn:async()=>({text:'unused'}),stop:async()=>({confirmed:true})};
function fixture(api:SlackApi,stopping=()=>false){
 const dir=mkdtempSync(join(tmpdir(),'delivery-')),file=join(dir,'test.sqlite'),store=new Store(file);
 store.bindThread({threadId:thread,parentChannelId:config.channelId,...config},'origin');
 store.enqueue('question',thread,'synthetic');const id=store.requestBySource('question')!.id;
 store.startRequest(id);store.transition(id,'running','completed');store.addOutput(id,thread,['answer']);
 const row=store.outbox()[0]!,outbound=createSlackOutbound(api,config,store,false,stopping),engine=new Engine(config,store,backend,outbound);
 return {store,id,row,engine,file,close(){engine.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
const diagnostic=(store:Store,id:number)=>store.db.prepare('SELECT delivery_outcome,delivery_stage,delivery_code,http_status FROM outbox WHERE id=?').get(id);
test('definite API rejection is held as not sent across restart without storing raw errors',async()=>{
 let calls=0;const api=createSlackApi('synthetic',async()=>{calls++;return new Response(JSON.stringify({ok:false,error:'invalid_blocks',private:'PRIVATE_BODY'}));});
 const t=fixture(api);try{
  t.store.db.prepare("INSERT INTO outbox(request_id,thread_id,part,content,nonce,state,kind) VALUES(?,?,1,'tail','tail','pending','answer')").run(t.id,thread);
  await t.engine.flushOutbox();assert.equal(t.engine.status().deliveryUncertain,0);
  assert.deepEqual({...diagnostic(t.store,t.row.id)},{delivery_outcome:'not_sent',delivery_stage:'post',delivery_code:'invalid_blocks',http_status:200});
  const reopened=new Store(t.file),e=new Engine(config,reopened,backend,createSlackOutbound(api,config,reopened));
  try{await e.flushOutbox();assert.equal(calls,1);assert.equal(e.status().deliveryUncertain,0);assert.equal(reopened.outputParts(t.id,'answer')[0]?.state,'pending');}finally{e.close();reopened.close();}
 }finally{t.close();}
});
test('timeout, abort, server error, unknown API error and invalid receipt stay unknown without replay',async()=>{
 for(const mode of ['timeout','abort','server','unknown','receipt']){
  let calls=0;const api=createSlackApi('synthetic',async()=>{calls++;if(mode==='timeout'||mode==='abort')throw new DOMException('PRIVATE',mode==='timeout'?'TimeoutError':'AbortError');return mode==='server'?new Response('PRIVATE',{status:503}):new Response(JSON.stringify(mode==='unknown'?{ok:false,error:'PRIVATE_ERROR'}:{ok:true}));});
  const t=fixture(api);try{await t.engine.flushOutbox();await t.engine.flushOutbox();assert.equal(calls,1);assert.equal(t.engine.status().deliveryUncertain,1);const d=diagnostic(t.store,t.row.id);assert.equal(d?.delivery_outcome,'unknown');assert.doesNotMatch(JSON.stringify(d),/PRIVATE/);}finally{t.close();}
 }
});
test('stopping before POST is a definite non-send',async()=>{
 let calls=0;const t=fixture(async()=>{calls++;return {ok:true};},()=>true);
 try{await t.engine.flushOutbox();assert.equal(calls,0);assert.equal(t.engine.status().deliveryUncertain,0);assert.equal(diagnostic(t.store,t.row.id)?.delivery_stage,'prepare');}finally{t.close();}
});
test('receipt is durable before cleanup and remains sent when cleanup fails or restart observes it',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);let cleaning=false;
 const t=fixture(async(method)=>{if(method==='chat.delete'){cleaning=true;await gate;throw Error('PRIVATE');}return {ok:true,ts:'1700000002.000001'};});
 try{
  t.store.db.prepare("INSERT INTO outbox(request_id,thread_id,part,content,nonce,state,discord_message_id,kind) VALUES(?,?,-1,'notice','notice','sent','1700000001.000001','queue_notice')").run(t.id,thread);
  // Mark the answer as the final durable answer so its queue notice is cleaned.
  t.store.db.prepare("UPDATE outbox SET kind='answer',is_last=1 WHERE id=?").run(t.row.id);
  const pending=t.engine.flushOutbox();
  while(!cleaning)await new Promise(r=>setImmediate(r));
  try{assert.equal(t.store.outputParts(t.id,'answer')[0]?.state,'sent');
   const reopened=new Store(t.file);let replay=0;const e=new Engine(config,reopened,backend,{retrySafe:false,send:async()=>{replay++;return 'bad';}});
   try{await e.flushOutbox();assert.equal(replay,0);}finally{e.close();reopened.close();}
  }finally{release();await pending;}
  assert.equal(t.store.deliveryUncertainCount(),0);
 }finally{release?.();t.close();}
});
test('interrupted sending is diagnosed while preexisting uncertainty stays untouched',async()=>{
 const t=fixture(async()=>{throw Error('must not send');});try{
  t.store.markSending(t.row.id);await t.engine.flushOutbox();assert.equal(diagnostic(t.store,t.row.id)?.delivery_code,'interrupted_send');
  const before=JSON.stringify(t.store.db.prepare('SELECT * FROM outbox').all());await t.engine.flushOutbox();assert.equal(JSON.stringify(t.store.db.prepare('SELECT * FROM outbox').all()),before);
 }finally{t.close();}
});
test('channel preflight timeout cannot be mistaken for a POST attempt',async()=>{
 let posts=0;const t=fixture(async()=>({ok:true}));const channel='C12345678',target=channel+':1700000000.000002';
 try{
  t.store.markSending(t.row.id);t.store.markSent(t.row.id,'1700000003.000001');
  t.store.bindThread({threadId:target,parentChannelId:channel,ownerUserId:config.ownerUserId,guildId:config.guildId},'channel-origin');
  t.store.enqueue('channel-q',target,'synthetic');const id=t.store.requestBySource('channel-q')!.id;t.store.addOutput(id,target,['answer']);
  const api=createSlackApi('synthetic',async(_url,options)=>{if(options?.method==='POST')posts++;throw new DOMException('PRIVATE','TimeoutError');});
  const e=new Engine(config,t.store,backend,createSlackOutbound(api,config,t.store,true));
  try{await e.flushOutbox();const row=t.store.outputParts(id,'notice')[0]!;assert.equal(diagnostic(t.store,row.id)?.delivery_outcome,'not_sent');assert.equal(diagnostic(t.store,row.id)?.delivery_stage,'prepare');assert.equal(posts,0);assert.equal(e.status().deliveryFailed,1);}finally{e.close();}
 }finally{t.close();}
});
test('legacy uncertainty is preserved with null diagnostics after reopening',async()=>{
 const t=fixture(async()=>{throw Error('must not send');});try{
  t.store.markSending(t.row.id);t.store.markDeliveryUncertain(t.row.id);
  const old=t.store.db.prepare('SELECT * FROM outbox WHERE id=?').get(t.row.id);
  for(const column of ['delivery_outcome','delivery_stage','delivery_code','http_status','diagnosed_at'])t.store.db.exec('ALTER TABLE outbox DROP COLUMN '+column);
  const reopened=new Store(t.file),e=new Engine(config,reopened,backend,t.engine.outbound);
  try{await e.flushOutbox();assert.deepEqual(reopened.db.prepare('SELECT * FROM outbox WHERE id=?').get(t.row.id),old);assert.equal(e.status().deliveryUncertain,1);}finally{e.close();reopened.close();}
 }finally{t.close();}
});
