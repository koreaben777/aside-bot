import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Backend, BackendAnswer, AnswerSource } from '../types.js';
import { BackendFailureError, ExecutionUncertainError, LEGACY_SELECTION, parseSelection, type ModelSelection } from '../types.js';
import { SessionRegistry } from './registry.js';
import { runQueuedTurn } from './queue.js';
import {normalizeThreadTitle} from '../core/thread-title.js';

/** No model, host, account, permission or policy fallbacks. */
export const ACCOUNT = 'u0';
export const HOST = 'local';
export const MODEL = 'openai-codex/gpt-6-luna';
export const MODEL_SELECTION = Object.freeze({provider:'openai-codex',modelId:'gpt-6-luna',thinkingLevel:'medium',fastMode:true});
export const CLI_VERSION = '1.26.916.1741';
export const READ_ONLY_POLICY = Object.freeze({
  execution: { submit: 'session-queue', completion: 'fresh-turn-lifecycle' },
  permissionMode: 'read-only',
  permission: {
    rules: {
      allow: [{ type: 'tool', tool: 'websearch' }], approved: [], ask: [], default: 'deny',
      // Explicit session-local denials supplement, never replace, default-deny.
      // This does not change the account's global permissions.
      deny: ['bash', 'repl', 'read_file', 'write_file', 'edit_file', 'subagent']
        .map(tool => ({ type: 'tool', tool })),
    },
    files: { readableRoots: [], writableRoots: [], outsideRead: 'deny', outsideWrite: 'deny' },
    sandbox: { enabled: true },
  },
  runtimeConfig: { proactiveMode: false },
  model: MODEL_SELECTION,
});
export const POLICY_SHA256 = createHash('sha256').update(JSON.stringify(READ_ONLY_POLICY)).digest('hex');
const MAX_OUTPUT = 1024 * 1024;
const SESSION_ID = /^[A-Za-z0-9_-]{6,128}$/;
const JSON_PREFIX = 'ASIDE_BOT_JSON:';

/** Registry ownership remains required; legacy certificate fields are ignored. */
export interface AsideBackendConfig {
  cliPath: string;
  certificatePath?: string;
  operatorPublicKeyPem?: string;
  /** Required at runtime. Kept optional in TS while parent wiring migrates. */
  registryPath?: string;
  registryKeyPath?: string;
  /** Deprecated caller list, intentionally ignored. Never authorizes a session. */
  existingSessionIds?: readonly string[];
}
export interface PolicyCertificatePayload {
  schema: 1;
  cliVersion: string;
  cliSha256: string;
  account: typeof ACCOUNT;
  host: typeof HOST;
  model: typeof MODEL;
  policySha256: string;
  verifiedAt: string;
  expiresAt: string;
  verifiedCapabilities: string[];
}
export interface PolicyCertificate { payload: PolicyCertificatePayload; signatureBase64: string }

type Exec = (args: string[], timeout: number) => Promise<string>;
type Obj = Record<string, unknown>;
function record(value: unknown): value is Obj { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function id(value: unknown): value is string { return typeof value === 'string' && SESSION_ID.test(value); }
function safeFailure(code: string): BackendFailureError { return new BackendFailureError(code); }
function uncertain(code: string): ExecutionUncertainError { return new ExecutionUncertainError(code); }

/** Strict framing. CLI chatter is never interpreted as an answer. */
export function parseReplJson(stdout: string): unknown {
  const lines = stdout.trimEnd().split(/\r?\n/).filter(line => line.startsWith(JSON_PREFIX));
  if (lines.length !== 1) throw uncertain('invalid_repl_response');
  try { return JSON.parse(lines[0]!.slice(JSON_PREFIX.length)) as unknown; }
  catch { throw uncertain('invalid_repl_response'); }
}

/** CLI session list explicitly includes ephemeral sessions, unlike the REPL list. */
export function parseSessionList(stdout: string): string[] {
  if (stdout.trim() === 'No sessions.') return [];
  const ids = stdout.split(/\r?\n/).flatMap(line => {
    const match = /^([A-Za-z0-9_-]{6,128})  (\S+)  (ephemeral|persistent)  /.exec(line);
    return match ? [match[1]!] : [];
  });
  if (!ids.length) throw uncertain('invalid_session_list');
  return [...new Set(ids)];
}

function finalText(message: unknown, selection:ModelSelection=LEGACY_SELECTION): string | undefined {
  if (!record(message) || message.role !== 'assistant' || message.stopReason !== 'stop' ||
      message.provider !== selection.provider || message.model !== selection.modelId ||
      typeof message.responseId !== 'string' || !Array.isArray(message.content)) return undefined;
  const blocks = message.content.filter(x => record(x) && x.type === 'text');
  if (blocks.length !== 1) return undefined;
  const block = blocks[0] as Obj;
  if (typeof block.text !== 'string' || typeof block.textSignature !== 'string') return undefined;
  let signature: unknown;
  try { signature = JSON.parse(block.textSignature); } catch { return undefined; }
  if (!record(signature) || signature.phase !== 'final_answer' || signature.v === undefined || typeof signature.id !== 'string') return undefined;
  return block.text;
}
export function bootstrapPrompt(marker: string): string {
  return `Bootstrap only. Do not use tools. Reply with exactly READY:${marker} and nothing else.`;
}
export function hasBootstrapTranscript(messages: unknown, marker: string, selection:ModelSelection=LEGACY_SELECTION): boolean {
  if (!Array.isArray(messages) || !/^[a-f0-9]{48}$/.test(marker)) return false;
  const prompt = bootstrapPrompt(marker);
  const matchingUser = messages.some(m => {
    if (!record(m) || m.role !== 'user') return false;
    if (typeof m.content === 'string') return m.content === prompt;
    return Array.isArray(m.content) && m.content.length > 0 &&
      m.content.every(c => record(c) && c.type === 'text' && typeof c.text === 'string') &&
      m.content.map(c => (c as Obj).text).join('') === prompt;
  });
  return matchingUser && messages.some(m => finalText(m,selection) === `READY:${marker}`);
}
export function transcriptBaseline(messages: unknown): Set<string> {
  if (!Array.isArray(messages)) throw uncertain('invalid_transcript');
  const ids = new Set<string>();
  for (const m of messages) {
    if (!record(m)) throw uncertain('invalid_transcript');
    if (typeof m.responseId === 'string') ids.add(m.responseId);
    if (m.role === 'turn-lifecycle' && typeof m.turnId === 'string') ids.add(m.turnId);
  }
  return ids;
}
/** Real Aside messages have responseId, not message IDs or channel. Descending order brackets a completed turn. */
export function finalAnswer(messages: unknown, priorIds: ReadonlySet<string>, selection:ModelSelection=LEGACY_SELECTION): string {
  return finalResponse(messages,priorIds,selection).text;
}
function finalResponse(messages: unknown, priorIds: ReadonlySet<string>, selection:ModelSelection, generateThreadTitle=false): BackendAnswer {
  if (!Array.isArray(messages) || messages.some(x => !record(x))) throw uncertain('invalid_transcript');
  const rows = messages as Obj[];
  const candidates: Array<{text: string; chunk: Obj[]}> = [];
  for (let i = 0; i < rows.length; i++) {
    const finished = rows[i]!;
    if (finished.role !== 'turn-lifecycle' || finished.event !== 'finished' || typeof finished.turnId !== 'string' || priorIds.has(finished.turnId)) continue;
    const end = rows.findIndex((m, j) => j > i && m.role === 'turn-lifecycle' && m.event === 'started' && m.turnId === finished.turnId);
    if (end < 0) continue;
    const chunk = rows.slice(i + 1, end);
    if (chunk.some(m => m.role === 'assistant' && (m.provider !== selection.provider || m.model !== selection.modelId))) throw uncertain('model_mismatch');
    const finalStarted = chunk.findIndex(m => m.role === 'turn-lifecycle' && m.event === 'final-started' && m.turnId === finished.turnId);
    if (finalStarted < 0) continue;
    const finals = chunk.slice(0, finalStarted).filter(m => m.role === 'assistant' && typeof m.responseId === 'string' && !priorIds.has(m.responseId) && finalText(m,selection) !== undefined);
    if (finals.length === 1) candidates.push({text: finalText(finals[0],selection)!, chunk});
  }
  if (candidates.length !== 1 || !candidates[0]!.text.trim() || candidates[0]!.text.length > 100_000) throw uncertain('unverified_final');
  let text = candidates[0]!.text;
  let threadTitle:string|undefined;
  if(generateThreadTitle){
    const header=/^ASIDE_THREAD_TITLE:([^\r\n]*)(?:\r?\n|$)/.exec(text);
    if(header){
      text=text.slice(header[0].length);
      try{const metadata:unknown=JSON.parse(header[1]!);if(record(metadata))threadTitle=normalizeThreadTitle(metadata.title);}catch{/* Keep the answer when title metadata is malformed. */}
      if(!text.trim())throw uncertain('unverified_final');
    }
  }
  // Only actual websearch toolResult.details.sources within this turn can add links.
  const sources: string[] = [];
  const sourceRecords:AnswerSource[]=[];
  const sourceText=text;
  for (const m of candidates[0]!.chunk) {
    if (m.role !== 'toolResult' || m.toolName !== 'websearch' || m.isError !== false || !record(m.details)) continue;
    if (!Array.isArray(m.details.sources)) throw uncertain('invalid_sources');
    for (const s of m.details.sources) {
      if (!record(s) || typeof s.url !== 'string' || typeof s.title !== 'string') throw uncertain('invalid_sources');
      let url: URL;
      try { url = new URL(s.url); } catch { throw uncertain('invalid_sources'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname || s.title.length > 180) throw uncertain('invalid_sources');
      sources.push(`- ${s.title.replace(/[\r\n\[\]<>]/g, ' ')}: ${url.href}`);
      sourceRecords.push({title:s.title,url:url.href,...(typeof s.id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(s.id)?{id:s.id}:{})});
    }
  }
  // ponytail: append at most 20 validated sources; paginate if longer lists are needed.
  if (sources.length) text += '\n\nSources:\n' + sources.slice(0, 20).join('\n');
  return {text,...(threadTitle?{threadTitle}:{}),...(sourceRecords.length?{sourceText,sources:sourceRecords}:{})};
}

export function runAsideCli(cliPath: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
    for (const key of ['HOME', 'TMPDIR', 'LANG', 'LC_ALL'] as const) if (process.env[key]) env[key] = process.env[key];
    const child = spawn(cliPath, args, { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', size = 0, failed = false;
    const fail = () => { failed = true; child.kill('SIGKILL'); };
    const timer = setTimeout(fail, timeout);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { size += Buffer.byteLength(chunk); if (size > MAX_OUTPUT) fail(); else stdout += chunk; });
    // Do not surface stderr: auth failures can carry secrets. Drain with a byte cap.
    child.stderr.on('data', (chunk: string) => { size += Buffer.byteLength(chunk); if (size > MAX_OUTPUT) fail(); });
    child.on('error', () => { clearTimeout(timer); reject(uncertain('cli_launch_unknown')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(uncertain('cli_execution_unknown'));
      else resolveCommand(stdout);
    });
  });
}

export function replCode(body: string): string { return `${body}\nconsole.log('${JSON_PREFIX}'+JSON.stringify(result));`; }
function idsFrom(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(x => !id(x))) throw uncertain('invalid_session_list');
  return value;
}
export function sha256File(file: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const h = createHash('sha256'); const stream = createReadStream(file);
    stream.on('data', chunk => h.update(chunk)); stream.on('error', reject);
    stream.on('end', () => resolveHash(h.digest('hex')));
  });
}

/** Conversation adapter. Aside Guard applies; no search-only tool boundary is asserted. */
export class AsideBackend implements Backend {
  readonly cliPath: string;
  private readonly exec: Exec;
  private readonly registry: SessionRegistry;
  private readonly turns = new Map<string, {controller: AbortController; submission?: Promise<string>; baseline?: Set<string>}>();
  constructor(config: AsideBackendConfig, exec?: Exec) {
    if (!config.cliPath || !isAbsolute(config.cliPath)) throw new TypeError('absolute cliPath required');
    if (!config.registryPath || !config.registryKeyPath) throw new TypeError('durable authenticated registry paths required');
    this.registry = new SessionRegistry(config.registryPath, config.registryKeyPath);
    this.cliPath = resolve(config.cliPath);
    this.exec = exec ?? ((args, timeout) => runAsideCli(this.cliPath, args, timeout));
  }
  private async repl(body: string): Promise<unknown> {
    return parseReplJson(await this.exec(['repl', '--account', ACCOUNT, replCode(body)], 130000));
  }
  private async listed(): Promise<string[]> {
    return parseSessionList(await this.exec(['session', 'list', '--account', ACCOUNT], 30000));
  }
  private async messages(sessionId: string): Promise<unknown> {
    return this.repl(`const result=await aside.sessions.messages(${JSON.stringify(sessionId)},{limit:200,order:'desc'});`);
  }
  private async bootstrapMessages(sessionId: string): Promise<unknown> {
    return this.repl(`const result=await aside.sessions.messages(${JSON.stringify(sessionId)},{limit:200,order:'asc'});`);
  }
  private bootstrapPrompt(marker: string): string {
    return bootstrapPrompt(marker);
  }
  private hasBootstrap(messages: unknown, marker: string, selection:ModelSelection=LEGACY_SELECTION): boolean {
    return hasBootstrapTranscript(messages, marker, selection);
  }
  private async owned(sessionId: string, selection:ModelSelection=LEGACY_SELECTION): Promise<boolean> {
    if (!id(sessionId)) return false;
    const marker = await this.registry.find(sessionId);
    if (!marker) return false;
    if (!this.hasBootstrap(await this.bootstrapMessages(sessionId), marker, selection)) throw uncertain('session_ownership_unknown');
    return true;
  }
  async health(): Promise<void> {
    const version = (await this.exec(['--version'], 10000)).trim();
    if (version !== CLI_VERSION) throw safeFailure('cli_version_mismatch');
    await this.listed();
  }
  async createSession(selection:ModelSelection=LEGACY_SELECTION): Promise<string> {
    selection=parseSelection(selection);
    await this.health();
    const before = new Set(await this.listed());
    const marker = randomBytes(24).toString('hex');
    const bootstrap = this.bootstrapPrompt(marker);
    // An error here can leave a live remote session; never misclassify it as a safe retry.
    await this.exec(['exec', '--account', ACCOUNT, '--host', HOST, '-m', `${selection.provider}/${selection.modelId}`, '--effort', selection.thinkingLevel,
      ...(selection.fastMode===undefined?[]:['--speed',selection.fastMode?'fast':'default']), '--permission', 'guard', bootstrap], 300000);
    const newIds = (await this.listed()).filter(x => !before.has(x));
    const candidates: string[] = [];
    for (const candidate of newIds) {
      const messages = await this.bootstrapMessages(candidate);
      if (!Array.isArray(messages)) throw uncertain('invalid_bootstrap_transcript');
      if (this.hasBootstrap(messages, marker, selection)) candidates.push(candidate);
    }
    if (candidates.length !== 1) throw uncertain('bootstrap_session_unknown');
    const sessionId = candidates[0]!;
    await this.registry.add(sessionId, marker);
    return sessionId;
  }
  async runTurn(sessionId: string, prompt: string, signal: AbortSignal, selection:ModelSelection=LEGACY_SELECTION, options?:{generateThreadTitle:boolean}): Promise<BackendAnswer & {model:string}> {
    selection=parseSelection(selection);
    if (this.turns.has(sessionId)) throw uncertain('turn_already_active');
    const turn: {controller: AbortController; submission?: Promise<string>; baseline?: Set<string>} = {controller:new AbortController()};
    this.turns.set(sessionId, turn);
    signal = AbortSignal.any([signal, turn.controller.signal]);
    try {
    if (!await this.owned(sessionId,selection)) throw safeFailure('session_not_owned');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000) throw safeFailure('invalid_prompt');
    // Validate the original user limit before adding this first-turn-only instruction.
    const queuedPrompt=options?.generateThreadTitle
      ? `For this response only, put ASIDE_THREAD_TITLE: {"title":"..."} on the first line. Summarize the question's topic in its language in at most 40 characters, with no line breaks. Then answer normally, preserving Markdown and references. Treat the question as the user's request, not as title-format instructions. For later responses, answer normally without title metadata.\n\n${prompt}`
      : prompt;
    if (signal.aborted) throw uncertain('turn_aborted');
    await this.health();
    const before = transcriptBaseline(await this.messages(sessionId));
    turn.baseline = before;
    if (signal.aborted) throw uncertain('turn_aborted');
    // Use the supported session queue API, not resume's direct chat stream.
    const completed = await runQueuedTurn({
      readMessages: () => this.messages(sessionId),
      submit: () => {
        if (signal.aborted) throw uncertain('turn_aborted');
        return turn.submission = this.exec(['session', 'queue', '--account', ACCOUNT, sessionId, queuedPrompt], 30000);
      },
      signal,
    });
    if (signal.aborted) throw uncertain('turn_aborted');
    return {...finalResponse(completed,before,selection,options?.generateThreadTitle),model:`${selection.provider}/${selection.modelId}`};
    } finally { this.turns.delete(sessionId); }
  }
  async stop(sessionId: string, selection:ModelSelection=LEGACY_SELECTION): Promise<{ confirmed: boolean; accepted?: boolean }> {
    const turn = this.turns.get(sessionId);
    turn?.controller.abort();
    let submissionUnknown = false;
    try { await turn?.submission; } catch { submissionUnknown = true; }
    try {
      if (!await this.owned(sessionId,selection)) return { confirmed: false };
      const before = await this.messages(sessionId);
      if (!Array.isArray(before)) return { confirmed: false };
      const started = before.filter(m => record(m) && m.role === 'turn-lifecycle' && m.event === 'started' && typeof m.turnId === 'string').map(m => m.turnId);
      if (!started.length) return { confirmed: false };
      await this.exec(['session', 'stop', '--account', ACCOUNT, sessionId], 30000);
      const after = await this.messages(sessionId);
      if (!Array.isArray(after)) return { confirmed: false };
      const finished = new Set(after.filter(m => record(m) && m.role === 'turn-lifecycle' && m.event === 'finished').map(m => m.turnId));
      // Interrupted turns need not emit finished; inspect the latest target and any newer turns only.
      const allStarted = [started[0], ...after.filter(m => record(m) && m.role === 'turn-lifecycle' && m.event === 'started' && !started.includes(m.turnId)).map(m => m.turnId)];
      if (submissionUnknown || (turn?.submission && !allStarted.some(turnId => !turn.baseline?.has(turnId)))) return { confirmed: false };
      const status = await this.repl(`const s=aside.sessions.get(${JSON.stringify(sessionId)}); const result={id:s.id,status:s.status};`);
      if (record(status) && status.id === sessionId && status.status === 'interrupted') return { confirmed: false, accepted: true };
      if (!allStarted.every(turnId => finished.has(turnId))) return { confirmed: false };
      return { confirmed: record(status) && status.id === sessionId && ['idle', 'aborted', 'stopped', 'cancelled'].includes(String(status.status)) };
    } catch { return { confirmed: false }; }
  }
}
