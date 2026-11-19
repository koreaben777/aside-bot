import {randomUUID} from 'node:crypto';
import {chmod,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync,backup} from 'node:sqlite';
import {loadConfig} from '../src/config.js';
import {loadSlackConfig} from '../src/slack/config.js';
import {ACCOUNT,CLI_VERSION,runAsideCli} from '../src/aside/backend.js';
import {acquireServiceLock} from '../src/service-lock.js';
import {inspectUnsubmittedCreation,verifyCreationAbsence,abandonUnsubmittedCreation} from '../src/core/creation-recovery.js';

process.umask(0o077);
let unlock:(()=>Promise<void>)|undefined,db:DatabaseSync|undefined;
try{
 const args=process.argv.slice(2);
 const platform=args[0],requestId=Number(args[1]);
 const apply=args[2]==='--abandon-unsubmitted';
 if(!['slack','discord'].includes(platform??'')||!Number.isSafeInteger(requestId)||requestId<1||args.length>(apply?3:2))throw Error('recovery_usage');
 const config=platform==='slack'?await loadSlackConfig():await loadConfig();
 if(config.asideAccount!==ACCOUNT)throw Error('config_invalid');
 // Dry run is read-only. Applying claims the same lock as the server, refusing
 // a running service and preventing a restart during proof/backup/transaction.
 if(apply)unlock=await acquireServiceLock(config.dataDir);
 const path=join(config.dataDir,'state.sqlite');
 db=new DatabaseSync(path,{readOnly:true});
 const target=inspectUnsubmittedCreation(db,requestId);
 if((await runAsideCli(config.cliPath,['--version'],10_000)).trim()!==CLI_VERSION)throw Error('cli_version_mismatch');
 verifyCreationAbsence(await runAsideCli(config.cliPath,['session','list','--account',ACCOUNT],30_000),target.createdAt);
 if(!apply){
  console.log(JSON.stringify({platform,requestId,eligible:true,applied:false,next:'Stop the menu app, then rerun with --abandon-unsubmitted. The previous result will remain unknown.'}));
 }else{
  const directory=join(config.dataDir,'recovery');await mkdir(directory,{recursive:true,mode:0o700});
  const backupPath=join(directory,`creation-${requestId}-${randomUUID()}.sqlite`);
  await backup(db,backupPath);await chmod(backupPath,0o600);db.close();db=undefined;
  db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  abandonUnsubmittedCreation(db,requestId,target.createdAt);
  console.log(JSON.stringify({platform,requestId,applied:true,state:'cancelled',code:'operator_abandoned_result_unknown',backupPath}));
 }
}catch(error){
 const code=error instanceof Error?error.message:'';
 const known=['recovery_usage','config_invalid','recovery_ineligible','recovery_not_idle','recovery_target_changed','invalid_recovery_time','creation_absence_unconfirmed','cli_version_mismatch','service_already_running','invalid_service_lock','service_lock_unavailable'];
 console.error(known.includes(code)?code:'recovery_failed');
 if(code==='recovery_usage')console.error('Usage: node dist/scripts/recover-creation.js slack|discord REQUEST_ID [--abandon-unsubmitted]');
 process.exitCode=1;
}finally{db?.close();await unlock?.();}
