import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runQueuedTurn} from '../src/aside/queue.js';
import {ExecutionUncertainError} from '../src/types.js';
const event=(turnId:string,event:string)=>({role:'turn-lifecycle',turnId,event});

test('queue submits once and waits for a new matching started/finished turn, not acknowledgement',async()=>{
 let reads=0,submits=0,clock=0;
 const old=[event('old','started'),event('old','finished')];
 const complete=[...old,event('new','started'),event('new','finished')];
 const result=await runQueuedTurn({
  readMessages:async()=>{reads++;return reads<3?old:reads===3?[...old,event('new','started')]:complete;},
  submit:async()=>{submits++;return 'ok  running';},
  now:()=>clock,pause:async()=>{clock++;},timeoutMs:10,
 });
 assert.deepEqual(result,complete);assert.equal(submits,1);assert.equal(reads,4);
});

test('idle or incomplete queues time out without replaying the request',async()=>{
 let clock=0,submits=0;
 await assert.rejects(runQueuedTurn({readMessages:async()=>[event('old','started'),event('old','finished')],submit:async()=>{submits++;return 'ok  idle';},now:()=>clock,pause:async()=>{clock++;},timeoutMs:3}),e=>e instanceof ExecutionUncertainError&&e.code==='queued_turn_completion_unknown');
 assert.equal(submits,1);
});

test('queue default waits up to 60 minutes, accepting completion after 5 minutes',async()=>{
 for(const finished of [true,false]){
  let clock=0,submits=0;
  const complete=[event('new','started'),event('new','finished')];
  const result=runQueuedTurn({
   readMessages:async()=>clock===0?[]:finished?complete:[event('new','started')],
   submit:async()=>{submits++;},now:()=>clock,
   pause:async()=>{clock+=clock===0?59*60_000:60_000;},
  });
  if(finished)assert.deepEqual(await result,complete);
  else await assert.rejects(result,e=>e instanceof ExecutionUncertainError&&e.code==='queued_turn_completion_unknown');
  assert.equal(clock,(finished?59:60)*60_000);assert.equal(submits,1);
 }
});

test('queue refuses multiple new turns and aborts before submission',async()=>{
 let reads=0;
 await assert.rejects(runQueuedTurn({readMessages:async()=>++reads===1?[]:[event('a','started'),event('b','started'),event('b','finished')],submit:async()=>{},timeoutMs:10}),e=>e instanceof ExecutionUncertainError&&e.code==='multiple_queued_turns');
 const abort=new AbortController();abort.abort();let submits=0;
 await assert.rejects(runQueuedTurn({readMessages:async()=>[],submit:async()=>{submits++;},signal:abort.signal}),e=>e instanceof ExecutionUncertainError&&e.code==='turn_aborted');
 assert.equal(submits,0);
});
