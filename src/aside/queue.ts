import {setTimeout as delay} from 'node:timers/promises';
import {ExecutionUncertainError} from '../types.js';

type Obj=Record<string,unknown>;
const obj=(v:unknown):v is Obj=>!!v&&typeof v==='object'&&!Array.isArray(v);
function rows(value:unknown):Obj[]{
 if(!Array.isArray(value)||value.some(v=>!obj(v)))throw new ExecutionUncertainError('invalid_queue_transcript');
 return value as Obj[];
}
interface QueueTurnOptions {
 readMessages:()=>Promise<unknown>;
 submit:()=>Promise<unknown>;
 signal?:AbortSignal;
 timeoutMs?:number;
 pollMs?:number;
 now?:()=>number;
 pause?:(ms:number)=>Promise<unknown>;
}

/** Queue acknowledgement is NOT completion. Submit once, then require a fresh
 * matching started/finished turn in the supported session transcript. */
export async function runQueuedTurn(options:QueueTurnOptions):Promise<unknown>{
 const now=options.now??Date.now;
 const pause=options.pause??delay;
 const baseline=rows(await options.readMessages());
 const prior=new Set(baseline.filter(m=>m.role==='turn-lifecycle'&&typeof m.turnId==='string').map(m=>m.turnId));
 const checkAbort=()=>{if(options.signal?.aborted)throw new ExecutionUncertainError('turn_aborted');};
 checkAbort();
 const deadline=now()+(options.timeoutMs??60*60_000);
 await options.submit();
 while(now()<deadline){
  checkAbort();
  const current=rows(await options.readMessages());
  const fresh=current.filter(m=>m.role==='turn-lifecycle'&&typeof m.turnId==='string'&&!prior.has(m.turnId));
  const started=new Set(fresh.filter(m=>m.event==='started').map(m=>m.turnId));
  if(started.size>1)throw new ExecutionUncertainError('multiple_queued_turns');
  const finished=new Set(fresh.filter(m=>m.event==='finished'&&started.has(m.turnId)).map(m=>m.turnId));
  if(finished.size===1){checkAbort();return current;}
  await pause(options.pollMs??1000);
 }
 throw new ExecutionUncertainError('queued_turn_completion_unknown');
}
