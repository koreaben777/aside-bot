/** Conversation execution contract. Aside Guard supplies its normal permissions;
 * this adapter does not impose a search-only tool or file boundary.
 * Return final text only; persist owned session IDs before user turns.
 * Report interruption acknowledgement separately from termination evidence. */
export class BackendFailureError extends Error {
  readonly code: string;
  readonly safeToRetry = true;
  constructor(code = 'confirmed_failure') {
    super('Backend confirmed the operation did not remain active');
    this.name = 'BackendFailureError';
    this.code = code;
  }
}

/** Unknown remote execution state. Generic run/create errors are treated identically. */
export class ExecutionUncertainError extends Error {
  readonly code: string;
  readonly safeToRetry = false;
  constructor(code = 'remote_state_unknown') {
    super('Remote execution state is unknown');
    this.name = 'ExecutionUncertainError';
    this.code = code;
  }
}

export const PRESET_NAMES = ['fast','standard','deep'] as const;
export type PresetName = typeof PRESET_NAMES[number];
export const PRESET_LABELS:Record<PresetName,string> = {fast:'빠른 답변',standard:'일반',deep:'깊은 분석'};
export const MODEL_IDS = ['gpt-6-luna','gpt-5.6-sol','gpt-6-sol'] as const;
export const EFFORTS = ['off','minimal','low','medium','high','xhigh','max'] as const;
export interface ModelSelection {
  provider:'openai-codex';
  modelId:typeof MODEL_IDS[number];
  thinkingLevel:typeof EFFORTS[number];
  fastMode?:boolean;
}
/** Old sessions used explicit Luna/medium without an explicit speed flag. */
export const LEGACY_SELECTION:ModelSelection = Object.freeze({provider:'openai-codex',modelId:'gpt-6-luna',thinkingLevel:'medium'});
export function parseSelection(value:unknown):ModelSelection {
  const v=value as Partial<ModelSelection>|null;
  if(!v||typeof v!=='object'||v.provider!=='openai-codex'||!MODEL_IDS.includes(v.modelId!)||!EFFORTS.includes(v.thinkingLevel!)||v.fastMode!==undefined&&typeof v.fastMode!=='boolean')throw new TypeError('invalid_model_selection');
  return {provider:v.provider,modelId:v.modelId!,thinkingLevel:v.thinkingLevel!,...(v.fastMode===undefined?{}:{fastMode:v.fastMode})};
}
export function presetName(value:unknown):PresetName {
  if(!PRESET_NAMES.includes(value as PresetName))throw new TypeError('invalid_preset');
  return value as PresetName;
}

export interface AnswerSource {id?:string;title:string;url:string}
export interface BackendAnswer {
  text:string;model?:string;threadTitle?:string;
  /** Verified final body before the adapter's legacy search-results appendix. */
  sourceText?:string;
  /** Only validated websearch sources from the same completed turn. */
  sources?:AnswerSource[];
}
export interface Backend {
  health(): Promise<void>;
  /** Must return a stable identifier; throw BackendFailureError only if no remote state survives. */
  createSession(selection?:ModelSelection): Promise<string>;
  /** Return final text only. Unknown/timeouts must throw ExecutionUncertainError or a generic error. */
  runTurn(sessionId: string, prompt: string, signal: AbortSignal, selection?:ModelSelection, options?:{generateThreadTitle:boolean}): Promise<BackendAnswer>;
  /** confirmed means termination evidence; accepted means Aside acknowledged interruption only. */
  stop(sessionId: string, selection?:ModelSelection): Promise<{ confirmed: boolean; accepted?: boolean }>;
}

export interface BotConfig {
  ownerUserId: string;
  guildId: string;
  channelId: string;
}

export type RequestState =
  | 'queued' | 'running' | 'completed' | 'failed'
  | 'cancel_requested' | 'cancelled' | 'uncertain';

export interface AttachmentRef { id: string; name: string; size: number; contentType: string | null }
export interface AttachmentManifest { sourceId: string; threadId: string; createdAt: number; files: AttachmentRef[]; terminalAt?: number }

export interface InboundTurn {
  sourceId: string; // Discord message or interaction ID, globally unique
  userId: string;
  guildId: string | null;
  channelId: string;
  content: string;
  attachments?: AttachmentRef[];
  isBot?: boolean;
  isDm?: boolean;
}

export interface ThreadBinding {
  threadId: string;
  guildId: string;
  parentChannelId: string;
  ownerUserId: string;
}

export interface Outbound {
  /** False when the transport cannot deduplicate retries after an ambiguous send. */
  retrySafe?: boolean;
  /** Default transports retain the shared ten-second progress notices. */
  progressNotices?:boolean;
  formatAnswer?(answer:BackendAnswer,elapsed:string):string[];
  send(threadId: string, content: string, nonce: string, answerRequestId?:number, replyToMessageId?:string, progressRequestId?:number): Promise<string>; // Discord message ID
  setThreadTitle?(threadId:string,title:string,expectedTitle?:string):Promise<void>;
}

export type SubmitResult =
  | { kind: 'queued'; requestId: number; position: number }
  | { kind: 'duplicate'; requestId: number; state: RequestState }
  | { kind: 'rejected'; reason: 'unauthorized' | 'invalid_channel' | 'attachments' | 'attachment_limits' | 'attachment_format' | 'attachment_capacity' | 'empty' | 'too_long' | 'queue_full' | 'blocked' | 'stale' };
