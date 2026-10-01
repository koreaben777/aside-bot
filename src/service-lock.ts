import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmod,link,mkdir,open,readFile,unlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

/** Called under a macOS kernel lock, which cannot be left held by a dead process. */
async function claimLock(dataDir:string,ownerPid:number):Promise<void> {
  const path=join(dataDir,'service.lock');
  let previous:Buffer|undefined;
  try{previous=await readFile(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(previous){
    const text=previous.toString('utf8').trim(),pid=Number(text);
    if(!/^[1-9]\d*$/.test(text)||!Number.isSafeInteger(pid)||pid>2147483647)throw new Error('invalid_service_lock');
    try{process.kill(pid,0);throw new Error('service_already_running');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw new Error('service_already_running');}
    const recovery=join(dataDir,'recovery');
    await mkdir(recovery,{recursive:true,mode:0o700});
    await writeFile(join(recovery,`service.lock.${new Date().toISOString()}.${randomUUID()}.pid-${pid}`),previous,{flag:'wx',mode:0o600});
  }
  if(previous)await unlink(path);
  const temporary=join(dataDir,`service.lock.${randomUUID()}.tmp`);
  const lock=await open(temporary,'wx',0o600);
  try{
    await lock.writeFile(String(ownerPid)+'\n');await lock.sync();
    // Publish only the complete PID; link also refuses to replace an existing lock.
    await link(temporary,path);
  }finally{await lock.close();await unlink(temporary).catch(()=>{});}
}

export async function acquireServiceLock(dataDir:string):Promise<()=>Promise<void>> {
  const path=join(dataDir,'service.lock'),guard=join(dataDir,'service.lock.guard');
  try{
    // Keep this inode: unlinking a kernel lock file would let two callers lock different files.
    await promisify(execFile)('/usr/bin/lockf',['-k','-s','-t','0',guard,process.execPath,fileURLToPath(import.meta.url),dataDir,String(process.pid)],{timeout:10_000});
    await chmod(guard,0o600);
  }catch(error){
    const failure=error as {code?:unknown;stderr?:string};
    const reason=failure.stderr?.trim();
    throw new Error(failure.code===75?'service_already_running':reason==='service_already_running'||reason==='invalid_service_lock'?reason:'service_lock_unavailable');
  }
  return async()=>{
    try{if((await readFile(path,'utf8')).trim()===String(process.pid))await unlink(path);}catch{/* Never remove a replacement or an unreadable lock. */}
  };
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  process.umask(0o077);
  const dataDir=process.argv[2],pid=Number(process.argv[3]);
  try{
    if(!dataDir||!Number.isSafeInteger(pid)||pid<1||pid>2147483647)throw new Error('service_lock_unavailable');
    process.kill(pid,0);
    await claimLock(dataDir,pid);
  }catch(error){
    const reason=error instanceof Error?error.message:'';
    console.error(['service_already_running','invalid_service_lock'].includes(reason)?reason:'service_lock_unavailable');
    process.exitCode=1;
  }
}
