import {createServer,connect,type Socket} from 'node:net';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {chmod,lstat,realpath,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createInterface} from 'node:readline';

export type Platform='discord'|'slack';
export type Phase='starting'|'connected'|'reconnecting'|'stopping'|'error';
export const STAGES=['bootstrap','config','lock','owner','keychain','aside','platform','preflight','engine','shutdown'] as const;
export const ERROR_CODES=['invalid_request','not_owner','owner_exists','invalid_owner','instance_mismatch','socket_path_too_long','control_unavailable','owner_timeout','config_invalid','keychain_unavailable','aside_unavailable','platform_unavailable','preflight_failed','service_already_running','invalid_service_lock','sleep_unavailable','shutdown_pending'] as const;
export type Snapshot={v:1;platform:Platform;instanceId:string;pid:number;phase:Phase;stage:string;errorCode:string|null;preflightPassed:boolean;engineStarted:boolean;sleepDesired:boolean;sleepActive:boolean;asideHealth:{state:'unchecked'|'ok'|'error';checkedAt:string|null}};
export type Request={v:1;id:string;op:'status'}|{v:1;id:string;op:'claim';instanceId:string;token:string}|{v:1;id:string;op:'setSleep';instanceId:string;enabled:boolean}|{v:1;id:string;op:'shutdown';instanceId:string};
export type Reply={v:1;id:string;ok:boolean;code:string|null;status:Snapshot};
export type RuntimeControl={publish(patch:Partial<Omit<Snapshot,'v'|'platform'|'instanceId'|'pid'>>):void;waitForOwner():Promise<void>;close():Promise<void>};
export function reduceConnection(previous:Phase,event:'ready'|'reconnecting'|'closed'|'fatal'|'stop',prepared:boolean):Phase{
 if(previous==='stopping'||event==='stop')return 'stopping';
 if(event==='fatal')return 'error';
 if(event==='ready')return prepared?'connected':'starting';
 return 'reconnecting';
}
export async function readManagedBootstrap():Promise<{token?:string;sleepEnabled:boolean}>{
 if(process.env.ASIDE_MENU_MANAGED!=='1')return {sleepEnabled:true};
 const input=createInterface({input:process.stdin});
 try{return await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>finish(),10_000);let bytes=0;
  const finish=(line?:string)=>{clearTimeout(timer);try{
   const v=line?JSON.parse(line):null;
   if(!v||Object.keys(v).sort().join(',')!=='sleepEnabled,token,v'||v.v!==1||typeof v.sleepEnabled!=='boolean'||typeof v.token!=='string'||!/^[a-f0-9]{64}$/.test(v.token))throw Error();
   resolve({token:v.token,sleepEnabled:v.sleepEnabled});
  }catch{reject(Error('invalid_owner'));}};
  input.once('line',finish);input.once('close',()=>finish());
  process.stdin.on('data',count);function count(b:Buffer){bytes+=b.length;if(bytes>16384){process.stdin.off('data',count);finish();input.close();}}
  input.once('close',()=>process.stdin.off('data',count));
 });}finally{input.close();process.stdin.pause();}
}
function valid(value:unknown):value is Request{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const r=value as Record<string,unknown>;
 if(r.v!==1||typeof r.id!=='string'||!r.id.length||r.id.length>64||/[\r\n]/.test(r.id))return false;
 const fields:Record<string,string[]>={status:['v','id','op'],claim:['v','id','op','instanceId','token'],setSleep:['v','id','op','instanceId','enabled'],shutdown:['v','id','op','instanceId']};
 const keys=typeof r.op==='string'?fields[r.op]:undefined;
 return !!keys&&Object.keys(r).length===keys.length&&Object.keys(r).every(k=>keys.includes(k))&&(r.op==='status'||typeof r.instanceId==='string'&&r.instanceId.length<=64)&&(r.op!=='claim'||typeof r.token==='string'&&/^[a-f0-9]{64}$/.test(r.token))&&(r.op!=='setSleep'||typeof r.enabled==='boolean');
}
export async function startRuntimeControl(options:{dataDir:string;platform:Platform;ownerToken?:string;initialSleep:boolean;setSleep:(enabled:boolean)=>Promise<boolean>;shutdown:()=>Promise<void>;sleepActive?:()=>boolean;beforeStatus?:()=>void}):Promise<RuntimeControl>{
 // Main must hold the existing service lock before calling this function.
 const dir=await realpath(options.dataDir),path=join(dir,'control.sock');
 if(Buffer.byteLength(path)>103)throw Error('socket_path_too_long');
 const parent=await lstat(dir);if(parent.uid!==process.getuid?.()||!parent.isDirectory())throw Error('control_unavailable');
 await chmod(dir,0o700);
 const previous=await lstat(path).catch(e=>{if(e.code!=='ENOENT')throw Error('control_unavailable');return null;});
 if(previous){
  if(!previous.isSocket()||previous.uid!==process.getuid?.())throw Error('control_unavailable');
  const stale=await new Promise<boolean>(resolve=>{const s=connect(path);s.once('connect',()=>{s.destroy();resolve(false);});s.once('error',(e:NodeJS.ErrnoException)=>resolve(e.code==='ECONNREFUSED'||e.code==='ENOENT'));s.setTimeout(500,()=>{s.destroy();resolve(false);});});
  if(!stale)throw Error('control_unavailable');await unlink(path);
 }
 const status:Snapshot={v:1,platform:options.platform,instanceId:randomUUID(),pid:process.pid,phase:'starting',stage:'owner',errorCode:null,preflightPassed:false,engineStarted:false,sleepDesired:options.initialSleep,sleepActive:false,asideHealth:{state:'unchecked',checkedAt:null}};
 let owner:Socket|undefined,closed=false,shutdownCalled=false,ownerReady=false;
 const sockets=new Set<Socket>();let resolveOwner!:()=>void,rejectOwner!:(e:Error)=>void;
 const ready=options.ownerToken?new Promise<void>((resolve,reject)=>{resolveOwner=resolve;rejectOwner=reject;}):Promise.resolve();void ready.catch(()=>{});
 const requestShutdown=()=>{if(closed||shutdownCalled)return;shutdownCalled=true;status.phase='stopping';status.stage='shutdown';rejectOwner?.(Error('owner_timeout'));void options.shutdown().catch(()=>{status.errorCode='shutdown_pending';});};
 const timer=options.ownerToken?setTimeout(()=>{status.errorCode='owner_timeout';requestShutdown();},10_000):undefined;
 const reply=(s:Socket,id:string,code:string|null)=>{
  options.beforeStatus?.();if(options.sleepActive)status.sleepActive=options.sleepActive();
  if(status.sleepDesired&&!status.sleepActive&&ownerReady)status.errorCode??='sleep_unavailable';
  if(!s.destroyed)s.write(JSON.stringify({v:1,id,ok:code===null,code,status})+'\n');
 };
 const handle=async(s:Socket,value:unknown)=>{
  if(!valid(value)){reply(s,'','invalid_request');return;}
  const r=value;if(r.op==='status'){reply(s,r.id,null);return;}
  if(r.instanceId!==status.instanceId){reply(s,r.id,'instance_mismatch');return;}
  if(r.op==='claim'){
   if(owner){reply(s,r.id,'owner_exists');return;}
   if(!options.ownerToken||!timingSafeEqual(Buffer.from(r.token),Buffer.from(options.ownerToken))){reply(s,r.id,'invalid_owner');return;}
   owner=s;clearTimeout(timer);
   try{status.sleepActive=await options.setSleep(status.sleepDesired);ownerReady=true;if(s.destroyed||closed)return;resolveOwner();reply(s,r.id,status.sleepDesired&&!status.sleepActive?'sleep_unavailable':null);}catch{status.errorCode='sleep_unavailable';rejectOwner(Error('sleep_unavailable'));reply(s,r.id,'sleep_unavailable');requestShutdown();}
   return;
  }
  if(s!==owner||!ownerReady){reply(s,r.id,'not_owner');return;}
  if(r.op==='setSleep'){
   status.sleepDesired=r.enabled;
   try{status.sleepActive=await options.setSleep(r.enabled);const ok=status.sleepActive===r.enabled;status.errorCode=ok?null:'sleep_unavailable';reply(s,r.id,ok?null:'sleep_unavailable');}catch{status.errorCode='sleep_unavailable';reply(s,r.id,'sleep_unavailable');}
  }else{reply(s,r.id,null);requestShutdown();}
 };
 const server=createServer(s=>{
  sockets.add(s);let buffer=Buffer.alloc(0),chain=Promise.resolve();
  s.on('error',()=>{});s.on('close',()=>{sockets.delete(s);if(s===owner)requestShutdown();});
  s.on('data',chunk=>{
   buffer=Buffer.concat([buffer,chunk]);
   if(buffer.length>16384){reply(s,'','invalid_request');s.end();buffer=Buffer.alloc(0);return;}
   let end:number;while((end=buffer.indexOf(10))>=0){const line=buffer.subarray(0,end);buffer=buffer.subarray(end+1);let r:unknown=null;
    if(line.length<=16384)try{r=JSON.parse(line.toString('utf8'));}catch{}
    chain=chain.then(()=>handle(s,r)).catch(()=>reply(s,'','invalid_request'));
   }
   if(buffer.length>16384){reply(s,'','invalid_request');s.end();buffer=Buffer.alloc(0);}
  });
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve);}).catch(()=>{clearTimeout(timer);throw Error('control_unavailable');});
 await chmod(path,0o600);const inode=(await lstat(path)).ino;
 return {publish(patch){if(closed)return;const stopping=status.phase==='stopping';Object.assign(status,patch);if(stopping)status.phase='stopping';if(!STAGES.includes(status.stage as typeof STAGES[number]))status.stage='bootstrap';if(status.errorCode&&!ERROR_CODES.includes(status.errorCode as typeof ERROR_CODES[number]))status.errorCode='control_unavailable';if(status.phase==='connected'&&(!status.preflightPassed||!status.engineStarted))status.phase='starting';},waitForOwner:()=>ready,async close(){if(closed)return;closed=true;clearTimeout(timer);rejectOwner?.(Error('control_unavailable'));for(const s of sockets)s.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));if((await lstat(path).catch(()=>null))?.ino===inode)await unlink(path);}};
}
