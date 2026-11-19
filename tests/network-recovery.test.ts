import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Engine} from '../src/core/engine.js';
import {Store} from '../src/store.js';
import {runQueuedTurn} from '../src/aside/queue.js';
import {BackendFailureError,ExecutionUncertainError,type Backend} from '../src/types.js';

test('offline transport holds unstarted questions and unsent Slack answers until reconnect',async()=>{
 const store=new Store(':memory:');store.bindThread({threadId:'thread',guildId:'guild',parentChannelId:'parent',ownerUserId:'owner'},'origin');
 let runs=0,sends=0;
 const backend:Backend={health:async()=>{},createSession:async()=> 'session',runTurn:async()=>{runs++;return {text:'answer'};},stop:async()=>({confirmed:true})};
 const engine=new Engine({ownerUserId:'owner',guildId:'guild',channelId:'parent'},store,backend,{retrySafe:false,progressNotices:false,send:async()=>{sends++;return 'message';}});
 try{
  engine.setConnected(false);
  engine.submit({sourceId:'question',channelId:'thread',userId:'owner',guildId:'guild',content:'question'},{publishQueueNotice:true});
  await engine.waitForIdle();
  assert.equal(store.requestBySource('question')?.state,'queued');assert.equal(runs,0);assert.equal(sends,0);
  engine.setConnected(true);await engine.waitForIdle();
  assert.equal(store.requestBySource('question')?.state,'completed');assert.equal(runs,1);assert.equal(sends,2);assert.equal(store.deliveryUncertainCount(),0);
 }finally{engine.close();await engine.waitForIdle();store.close();}
});

test('completed answer stays pending when the transport drops during model execution',async()=>{
 const store=new Store(':memory:');store.bindThread({threadId:'thread',guildId:'guild',parentChannelId:'parent',ownerUserId:'owner'},'origin');
 let finish!:(answer:{text:string})=>void,sends=0;
 const backend:Backend={health:async()=>{},createSession:async()=> 'session',runTurn:()=>new Promise(resolve=>{finish=resolve;}),stop:async()=>({confirmed:true})};
 const engine=new Engine({ownerUserId:'owner',guildId:'guild',channelId:'parent'},store,backend,{retrySafe:false,progressNotices:false,send:async()=>{sends++;throw Error('offline');}});
 try{
  engine.submit({sourceId:'question',channelId:'thread',userId:'owner',guildId:'guild',content:'question'});
  for(let n=0;n<20&&!finish;n++)await new Promise(resolve=>setImmediate(resolve));
  assert.ok(finish);engine.setConnected(false);finish({text:'answer'});await engine.waitForIdle();
  assert.equal(store.requestBySource('question')?.state,'completed');assert.equal(sends,0);assert.equal(store.outputParts(1,'answer')[0]?.state,'pending');
  engine.outbound.send=async()=>{sends++;return 'delivered';};engine.setConnected(true);await engine.waitForIdle();
  assert.equal(sends,1);assert.equal(store.outputParts(1,'answer')[0]?.state,'sent');
 }finally{engine.close();await engine.waitForIdle();store.close();}
});

test('disconnect during health or session creation preserves the unsubmitted question until reconnect',async()=>{
 for(const phase of ['health','creating']){
  const store=new Store(':memory:');store.bindThread({threadId:'thread',guildId:'guild',parentChannelId:'parent',ownerUserId:'owner'},'origin');
  let release!:()=>void,reads=0,creates=0,runs=0;
  const hold=()=>new Promise<void>(resolve=>{release=resolve;});
  const backend:Backend={health:async()=>{if(phase==='health'&&++reads===1)await hold();},createSession:async()=>{creates++;if(phase==='creating')await hold();return 'session';},runTurn:async()=>{runs++;return {text:'answer'};},stop:async()=>({confirmed:true})};
  const engine=new Engine({ownerUserId:'owner',guildId:'guild',channelId:'parent'},store,backend,{progressNotices:false,send:async()=> 'message'});
  try{
   engine.submit({sourceId:'question',channelId:'thread',userId:'owner',guildId:'guild',content:'keep this question'});
   for(let n=0;n<20&&!release;n++)await new Promise(resolve=>setImmediate(resolve));
   assert.ok(release);engine.setConnected(false);release();await engine.waitForIdle();
   assert.equal(runs,0);assert.equal(store.requestBySource('question')?.state,'queued');assert.equal(store.requestBySource('question')?.prompt,'keep this question');
   engine.setConnected(true);await engine.waitForIdle();
   assert.equal(runs,1);assert.equal(creates,1);assert.equal(store.requestBySource('question')?.state,'completed');
  }finally{engine.close();await engine.waitForIdle();store.close();}
 }
});

test('a known unsubmitted disconnect during adapter preflight returns the question to the queue',async()=>{
 const store=new Store(':memory:');store.bindThread({threadId:'thread',guildId:'guild',parentChannelId:'parent',ownerUserId:'owner'},'origin');
 let release!:()=>void,attempts=0,submits=0;
 const backend:Backend={health:async()=>{},createSession:async()=> 'session',runTurn:async(_id,_prompt,_signal,_selection,_options,canSubmit)=>{
  if(++attempts===1)await new Promise<void>(resolve=>{release=resolve;});
  if(canSubmit&&!canSubmit())throw new BackendFailureError('transport_disconnected');
  submits++;return {text:'answer'};
 },stop:async()=>({confirmed:true})};
 const engine=new Engine({ownerUserId:'owner',guildId:'guild',channelId:'parent'},store,backend,{progressNotices:false,send:async()=> 'message'});
 try{
  engine.submit({sourceId:'question',channelId:'thread',userId:'owner',guildId:'guild',content:'question'});
  for(let n=0;n<20&&!release;n++)await new Promise(resolve=>setImmediate(resolve));
  assert.ok(release);engine.setConnected(false);release();await engine.waitForIdle();
  assert.equal(store.requestBySource('question')?.state,'queued');assert.equal(submits,0);
  engine.setConnected(true);await engine.waitForIdle();
  assert.equal(submits,1);assert.equal(store.requestBySource('question')?.state,'completed');
 }finally{engine.close();await engine.waitForIdle();store.close();}
});

test('lost queue acknowledgement and intermittent reads recover the same submitted turn without replay',async()=>{
 let clock=0,reads=0,submits=0;
 const messages=[{role:'turn-lifecycle',turnId:'new',event:'started'},{role:'turn-lifecycle',turnId:'new',event:'finished'}];
 const result=await runQueuedTurn({
  readMessages:async()=>{reads++;if(reads===1)return [];if(reads<4)throw new ExecutionUncertainError('cli_execution_unknown');return messages;},
  submit:async()=>{submits++;throw new ExecutionUncertainError('cli_execution_unknown');},
  now:()=>clock,pause:async ms=>{clock+=ms;},timeoutMs:60_000,
 });
 assert.deepEqual(result,messages);assert.equal(submits,1);assert.equal(reads,4);
});

test('transport retries remain bounded and invalid transcripts are never retried as connectivity failures',async()=>{
 let clock=0,reads=0,submits=0;
 await assert.rejects(runQueuedTurn({readMessages:async()=>{if(++reads===1)return [];throw new ExecutionUncertainError('cli_execution_unknown');},submit:async()=>{submits++;},now:()=>clock,pause:async ms=>{clock+=ms;},timeoutMs:15_000}),e=>e instanceof ExecutionUncertainError&&e.code==='queued_turn_completion_unknown');
 assert.equal(submits,1);assert.ok(reads>2);
 reads=0;
 await assert.rejects(runQueuedTurn({readMessages:async()=>++reads===1?[]:{invalid:true},submit:async()=>{},timeoutMs:1000}),e=>e instanceof ExecutionUncertainError&&e.code==='invalid_queue_transcript');
 assert.equal(reads,2);
});
