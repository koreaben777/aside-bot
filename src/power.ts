import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';

export function createSleepController():{set(enabled:boolean):Promise<boolean>;active():boolean;close():Promise<void>}{
 let child:ChildProcess|undefined,exit:Promise<void>|undefined,closed=false,chain=Promise.resolve(false);
 const set=(enabled:boolean):Promise<boolean>=>{
  chain=chain.catch(()=>false).then(async()=>{
   if(child&&(child.exitCode!==null||child.signalCode!==null)){await exit;child=undefined;}
   if(!enabled||closed){if(child){child.kill('SIGTERM');await exit;child=undefined;}return false;}
   if(child)return true;
   const spawned=spawn('/usr/bin/caffeinate',['-i','-w',String(process.pid)],{stdio:'ignore'});child=spawned;
   exit=new Promise(resolve=>{spawned.once('close',()=>{if(child===spawned)child=undefined;resolve();});});
   try{await once(spawned,'spawn');}catch{await exit;child=undefined;return false;}
   return spawned.exitCode===null&&spawned.signalCode===null;
  });return chain;
 };
 return {set,active:()=>!!child&&child.exitCode===null&&child.signalCode===null,async close(){closed=true;await set(false);}};
}
export async function preventIdleSleep():Promise<()=>Promise<void>>{
 const controller=createSleepController();if(!await controller.set(true))throw Error('sleep_unavailable');return ()=>controller.close();
}
