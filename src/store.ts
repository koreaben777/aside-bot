import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {LEGACY_SELECTION,parseSelection,presetName,type BotConfig,type ModelSelection,type PresetName,type RequestState,type ThreadBinding} from './types.js';

export interface SessionRow extends ThreadBinding {
  backendId: string | null;
  blocked: number;
  originId: string | null;
  presetName:PresetName|null;
  selection:ModelSelection;
  comparisonRequestId:number|null;
}
export interface RequestRow {
  id: number;
  sourceId: string;
  threadId: string;
  prompt: string | null;
  state: RequestState;
  errorCode: string | null;
  createdAt: number;
  selection:ModelSelection;
  actualModel:string|null;
  inputKind:'message'|'initial'|'attachment'|'action'|'comparison';
  referenceRequestId:number|null;
}
export interface OutboxRow {
  id: number;
  requestId: number;
  threadId: string;
  part: number;
  content: string;
  nonce: string;
  state: 'pending' | 'sending' | 'sent' | 'uncertain';
  attemptedAt: number | null;
  discordMessageId: string | null;
  kind:'question'|'answer'|'notice'|'queue_notice'|'progress_notice';
  isLast:boolean;
}
export interface AnswerTarget {request:RequestRow;parts:OutboxRow[];messageId:string}
const read = <T>(value: unknown): T => value as T;

export class Store {
  readonly db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (
        thread_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, parent_channel_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL, origin_id TEXT UNIQUE, backend_id TEXT UNIQUE,
        blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)), created_at INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS immutable_binding BEFORE UPDATE OF guild_id,parent_channel_id,owner_user_id,origin_id,backend_id ON sessions
      WHEN NEW.guild_id != OLD.guild_id OR NEW.parent_channel_id != OLD.parent_channel_id
        OR NEW.owner_user_id != OLD.owner_user_id OR NEW.origin_id IS NOT OLD.origin_id
        OR (OLD.backend_id IS NOT NULL AND NEW.backend_id IS NOT OLD.backend_id)
      BEGIN SELECT RAISE(ABORT, 'immutable session binding'); END;
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY, source_id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL REFERENCES sessions(thread_id),
        prompt TEXT, state TEXT NOT NULL CHECK(state IN ('queued','running','completed','failed','cancel_requested','cancelled','uncertain')),
        error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS request_queue ON requests(state,id);
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES requests(id),
        thread_id TEXT NOT NULL REFERENCES sessions(thread_id), part INTEGER NOT NULL,
        content TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','uncertain')),
        attempted_at INTEGER, discord_message_id TEXT,
        UNIQUE(request_id,part)
      );`);
    // Add columns without replacing existing bindings, requests, triggers or data.
    for(const [table,columns] of Object.entries({
      sessions:{preset_name:'TEXT',model_selection:'TEXT',comparison_request_id:'INTEGER'},
      requests:{model_selection:'TEXT',actual_model:'TEXT',input_kind:"TEXT NOT NULL DEFAULT 'message'",reference_request_id:'INTEGER'},
      outbox:{kind:"TEXT NOT NULL DEFAULT 'notice'",is_last:'INTEGER NOT NULL DEFAULT 0'},
    })){
      const present=new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(row=>row.name));
      for(const [column,definition] of Object.entries(columns))if(!present.has(column))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS bot_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS immutable_selection BEFORE UPDATE OF preset_name,model_selection ON sessions
      WHEN OLD.model_selection IS NOT NULL AND (NEW.model_selection IS NOT OLD.model_selection OR NEW.preset_name IS NOT OLD.preset_name)
      BEGIN SELECT RAISE(ABORT, 'immutable model selection'); END;`);
    // An interrupted remote execution has unknown state. Never auto-replay it.
    this.db.exec(`UPDATE requests SET state='uncertain',prompt=NULL,error_code='interrupted',updated_at=unixepoch('subsec')*1000
      WHERE state IN ('running','cancel_requested');
      UPDATE sessions SET blocked=1 WHERE thread_id IN (SELECT thread_id FROM requests WHERE state='uncertain');`);
  }
  close(): void { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  bindThread(binding: ThreadBinding, originId: string, options?:{presetName:PresetName;selection:ModelSelection;comparisonRequestId?:number}): void {
    this.db.prepare(`INSERT INTO sessions(thread_id,guild_id,parent_channel_id,owner_user_id,origin_id,created_at,preset_name,model_selection,comparison_request_id)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(binding.threadId,binding.guildId,binding.parentChannelId,binding.ownerUserId,originId,Date.now(),options?presetName(options.presetName):null,options?JSON.stringify(parseSelection(options.selection)):null,options?.comparisonRequestId??null);
  }
  session(threadId: string): SessionRow | undefined {
    const row = read<Record<string, unknown> | undefined>(this.db.prepare('SELECT * FROM sessions WHERE thread_id=?').get(threadId));
    return row && {threadId: String(row.thread_id),guildId: String(row.guild_id),parentChannelId:String(row.parent_channel_id),ownerUserId:String(row.owner_user_id),backendId:row.backend_id as string|null,blocked:Number(row.blocked),originId:row.origin_id as string|null,
      presetName:row.preset_name===null?null:presetName(row.preset_name),selection:row.model_selection===null?{...LEGACY_SELECTION}:parseSelection(JSON.parse(String(row.model_selection))),comparisonRequestId:row.comparison_request_id===null?null:Number(row.comparison_request_id)};
  }
  sessionByOrigin(originId: string): SessionRow | undefined {
    const row = read<{thread_id:string}|undefined>(this.db.prepare('SELECT thread_id FROM sessions WHERE origin_id=?').get(originId));
    return row ? this.session(row.thread_id) : undefined;
  }
  recentThreads(config:BotConfig):Array<{threadId:string;lastQuestionAt:number}> {
    return read<Array<{threadId:string;lastQuestionAt:number}>>(this.db.prepare(`
      SELECT s.thread_id AS threadId, COALESCE(MAX(r.created_at),s.created_at) AS lastQuestionAt
      FROM sessions s LEFT JOIN requests r ON r.thread_id=s.thread_id
      WHERE s.guild_id=? AND s.parent_channel_id=? AND s.owner_user_id=?
      GROUP BY s.thread_id ORDER BY lastQuestionAt DESC,s.thread_id DESC LIMIT 10
    `).all(config.guildId,config.channelId,config.ownerUserId));
  }
  setBackendId(threadId: string, backendId: string): void {
    if (!backendId || backendId.length > 512) throw new Error('invalid backend session id');
    const change = this.db.prepare('UPDATE sessions SET backend_id=? WHERE thread_id=? AND backend_id IS NULL AND blocked=0').run(backendId,threadId);
    if (change.changes !== 1) throw new Error('backend binding rejected');
  }
  hasUncertain(): boolean {
    return !!this.db.prepare("SELECT 1 FROM requests WHERE state='uncertain' LIMIT 1").get();
  }
  pendingCount(): number {
    return Number(read<{n:number}>(this.db.prepare("SELECT COUNT(*) n FROM requests WHERE state='queued'").get()).n);
  }
  requestBySource(sourceId: string): RequestRow | undefined {
    const r = read<Record<string, unknown>|undefined>(this.db.prepare('SELECT * FROM requests WHERE source_id=?').get(sourceId));
    return r && this.mapRequest(r);
  }
  request(id: number): RequestRow | undefined {
    const r = read<Record<string, unknown>|undefined>(this.db.prepare('SELECT * FROM requests WHERE id=?').get(id));
    return r && this.mapRequest(r);
  }
  private mapRequest(r: Record<string,unknown>): RequestRow {
    return {id:Number(r.id),sourceId:String(r.source_id),threadId:String(r.thread_id),prompt:r.prompt as string|null,state:r.state as RequestState,errorCode:r.error_code as string|null,createdAt:Number(r.created_at),
      selection:r.model_selection===null?{...LEGACY_SELECTION}:parseSelection(JSON.parse(String(r.model_selection))),actualModel:r.actual_model as string|null,inputKind:r.input_kind as RequestRow['inputKind'],referenceRequestId:r.reference_request_id===null?null:Number(r.reference_request_id)};
  }
  enqueue(sourceId: string, threadId: string, prompt: string, maxPending = 5, initialParts: string[] = [],options:{queueNotice?:string;inputKind?:RequestRow['inputKind'];referenceRequestId?:number;onlyIfLatest?:number;comparisonOrigin?:{threadId:string;messageId:string}}={}): {kind:'queued';requestId:number;position:number}|{kind:'duplicate';requestId:number;state:RequestState}|{kind:'full'}|{kind:'blocked'}|{kind:'stale'} {
    return this.transaction(() => {
      const duplicate = this.requestBySource(sourceId);
      if (duplicate) return {kind:'duplicate',requestId:duplicate.id,state:duplicate.state};
      if (this.hasUncertain() || this.session(threadId)?.blocked) return {kind:'blocked' as const};
      if (this.pendingCount() >= maxPending) return {kind:'full' as const};
      if(options.onlyIfLatest!==undefined&&(this.busyInThread(threadId)||this.latestAnswer(threadId)?.request.id!==options.onlyIfLatest))return {kind:'stale' as const};
      const now=Date.now();
      const selection=this.session(threadId)?.selection;
      if(!selection)throw new Error('missing session');
      const result=this.db.prepare("INSERT INTO requests(source_id,thread_id,prompt,state,created_at,updated_at,model_selection,input_kind,reference_request_id) VALUES(?,?,?,'queued',?,?,?,?,?)").run(sourceId,threadId,prompt,now,now,JSON.stringify(selection),options.inputKind??'message',options.referenceRequestId??null);
      const requestId=Number(result.lastInsertRowid);
      this.insertOutputParts(requestId,threadId,initialParts,-100,'question');
      if(options.queueNotice)this.insertOutputParts(requestId,threadId,[options.queueNotice],-1,'queue_notice');
      if(options.comparisonOrigin){
        const origin=options.comparisonOrigin,binding=this.session(threadId)!;
        this.insertOutputParts(requestId,origin.threadId,[`이 답변의 다른 모델 비교: https://discord.com/channels/${binding.guildId}/${threadId}`],-1001,'notice');
        this.insertOutputParts(requestId,threadId,[`원본 답변: https://discord.com/channels/${binding.guildId}/${origin.threadId}/${origin.messageId}`],-1000,'notice');
      }
      return {kind:'queued',requestId,position:this.pendingCount()};
    });
  }
  nextQueued(): RequestRow | undefined {
    const r=read<Record<string,unknown>|undefined>(this.db.prepare("SELECT r.* FROM requests r JOIN sessions s ON s.thread_id=r.thread_id WHERE r.state='queued' AND s.blocked=0 ORDER BY r.id LIMIT 1").get());
    return r && this.mapRequest(r);
  }
  startRequest(id: number): boolean {
    return this.db.prepare("UPDATE requests SET state='running',updated_at=? WHERE id=? AND state='queued'").run(Date.now(),id).changes === 1;
  }
  // All terminal transitions erase the queued prompt. No hidden chain-of-thought is stored.
  transition(id: number, from: RequestState, to: RequestState, code: string|null = null): boolean {
    return this.transaction(() => {
      const changed=this.db.prepare('UPDATE requests SET state=?,prompt=NULL,error_code=?,updated_at=? WHERE id=? AND state=?').run(to,code,Date.now(),id,from).changes === 1;
      if (changed && to === 'uncertain') {
        const req=this.request(id);
        if (req) this.db.prepare('UPDATE sessions SET blocked=1 WHERE thread_id=?').run(req.threadId);
      }
      return changed;
    });
  }
  cancelQueued(threadId: string): number {
    return Number(this.db.prepare("UPDATE requests SET state='cancelled',prompt=NULL,updated_at=? WHERE thread_id=? AND state='queued'").run(Date.now(),threadId).changes);
  }
  runningInThread(threadId:string): RequestRow|undefined {
    const r=read<Record<string,unknown>|undefined>(this.db.prepare("SELECT * FROM requests WHERE thread_id=? AND state IN ('running','cancel_requested') ORDER BY id LIMIT 1").get(threadId));
    return r && this.mapRequest(r);
  }
  retryableStopInThread(threadId:string):RequestRow|undefined {
    const r=read<Record<string,unknown>|undefined>(this.db.prepare("SELECT * FROM requests WHERE thread_id=? AND state='uncertain' AND error_code IN ('stop_unconfirmed','stop_failed') ORDER BY id LIMIT 1").get(threadId));
    return r && this.mapRequest(r);
  }
  finishStop(id:number,accepted:boolean):void {
    this.transaction(()=>{
      const req=this.request(id);
      if(!req || req.state!=='cancel_requested') throw new Error('invalid_stop_transition');
      this.db.prepare("UPDATE requests SET state='cancelled',prompt=NULL,error_code=?,updated_at=? WHERE id=?").run(accepted?'stop_requested':null,Date.now(),id);
      this.db.prepare("UPDATE sessions SET blocked=CASE WHEN EXISTS(SELECT 1 FROM requests WHERE thread_id=? AND state='uncertain') THEN 1 ELSE 0 END WHERE thread_id=?").run(req.threadId,req.threadId);
    });
  }
  counts(threadId?:string): {queued:number;running:number;uncertain:number} {
    const rows=read<Array<{state:string;n:number}>>(this.db.prepare(`SELECT state,COUNT(*) n FROM requests ${threadId?'WHERE thread_id=?':''} GROUP BY state`).all(...(threadId?[threadId]:[])));
    const count=(...states:string[])=>rows.filter(r=>states.includes(r.state)).reduce((a,r)=>a+Number(r.n),0);
    return {queued:count('queued'),running:count('running','cancel_requested'),uncertain:count('uncertain')};
  }
  addOutput(requestId:number, threadId:string, parts:string[],kind:OutboxRow['kind']='notice',actualModel?:string):void {
    this.transaction(() => {
      if(actualModel!==undefined)this.db.prepare('UPDATE requests SET actual_model=? WHERE id=?').run(actualModel,requestId);
      const {next}=this.db.prepare('SELECT COALESCE(MAX(part)+1,0) next FROM outbox WHERE request_id=? AND part>=0').get(requestId) as {next:number};
      this.insertOutputParts(requestId,threadId,parts,Number(next),kind);
    });
  }
  private insertOutputParts(requestId:number,threadId:string,parts:string[],startPart:number,kind:OutboxRow['kind']):void {
    const source=this.request(requestId)?.sourceId;
    if(!source) throw new Error('missing request source');
    for(let i=0;i<parts.length;i++) {
      const part=startPart+i;
      const nonce=createHash('sha256').update(`${source}:${threadId}:${part}`).digest('hex').slice(0,24);
      this.db.prepare("INSERT OR IGNORE INTO outbox(request_id,thread_id,part,content,nonce,state,kind,is_last) VALUES(?,?,?,?,?,'pending',?,?)").run(requestId,threadId,part,parts[i]!,nonce,kind,kind==='answer'&&i===parts.length-1?1:0);
    }
  }
  outbox():OutboxRow[] {
    return read<Array<Record<string,unknown>>>(this.db.prepare("SELECT * FROM outbox o WHERE state IN ('pending','sending') AND NOT EXISTS (SELECT 1 FROM outbox prior WHERE prior.request_id=o.request_id AND prior.part<o.part AND prior.state!='sent' AND prior.kind!='progress_notice') ORDER BY id").all()).map(r=>this.mapOutput(r));
  }
  discardPendingProgress(id:number):void {
    this.db.prepare("DELETE FROM outbox WHERE id=? AND kind='progress_notice' AND state='pending'").run(id);
  }
  markSending(id:number):void { this.db.prepare("UPDATE outbox SET state='sending',attempted_at=COALESCE(attempted_at,?) WHERE id=? AND state IN ('pending','sending')").run(Date.now(),id); }
  markSent(id:number,messageId:string):void { this.db.prepare("UPDATE outbox SET state='sent',discord_message_id=? WHERE id=? AND state='sending'").run(messageId,id); }
  markDeliveryUncertain(id:number):void { this.db.prepare("UPDATE outbox SET state='uncertain' WHERE id=? AND state='sending'").run(id); }
  deliveryUncertainCount(threadId?:string):number {
    const row=read<{n:number}>(this.db.prepare(`SELECT COUNT(*) n FROM outbox WHERE state='uncertain' AND kind!='progress_notice' ${threadId?'AND thread_id=?':''}`).get(...(threadId?[threadId]:[])));
    return Number(row.n);
  }
  private mapOutput(r:Record<string,unknown>):OutboxRow {
    return {id:Number(r.id),requestId:Number(r.request_id),threadId:String(r.thread_id),part:Number(r.part),content:String(r.content),nonce:String(r.nonce),state:r.state as OutboxRow['state'],attemptedAt:r.attempted_at as number|null,discordMessageId:r.discord_message_id as string|null,kind:r.kind as OutboxRow['kind'],isLast:!!r.is_last};
  }
  outputParts(requestId:number,kind:OutboxRow['kind']):OutboxRow[] {
    return (this.db.prepare('SELECT * FROM outbox WHERE request_id=? AND kind=? ORDER BY part').all(requestId,kind) as Record<string,unknown>[]).map(row=>this.mapOutput(row));
  }
  answer(requestId:number,threadId:string,messageId:string):AnswerTarget|undefined {
    const request=this.request(requestId),parts=this.outputParts(requestId,'answer');
    if(!request||request.threadId!==threadId||request.state!=='completed'||!request.actualModel||!parts.length||parts.some(row=>row.state!=='sent')||!parts.at(-1)?.isLast||parts.at(-1)?.discordMessageId!==messageId)return;
    return {request,parts,messageId};
  }
  latestAnswer(threadId:string):AnswerTarget|undefined {
    const row=this.db.prepare("SELECT id FROM requests WHERE thread_id=? AND state='completed' AND actual_model IS NOT NULL ORDER BY id DESC LIMIT 1").get(threadId) as {id:number}|undefined;
    if(!row)return;
    const messageId=this.outputParts(Number(row.id),'answer').at(-1)?.discordMessageId;
    return messageId?this.answer(Number(row.id),threadId,messageId):undefined;
  }
  busyInThread(threadId:string):boolean {
    return !!this.db.prepare("SELECT 1 FROM requests WHERE thread_id=? AND state IN ('queued','running','cancel_requested') LIMIT 1").get(threadId);
  }
  defaultPreset():PresetName {
    const row=this.db.prepare("SELECT value FROM bot_settings WHERE key='default_preset'").get() as {value:string}|undefined;
    return row?presetName(row.value):'fast';
  }
  setDefaultPreset(name:PresetName):void {
    this.db.prepare("INSERT INTO bot_settings(key,value) VALUES('default_preset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(presetName(name));
  }
}
