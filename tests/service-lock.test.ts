import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {acquireServiceLock} from '../src/service-lock.js';
import {pathToFileURL} from 'node:url';
import {once} from 'node:events';

test('service lock preserves stale evidence, refuses live or malformed locks, and releases only its own',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'aside-lock-')),path=join(dir,'service.lock');
 try{
  const release=await acquireServiceLock(dir);
  assert.equal((await readFile(path,'utf8')).trim(),String(process.pid));
  await assert.rejects(acquireServiceLock(dir),/service_already_running/);
  await release();await assert.rejects(readFile(path),{code:'ENOENT'});

  const {stdout}=await promisify(execFile)(process.execPath,['-e','console.log(process.pid)']);
  const deadPid=Number(stdout.trim());assert.throws(()=>process.kill(deadPid,0),{code:'ESRCH'});
  await writeFile(path,stdout);
  const recovered=await acquireServiceLock(dir);
  const saved=await readdir(join(dir,'recovery'));assert.equal(saved.length,1);
  assert.equal(await readFile(join(dir,'recovery',saved[0]!),'utf8'),stdout);
  await recovered();

  await writeFile(path,'unknown\n');await assert.rejects(acquireServiceLock(dir),/invalid_service_lock/);
  assert.equal(await readFile(path,'utf8'),'unknown\n');
  await rm(path);

  const own=await acquireServiceLock(dir);await writeFile(path,'123\n');await own();
  assert.equal(await readFile(path,'utf8'),'123\n');
  await rm(path);
  const concurrent=await Promise.allSettled([acquireServiceLock(dir),acquireServiceLock(dir)]);
  assert.equal(concurrent.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(concurrent.filter(result=>result.status==='rejected').length,1);
  for(const result of concurrent)if(result.status==='fulfilled')await result.value();
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a force-killed lock owner can be restarted repeatedly without manual cleanup',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'aside-lock-owner-crash-'));
 const moduleUrl=new URL('../src/service-lock.js',import.meta.url).href;
 try{
  for(let cycle=0;cycle<2;cycle++){
   const child=spawn(process.execPath,['--input-type=module','-e',`import {acquireServiceLock} from ${JSON.stringify(moduleUrl)};await acquireServiceLock(${JSON.stringify(dir)});console.log('READY');setInterval(()=>{},1000);`],{stdio:['ignore','pipe','pipe']});
   const exited=once(child,'exit');
   try{
    const [output]=await once(child.stdout,'data',{signal:AbortSignal.timeout(10_000)});
    assert.equal(output.toString().trim(),'READY');
    await assert.rejects(acquireServiceLock(dir),/service_already_running/);
    child.kill('SIGKILL');await exited;
    const release=await acquireServiceLock(dir);await release();
    assert.equal((await readdir(join(dir,'recovery'))).length,cycle+1);
   }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('interruption while writing a lock never publishes an empty service lock',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'aside-lock-write-crash-'));
 const preload=join(dir,'interrupt.mjs');
 try{
  await writeFile(preload,`import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';const original=fs.open;fs.open=async(...args)=>{const handle=await original(...args);handle.writeFile=async()=>process.exit(88);return handle;};syncBuiltinESMExports();`);
  const moduleUrl=new URL('../src/service-lock.js',import.meta.url).href;
  await assert.rejects(promisify(execFile)(process.execPath,['--input-type=module','-e',`import {acquireServiceLock} from ${JSON.stringify(moduleUrl)};await acquireServiceLock(${JSON.stringify(dir)});`],{
   env:{...process.env,NODE_OPTIONS:[process.env.NODE_OPTIONS,`--import=${pathToFileURL(preload).href}`].filter(Boolean).join(' ')},timeout:10_000,
  }));
  await assert.rejects(readFile(join(dir,'service.lock')),{code:'ENOENT'});
  const release=await acquireServiceLock(dir);await release();
 }finally{await rm(dir,{recursive:true,force:true});}
});
