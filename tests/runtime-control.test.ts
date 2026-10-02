import {test} from 'node:test';
import assert from 'node:assert/strict';
import {connect, type Socket} from 'node:net';
import {mkdtemp,mkdir,rm,symlink,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {acquireServiceLock} from '../src/service-lock.js';

async function api(){return await import('../src/runtime-control.js');}
function exchange(socket:Socket,request:unknown):Promise<any>{return new Promise((resolve,reject)=>{
 let data='';const timer=setTimeout(()=>{cleanup();reject(Error('reply timeout'));},2000);
 const cleanup=()=>{clearTimeout(timer);socket.off('data',read);socket.off('error',fail);};
 const fail=(e:Error)=>{cleanup();reject(e);};
 const read=(chunk:Buffer)=>{data+=chunk.toString();if(data.includes('\n')){cleanup();resolve(JSON.parse(data.split('\n')[0]!));}};
 socket.on('data',read);socket.once('error',fail);socket.write(JSON.stringify(request)+'\n');
});}
async function until(check:()=>boolean){for(let i=0;i<100;i++){if(check())return;await delay(10);}assert.fail('condition timed out');}
test('control authenticates exactly one owner, validates requests, and shuts down on owner loss',async()=>{
 const {startRuntimeControl}=await api();const dir=await mkdtemp('/tmp/ac-');const release=await acquireServiceLock(dir);
 let stops=0,sleep=false;const token='a'.repeat(64);
 const control=await startRuntimeControl({dataDir:dir,platform:'discord',ownerToken:token,initialSleep:true,setSleep:async enabled=>sleep=enabled,shutdown:async()=>{stops++;}});
 const sockets=[connect(join(dir,'control.sock')),connect(join(dir,'control.sock')),connect(join(dir,'control.sock'))];
 try{
  const [observer,owner,other]=sockets as [Socket,Socket,Socket];
  const status=await exchange(observer,{v:1,id:'a',op:'status'});assert.equal(status.ok,true);const instanceId=status.status.instanceId;
  assert.equal((await stat(join(dir,'control.sock'))).mode&0o777,0o600);
  assert.equal((await exchange(observer,{v:1,id:'b',op:'shutdown',instanceId})).code,'not_owner');
  assert.equal((await exchange(owner,{v:1,id:'bad',op:'claim',instanceId,token:'b'.repeat(64)})).code,'invalid_owner');
  assert.equal((await exchange(owner,{v:1,id:'old',op:'claim',instanceId:'old',token})).code,'instance_mismatch');
  assert.equal((await exchange(owner,{v:1,id:'c',op:'claim',instanceId,token})).ok,true);await control.waitForOwner();assert.equal(sleep,true);
  assert.equal((await exchange(other,{v:1,id:'d',op:'claim',instanceId,token})).code,'owner_exists');
  assert.equal((await exchange(owner,{v:1,id:'e',op:'setSleep',instanceId,enabled:false})).status.sleepActive,false);
  assert.equal((await exchange(observer,{v:1,id:'f',op:'status',extra:true})).code,'invalid_request');
  assert.equal((await exchange(observer,{v:1,id:'g',op:'status',padding:'x'.repeat(17000)})).code,'invalid_request');
  other.destroy();await delay(20);assert.equal(stops,0);owner.destroy();await until(()=>stops===1);
 }finally{for(const s of sockets)s.destroy();await control.close();await release();await rm(dir,{recursive:true,force:true});}
});
test('control refuses unsafe sockets and long paths and standalone ownership',async()=>{
 const {startRuntimeControl}=await api();const dir=await mkdtemp('/tmp/ac-');const release=await acquireServiceLock(dir);
 const opts={dataDir:dir,platform:'slack' as const,initialSleep:false,setSleep:async()=>false,shutdown:async()=>{}};
 try{
  await writeFile(join(dir,'target'),'keep');await symlink(join(dir,'target'),join(dir,'control.sock'));
  await assert.rejects(startRuntimeControl(opts),/control_unavailable/);await rm(join(dir,'control.sock'));
  await mkdir(join(dir,'x'.repeat(110)));await assert.rejects(startRuntimeControl({...opts,dataDir:join(dir,'x'.repeat(110))}),/socket_path_too_long/);
  const c=await startRuntimeControl(opts);const s=connect(join(dir,'control.sock'));
  try{const r=await exchange(s,{v:1,id:'a',op:'status'});assert.equal((await exchange(s,{v:1,id:'b',op:'claim',instanceId:r.status.instanceId,token:'a'.repeat(64)})).code,'invalid_owner');await c.waitForOwner();}finally{s.destroy();await c.close();}
 }finally{await release();await rm(dir,{recursive:true,force:true});}
});

test('unclaimed managed control times out once without enabling sleep',async()=>{
 const {startRuntimeControl}=await api();const dir=await mkdtemp('/tmp/ac-');const release=await acquireServiceLock(dir);let stops=0,sleeps=0;
 const c=await startRuntimeControl({dataDir:dir,platform:'slack',ownerToken:'c'.repeat(64),initialSleep:true,setSleep:async()=>{sleeps++;return true;},shutdown:async()=>{stops++;}});
 try{await assert.rejects(c.waitForOwner(),/owner_timeout/);assert.equal(stops,1);assert.equal(sleeps,0);}finally{await c.close();await release();await rm(dir,{recursive:true,force:true});}
});
