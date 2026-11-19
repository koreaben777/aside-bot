import type {DatabaseSync} from 'node:sqlite';

/** Operator recovery only: no surviving session may have changed since creation.
 * Unlike the adapter's discovery parser, reject incomplete/unknown list rows. */
export function verifyCreationAbsence(stdout:string,createdAt:number):void {
 if(!Number.isSafeInteger(createdAt)||createdAt<=0)throw Error('invalid_recovery_time');
 if(stdout.trim()==='No sessions.')return;
 const lines=stdout.trimEnd().split(/\r?\n/);
 const seen=new Set<string>();
 for(const line of lines){
  const match=/^([A-Za-z0-9_-]{6,128})  (idle|interrupted|aborted)  (ephemeral|persistent)  [^\r\n]*  (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/.exec(line);
  if(!match||seen.has(match[1]!))throw Error('creation_absence_unconfirmed');
  seen.add(match[1]!);
  const time=Date.parse(match[4]!);
  // Allow for timestamp precision; a near-concurrent session is not evidence.
  if(!Number.isFinite(time)||new Date(time).toISOString()!==match[4]||time>=createdAt-60_000)throw Error('creation_absence_unconfirmed');
 }
}

export function inspectUnsubmittedCreation(db:DatabaseSync,requestId:number):{threadId:string;createdAt:number} {
 const row=db.prepare(`SELECT r.thread_id,r.created_at FROM requests r JOIN sessions s ON s.thread_id=r.thread_id
  WHERE r.id=? AND r.state='uncertain' AND r.error_code='session_creation_unknown' AND s.backend_id IS NULL AND s.blocked=1`).get(requestId);
 if(!row)throw Error('recovery_ineligible');
 if(db.prepare("SELECT 1 FROM requests WHERE state IN ('queued','running','cancel_requested') LIMIT 1").get()
  ||db.prepare("SELECT 1 FROM outbox WHERE state!='sent' LIMIT 1").get())throw Error('recovery_not_idle');
 return {threadId:String(row.thread_id),createdAt:Number(row.created_at)};
}

/** Call only under the service lock after a private backup and fresh CLI proof. */
export function abandonUnsubmittedCreation(db:DatabaseSync,requestId:number,createdAt:number):void {
 db.exec('BEGIN IMMEDIATE');
 try{
  const target=inspectUnsubmittedCreation(db,requestId);
  if(target.createdAt!==createdAt)throw Error('recovery_target_changed');
  const update=db.prepare("UPDATE requests SET state='cancelled',prompt=NULL,error_code='operator_abandoned_result_unknown',updated_at=? WHERE id=? AND state='uncertain' AND error_code='session_creation_unknown'").run(Date.now(),requestId);
  if(update.changes!==1)throw Error('recovery_target_changed');
  db.prepare("UPDATE sessions SET blocked=CASE WHEN EXISTS(SELECT 1 FROM requests WHERE thread_id=? AND state='uncertain') THEN 1 ELSE 0 END WHERE thread_id=?").run(target.threadId,target.threadId);
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
}
