import { AttachmentFiles, AttachmentError, ATTACHMENT_MARKER, validateAttachments, attachmentErrorMessage } from '../attachments.js';
import { BackendFailureError, ExecutionUncertainError, type Backend, type BotConfig, type InboundTurn, type Outbound, type SubmitResult } from '../types.js';
import { Store, type RequestRow } from '../store.js';
import { splitOutput } from './split.js';
import {normalizeThreadTitle} from './thread-title.js';
import type {AsideSettings} from '../aside/settings.js';

const MAX_PROMPT=8000;
const MAX_PENDING=5;
// Discord's enforced nonce dedupe is time bounded. Never retry near expiry.
const NONCE_RETRY_MS=4*60_000;
type Phase='preparing'|'health'|'creating'|'running';
type Active={requestId:number;threadId:string;sourceId:string;phase:Phase;controller:AbortController;createPromise:Promise<string>|null;backendId:string|null;progressTimer:NodeJS.Timeout|null;stopResolver:(()=>void)|null};

export class Engine {
  private pumping=false;
  private delivering=false;
  private active:Active|null=null;
  private stopInFlight:Promise<void>|null=null;
  private closed=false;
  private deliveryTimer:NodeJS.Timeout|null=null;
  constructor(readonly config:BotConfig,readonly store:Store,readonly backend:Backend,readonly outbound:Outbound,readonly attachments?:AttachmentFiles,readonly settings?:AsideSettings,private readonly parentChannelPolicy?:(channelId:string)=>boolean) {}
  private allowedParent(channelId:string):boolean {return this.parentChannelPolicy?.(channelId)??channelId===this.config.channelId;}
  start():void {
    if(this.closed) return;
    this.kick();void this.flushOutbox();
    if(!this.deliveryTimer) {
      this.deliveryTimer=setInterval(()=>{void this.flushOutbox();},30_000);
      this.deliveryTimer.unref();
    }
  }
  close():void {
    this.closed=true;
    if(this.active?.phase==='preparing') this.active.controller.abort();
    if(this.deliveryTimer) clearInterval(this.deliveryTimer);
    this.deliveryTimer=null;
    if(this.active?.progressTimer) clearInterval(this.active.progressTimer);
  } // Caller must await active work before closing the DB during graceful shutdown.
  authorized(userId:string,guildId:string|null):boolean {
    return userId===this.config.ownerUserId && guildId===this.config.guildId;
  }
  allowedCommandChannel(channelId:string,parentId?:string|null,guildId?:string|null):boolean {
    if(channelId===this.config.channelId) return parentId==null && (guildId==null || guildId===this.config.guildId);
    const s=this.store.session(channelId);
    return !!s && s.guildId===this.config.guildId && this.allowedParent(s.parentChannelId) && s.ownerUserId===this.config.ownerUserId && (parentId===undefined || parentId===s.parentChannelId) && (guildId===undefined || guildId===this.config.guildId);
  }
  submit(turn:InboundTurn,options:{publishQuestion?:boolean;publishQueueNotice?:boolean;inputKind?:RequestRow['inputKind'];referenceRequestId?:number;onlyIfLatest?:number;comparisonOrigin?:{threadId:string;messageId:string}}={}):SubmitResult {
    if(turn.isBot || turn.isDm || !this.authorized(turn.userId,turn.guildId)) return {kind:'rejected',reason:'unauthorized'};
    const s=this.store.session(turn.channelId);
    if(!s || s.guildId!==turn.guildId || !this.allowedParent(s.parentChannelId) || s.ownerUserId!==turn.userId) return {kind:'rejected',reason:'invalid_channel'};
    if(turn.content.startsWith(ATTACHMENT_MARKER)) return {kind:'rejected',reason:'attachments'};
    if(!turn.content.trim()) return {kind:'rejected',reason:'empty'};
    if(turn.content.length>MAX_PROMPT) return {kind:'rejected',reason:'too_long'};
    const refs=turn.attachments;
    if(refs?.length){
      if(!this.attachments) return {kind:'rejected',reason:'attachments'};
      try { validateAttachments(refs); } catch(error) { return {kind:'rejected',reason:attachmentReason(error)}; }
    }
    const duplicate=this.store.requestBySource(turn.sourceId);
    if(duplicate) return {kind:'duplicate',requestId:duplicate.id,state:duplicate.state};
    if(this.store.hasUncertain()||s.blocked) return {kind:'rejected',reason:'blocked'};
    if(this.store.pendingCount()>=MAX_PENDING) return {kind:'rejected',reason:'queue_full'};
    let staged=false;
    if(refs?.length){
      try { this.attachments!.stage({sourceId:turn.sourceId,threadId:turn.channelId,createdAt:Date.now(),files:refs});staged=true; }
      catch(error){return {kind:'rejected',reason:attachmentReason(error)};}
    }
    const initial=options.publishQuestion?splitOutput(`질문:\n${turn.content}`):[];
    const queueNotice=options.publishQueueNotice?`요청을 대기열에 등록했습니다. 현재 대기 순서: ${this.store.pendingCount()+1}. 완료되면 이 스레드에 답변하겠습니다.`:undefined;
    let outcome:ReturnType<Store['enqueue']>;
    try { outcome=this.store.enqueue(turn.sourceId,turn.channelId,(staged?ATTACHMENT_MARKER:'')+turn.content,MAX_PENDING,initial,{...options,queueNotice,inputKind:staged?'attachment':options.inputKind??'message'}); }
    catch(error){if(staged)try{this.attachments!.discard(turn.sourceId);}catch{}throw error;}
    if(staged&&outcome.kind!=='queued')try{this.attachments!.discard(turn.sourceId);}catch{}

    if(outcome.kind==='full') return {kind:'rejected',reason:'queue_full'};
    if(outcome.kind==='blocked') return {kind:'rejected',reason:'blocked'};
    if(outcome.kind==='stale') return {kind:'rejected',reason:'stale'};
    if(outcome.kind==='queued') { this.kick();void this.flushOutbox(); }
    return outcome;
  }
  private kick():void { if(!this.closed && !this.pumping) void this.pump(); }
  private failure(id:number,threadId:string,code:string,message='요청이 실패했습니다. 서비스 상태를 확인한 뒤 다시 시도해 주세요.'):void {
    if(this.store.transition(id,'running','failed',code)) {
      this.store.addOutput(id,threadId,[message]);
      void this.flushOutbox();
    }
  }
  private uncertain(id:number,code:string):void {
    this.store.transition(id,'running','uncertain',code);
  }
  private async pump():Promise<void> {
    if(this.pumping) return;
    this.pumping=true;
    try {
      while(!this.closed && !this.store.hasUncertain()) {
        const req=this.store.nextQueued();
        if(!req) break;
        if(!this.store.startRequest(req.id)) continue;
        const binding=this.store.session(req.threadId);
        if(!binding||binding.guildId!==this.config.guildId||binding.ownerUserId!==this.config.ownerUserId||!this.allowedParent(binding.parentChannelId)){
          this.failure(req.id,req.threadId,'invalid_channel');continue;
        }
        const active:Active={requestId:req.id,threadId:req.threadId,sourceId:req.sourceId,phase:'health',controller:new AbortController(),createPromise:null,backendId:null,progressTimer:null,stopResolver:null};
        this.active=active;
        try {
          let prompt=req.prompt!;
          if(prompt.startsWith(ATTACHMENT_MARKER)){
            active.phase='preparing';
            try {
              if(!this.attachments) throw new AttachmentError('attachment_storage');
              prompt=await this.attachments.prepare(req.sourceId,prompt.slice(ATTACHMENT_MARKER.length),active.controller.signal);
            } catch(error) {
              const code=error instanceof AttachmentError?error.code:'attachment_download';
              this.failure(req.id,req.threadId,code,attachmentErrorMessage(code));continue;
            }
            if(active.controller.signal.aborted||this.closed||this.store.request(req.id)?.state!=='running')continue;
          }
          active.phase='health';
          // A health failure is known pre-execution and never launches work.
          try { await this.backend.health(); }
          catch { this.failure(req.id,req.threadId,'health_failed');continue; }
          if(this.store.request(req.id)?.state!=='running' || this.store.hasUncertain()) continue;
          let backendId=this.store.session(req.threadId)?.backendId;
          if(!backendId) {
            active.phase='creating';
            active.createPromise=this.backend.createSession(req.selection);
            backendId=await active.createPromise;
            this.store.setBackendId(req.threadId,backendId);
          }
          active.backendId=backendId;
          if(this.store.request(req.id)?.state!=='running' || this.store.hasUncertain()) continue;
          active.phase='running';
          const startedAt=Date.now();
          const elapsed=()=>{
            const seconds=Math.max(0,Math.floor((Date.now()-startedAt)/1000));
            return `${String(Math.floor(seconds/60)).padStart(2,'0')}분 ${String(seconds%60).padStart(2,'0')}초`;
          };
          const task=this.backend.runTurn(backendId,prompt,active.controller.signal,req.selection,req.inputKind==='initial'?{generateThreadTitle:true}:undefined);
          if(this.outbound.progressNotices!==false){active.progressTimer=setInterval(()=>{
            if(this.active!==active || this.store.request(req.id)?.state!=='running') return;
            // Informational only. No fabricated percentage, tool state, or backend claims.
            this.store.addOutput(req.id,req.threadId,[`답변 중... (${elapsed()})`],'progress_notice');
            void this.flushOutbox();
          },10_000);
          active.progressTimer.unref();
          }
          const outcome=await Promise.race([
            task.then(answer=>({kind:'answer' as const,answer})),
            new Promise<{kind:'stopped'}>(resolve=>{active.stopResolver=()=>resolve({kind:'stopped'});}),
          ]);
          if(active.progressTimer)clearInterval(active.progressTimer);
          active.progressTimer=null;
          if(outcome.kind==='stopped') continue;
          if(outcome.answer.model!==undefined&&outcome.answer.model!==`${req.selection.provider}/${req.selection.modelId}`)throw new ExecutionUncertainError('model_mismatch');
          const parts=this.outbound.formatAnswer?.(outcome.answer,elapsed())??splitOutput(`(${elapsed()} 경과)\n\n${outcome.answer.text||'(답변 내용이 없습니다.)'}`);
          if(this.store.transition(req.id,'running','completed')) {
            this.store.addOutput(req.id,req.threadId,parts,'answer',outcome.answer.model);
            void this.flushOutbox();
            if(req.inputKind==='initial'&&outcome.answer.threadTitle&&this.outbound.setThreadTitle){
              // Title updates are best effort and must never hold up answer delivery or the queue.
              void Promise.resolve().then(()=>this.outbound.setThreadTitle!(req.threadId,outcome.answer.threadTitle!,normalizeThreadTitle(req.prompt)??'Aside 새 대화')).catch(()=>{});
            }
          }
        } catch(error) {
          // Generic run/create errors, including timeouts, have unknown remote state.
          // Only an explicit adapter guarantee permits a confirmed safe failure.
          if(this.store.request(req.id)?.state==='running') {
            if(error instanceof BackendFailureError && error.safeToRetry) {
              if(error.code==='session_unavailable')this.failure(req.id,req.threadId,'session_unavailable','연결된 Aside 세션을 찾을 수 없습니다. 새 대화에서 질문해 주세요. 이 질문은 Aside에 제출하지 않았습니다.');
              else this.failure(req.id,req.threadId,'confirmed_backend_failure');
            }
            else this.uncertain(req.id,active.phase==='creating'?'session_creation_unknown':'execution_unknown');
          }
        } finally {
          if(active.progressTimer) clearInterval(active.progressTimer);
          // Never release the global pump while an in-flight stop is unconfirmed.
          if(this.stopInFlight && this.active===active) await this.stopInFlight;
          this.active=null;
        }
      }
    } finally {
      this.pumping=false;
      if(!this.closed && !this.store.hasUncertain() && this.store.nextQueued()) this.kick();
    }
  }
  async stop(threadId:string,userId:string,guildId:string|null):Promise<'stopped'|'requested'|'pending'|'uncertain'|'not_found'> {
    if(!this.authorized(userId,guildId)) return 'not_found';
    const s=this.store.session(threadId);
    if(!s || s.guildId!==this.config.guildId || !this.allowedParent(s.parentChannelId) || s.ownerUserId!==this.config.ownerUserId) return 'not_found';
    this.store.cancelQueued(threadId);
    const req=this.store.runningInThread(threadId) ?? this.store.retryableStopInThread(threadId);
    if(!req) return this.store.session(threadId)?.blocked?'uncertain':'stopped';
    if(req.state==='cancel_requested') {
      await this.stopInFlight;
      return this.store.session(threadId)?.blocked?'uncertain':this.store.request(req.id)?.errorCode==='stop_requested'?'requested':'stopped';
    }
    if(!this.store.transition(req.id,req.state,'cancel_requested')) return 'pending';
    const active=this.active?.requestId===req.id?this.active:null;
    this.stopInFlight=(async()=>{
      if(active?.phase==='health'||active?.phase==='preparing') {
        // No createSession/runTurn has begun. Abort local preparation as well.
        active.controller.abort();
        this.store.transition(req.id,'cancel_requested','cancelled');
        return;
      }
      let backendId=active?.backendId ?? s.backendId;
      if(active?.phase==='creating' && active.createPromise) {
        try {
          // Wait for creation to settle. A remote session may exist despite a timeout.
          backendId=await active.createPromise;
        } catch(error) {
          if(error instanceof BackendFailureError) this.store.transition(req.id,'cancel_requested','cancelled');
          else this.store.transition(req.id,'cancel_requested','uncertain','create_during_stop_unknown');
          return;
        }
      }
      if(!backendId) {
        this.store.transition(req.id,'cancel_requested','uncertain','stop_missing_session');
        return;
      }
      try {
        const result=await this.backend.stop(backendId,s.selection);
        if(result.confirmed || result.accepted) {
          this.store.finishStop(req.id,!result.confirmed);
          active?.controller.abort();
          active?.stopResolver?.();
        } else this.store.transition(req.id,'cancel_requested','uncertain','stop_unconfirmed');
      } catch {
        // Even a typed safe run failure cannot prove a stop succeeded.
        this.store.transition(req.id,'cancel_requested','uncertain','stop_failed');
      }
    })();
    await this.stopInFlight;
    const uncertain=this.store.request(req.id)?.state==='uncertain';
    this.stopInFlight=null;
    if(!uncertain) this.kick();
    return uncertain?'uncertain':this.store.request(req.id)?.errorCode==='stop_requested'?'requested':'stopped';
  }
  status(threadId?:string):{queued:number;running:number;uncertain:number;deliveryUncertain:number;blocked:boolean} {
    const counts=this.store.counts(threadId);
    return {...counts,deliveryUncertain:this.store.deliveryUncertainCount(threadId),blocked:this.store.hasUncertain() || !!threadId && !!this.store.session(threadId)?.blocked};
  }
  async flushOutbox():Promise<void> {
    if(this.delivering || this.closed) return;
    this.delivering=true;
    try {
      while(!this.closed) {
        const row=this.store.outbox()[0];
        if(!row) break;
        if(row.kind==='progress_notice'&&this.outbound.progressNotices===false){
          if(row.state==='pending')this.store.discardPendingProgress(row.id);
          else this.store.markDeliveryUncertain(row.id);
          continue;
        }
        if(row.state==='sending' && (this.outbound.retrySafe===false || row.attemptedAt!==null && Date.now()-row.attemptedAt>=NONCE_RETRY_MS)) {
          this.store.markDeliveryUncertain(row.id);
          continue;
        }
        this.store.markSending(row.id);
        try {
          const answerId=row.kind==='answer'&&row.isLast?row.requestId:undefined;
          const replyTo=row.kind==='queue_notice'?this.store.request(row.requestId)?.sourceId:undefined;
          const progressId=row.kind==='progress_notice'?row.requestId:undefined;
          const messageId=await this.outbound.send(row.threadId,row.content,row.nonce,answerId,replyTo,progressId);
          this.store.markSent(row.id,messageId);
        } catch {
          // Informational progress delivery must not block the final answer.
          if(row.kind==='progress_notice'||this.outbound.retrySafe===false){this.store.markDeliveryUncertain(row.id);continue;}
          // Unknown transport result. Retry within enforced nonce window only.
          break;
        }
      }
    } finally { this.delivering=false; }
  }
}

function attachmentReason(error:unknown):Extract<SubmitResult,{kind:'rejected'}>['reason'] {
 if(error instanceof AttachmentError&&['attachment_limits','attachment_format','attachment_capacity'].includes(error.code))return error.code as 'attachment_limits'|'attachment_format'|'attachment_capacity';
 return 'attachments';
}
