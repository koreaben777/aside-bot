import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Store} from '../src/store.js';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readdir,stat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {verifyCreationAbsence,abandonUnsubmittedCreation} from '../src/core/creation-recovery.js';

const createdAt=Date.parse('2026-10-02T07:30:59Z');
const oldList='old_session  idle  persistent  title  2026-09-30T01:47:53.000Z\n';
function fixture(){
 const store=new Store(':memory:');
 store.bindThread({threadId:'thread',guildId:'guild',parentChannelId:'parent',ownerUserId:'owner'},'origin');
 const req=store.enqueue('source','thread','Question');assert.equal(req.kind,'queued');
 const id=store.requestBySource('source')!.id;
 store.startRequest(id);store.transition(id,'running','uncertain','session_creation_unknown');
 store.db.prepare('UPDATE requests SET created_at=? WHERE id=?').run(createdAt,id);
 return {store,id};
}
test('creation recovery accepts only complete inactive lists predating creation',()=>{
 verifyCreationAbsence(oldList,createdAt);verifyCreationAbsence('No sessions.\n',createdAt);
 for(const invalid of ['',oldList+'unexpected row\n',oldList.replace('idle','running'),oldList.replace('idle','queued'),oldList.replace('2026-09-30T01:47:53.000Z','2026-10-02T07:31:00.000Z'),oldList.replace('2026-09-30T01:47:53.000Z','invalid-date')])assert.throws(()=>verifyCreationAbsence(invalid,createdAt));
 assert.throws(()=>verifyCreationAbsence(oldList,NaN));
});
test('operator recovery preserves records, clears the block and allows a fresh question without replay',()=>{
 const {store,id}=fixture();
 try{
  store.addOutput(id,'thread',['existing notice']);const part=store.outbox()[0]!;store.markSending(part.id);store.markSent(part.id,'sent-message');
  abandonUnsubmittedCreation(store.db,id,createdAt);
  assert.equal(store.request(id)?.state,'cancelled');assert.equal(store.request(id)?.errorCode,'operator_abandoned_result_unknown');assert.equal(store.request(id)?.prompt,null);
  assert.equal(store.hasUncertain(),false);assert.equal(store.session('thread')?.blocked,0);assert.equal(store.session('thread')?.backendId,null);
  assert.equal(store.db.prepare('SELECT count(*) n FROM requests').get()?.n,1);
  assert.equal(store.db.prepare('SELECT content FROM outbox WHERE id=?').get(part.id)?.content,'existing notice');
  assert.equal(store.enqueue('fresh','thread','New question').kind,'queued');
 }finally{store.close();}
});
test('recovery refuses bound, non-creation, changed or active requests and pending delivery',()=>{
 for(const condition of ['bound','execution','completed','changed','queued','pending','sending','uncertain-delivery']){
  const {store,id}=fixture();
  try{
   if(condition==='bound')store.db.prepare("UPDATE sessions SET backend_id='bound-session'").run();
   if(condition==='execution')store.db.prepare("UPDATE requests SET error_code='execution_unknown'").run();
   if(condition==='completed')store.db.prepare("UPDATE requests SET state='completed'").run();
   if(condition==='changed')store.db.prepare('UPDATE requests SET created_at=?').run(createdAt+1);
   if(condition==='queued')store.db.prepare("INSERT INTO requests(source_id,thread_id,prompt,state,created_at,updated_at) VALUES('other','thread','Q','queued',1,1)").run();
   if(['pending','sending','uncertain-delivery'].includes(condition)){
    store.addOutput(id,'thread',['pending']);const part=store.outbox()[0]!;
    if(condition!=='pending')store.markSending(part.id);
    if(condition==='uncertain-delivery')store.markDeliveryUncertain(part.id);
   }
   const before=store.request(id)?.state;
   assert.throws(()=>abandonUnsubmittedCreation(store.db,id,createdAt));assert.equal(store.request(id)?.state,before);assert.equal(store.session('thread')?.blocked,1);
  }finally{store.close();}
 }
});
test('recovering one creation request retains other uncertainty and its thread block',()=>{
 const {store,id}=fixture();
 try{
  store.db.prepare("INSERT INTO requests(source_id,thread_id,state,error_code,created_at,updated_at) VALUES('other','thread','uncertain','execution_unknown',1,1)").run();
  abandonUnsubmittedCreation(store.db,id,createdAt);
  assert.equal(store.hasUncertain(),true);assert.equal(store.session('thread')?.blocked,1);assert.equal(store.requestBySource('other')?.state,'uncertain');
 }finally{store.close();}
});

test('operator CLI defaults to read-only, backs up the WAL before applying and refuses backup failure',async()=>{
 for(const backupFails of [false,true]){
  const directory=await mkdtemp(join(tmpdir(),'aside-recovery-cli-')),dataDir=join(directory,'data'),slackDir=join(dataDir,'slack');
  await mkdir(slackDir,{recursive:true});
  const cliPath=join(directory,'aside');
  await writeFile(cliPath,`#!${process.execPath}\nconsole.log(process.argv[2]==='--version'?'1.26.916.1741':'No sessions.');\n`,{mode:0o700});
  await writeFile(join(directory,'config.local.json'),JSON.stringify({ownerUserId:'11111111111111111',guildId:'22222222222222222',channelId:'33333333333333333',applicationId:'44444444444444444',asideAccount:'u0',asideModel:'openai-codex/gpt-6-luna',cliPath,dataDir}));
  await writeFile(join(directory,'config.slack.local.json'),JSON.stringify({ownerUserId:'U12345678',teamId:'T12345678',applicationId:'A12345678'}));
  const store=new Store(join(slackDir,'state.sqlite'));
  store.bindThread({threadId:'thread',guildId:'T12345678',parentChannelId:'owner-dm',ownerUserId:'U12345678'},'origin');
  store.enqueue('source','thread','Question');const id=store.requestBySource('source')!.id;
  store.startRequest(id);store.transition(id,'running','uncertain','session_creation_unknown');
  const run=(apply=false)=>promisify(execFile)(process.execPath,[fileURLToPath(new URL('../scripts/recover-creation.js',import.meta.url)),'slack',String(id),...(apply?['--abandon-unsubmitted']:[])],{cwd:directory,timeout:15_000});
  try{
   assert.equal(JSON.parse((await run()).stdout).applied,false);assert.equal(store.request(id)?.state,'uncertain');
   await assert.rejects(stat(join(slackDir,'recovery')),{code:'ENOENT'});
   if(backupFails){
    await writeFile(join(slackDir,'recovery'),'prevent backup directory');
    await assert.rejects(run(true),(error:unknown)=>String((error as {stderr:string}).stderr).includes('recovery_failed'));
    assert.equal(store.request(id)?.state,'uncertain');assert.equal(store.session('thread')?.blocked,1);
   }else{
    assert.equal(JSON.parse((await run(true)).stdout).applied,true);assert.equal(store.request(id)?.state,'cancelled');
    const backupPath=join(slackDir,'recovery',(await readdir(join(slackDir,'recovery'))).find(name=>name.endsWith('.sqlite'))!);
    assert.equal((await stat(backupPath)).mode&0o777,0o600);
    const saved=new DatabaseSync(backupPath,{readOnly:true});
    try{assert.equal(saved.prepare('SELECT state FROM requests WHERE id=?').get(id)?.state,'uncertain');}finally{saved.close();}
    await assert.rejects(run(true),(error:unknown)=>String((error as {stderr:string}).stderr).includes('recovery_ineligible'));
    assert.equal((await readdir(join(slackDir,'recovery'))).filter(name=>name.endsWith('.sqlite')).length,1);
   }
   await assert.rejects(stat(join(slackDir,'service.lock')),{code:'ENOENT'});
  }finally{store.close();await rm(directory,{recursive:true,force:true});}
 }
});
