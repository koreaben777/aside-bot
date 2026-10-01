import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsideBackend, CLI_VERSION, MODEL, READ_ONLY_POLICY, bootstrapPrompt, hasBootstrapTranscript, finalAnswer, parseReplJson, parseSessionList } from '../src/aside/backend.js';
import { BackendFailureError, ExecutionUncertainError, type ModelSelection } from '../src/types.js';
import { SessionRegistry } from '../src/aside/registry.js';
import { hasToolDecision } from '../src/aside/operator-certify.js';

const frame = (value: unknown) => `ASIDE_BOT_JSON:${JSON.stringify(value)}\n`;
const assistant = (text: string, responseId: string) => ({
  role: 'assistant', provider: 'openai-codex', model: 'gpt-6-luna', stopReason: 'stop', responseId,
  content: [{ type: 'thinking', thinking: 'NEVER RELEASE' }, { type: 'text', text, textSignature: JSON.stringify({ v: 1, id: responseId, phase: 'final_answer' }) }],
});
const turnRows = (turnId: string, text: string, responseId: string, source: unknown[] = []) => [
  { role: 'turn-lifecycle', event: 'finished', turnId }, assistant(text, responseId),
  { role: 'turn-lifecycle', event: 'final-started', turnId }, ...source,
  { role: 'turn-lifecycle', event: 'started', turnId },
];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'aside-adapter-'));
  const cliPath = join(dir, 'aside'); writeFileSync(cliPath, 'test executable');
  const registryPath = join(dir, 'registry.json');
  const registryKeyPath = join(dir, 'registry.key');
  return { dir, cliPath, registryPath, registryKeyPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('initial title metadata is separated without extra turns or lost sources',async()=>{
 const f=fixture(),marker='a'.repeat(48);let queued=0;
 const prompts:string[]=[];
 const source=[{role:'toolResult',toolName:'websearch',isError:false,details:{sources:[{id:'searchSource',title:'Source',url:'https://example.org/'}]}}];
 try{
  await new SessionRegistry(f.registryPath,f.registryKeyPath).add('ses_test123',marker);
  for(const header of ['ASIDE_THREAD_TITLE: {"title":"향수\\n추천\\u0000"}','ASIDE_THREAD_TITLE: broken','ASIDE_THREAD_TITLE: {"title":42}','ASIDE_THREAD_TITLE: {"title":"'+ '😀'.repeat(45)+'"}',null]){
   let submitted=false;
   const backend=new AsideBackend(f,async args=>{
    if(args[0]==='--version')return CLI_VERSION;
    if(args[1]==='list')return 'ses_test123  idle  ephemeral  title';
    if(args[1]==='queue'){queued++;prompts.push(args.at(-1)!);submitted=true;return 'ok';}
    if(args.at(-1)!.includes("order:'asc'"))return frame([{role:'user',content:bootstrapPrompt(marker)},assistant(`READY:${marker}`,'boot')]);
    return frame(submitted?turnRows('new',(header?header+'\n':'')+'Answer','resp',source):turnRows('boot',`READY:${marker}`,'boot'));
   });
   const question='Q'.repeat(8000);
   const result=await Reflect.apply(backend.runTurn,backend,['ses_test123',question,new AbortController().signal,undefined,{generateThreadTitle:true}]);
   assert.equal(result.text,'Answer\n\nSources:\n- Source: https://example.org/');
   assert.equal(Reflect.get(result,'sourceText'),'Answer');
   assert.deepEqual(Reflect.get(result,'sources'),[{id:'searchSource',title:'Source',url:'https://example.org/'}]);
   assert.equal(result.threadTitle,header?.includes('향수')?'향수 추천':header?.includes('😀')?'😀'.repeat(40):undefined);
   assert.ok(prompts.at(-1)!.includes(question));assert.ok(prompts.at(-1)!.includes('ASIDE_THREAD_TITLE:'));
  }
  assert.equal(queued,5);
 }finally{f.cleanup();}
});

test('conversation health needs CLI connection, not a policy certificate', async () => {
 const f=fixture();const calls:string[][]=[];
 try {const backend=new AsideBackend(f,async args=>{calls.push(args);return args[0]==='--version'?CLI_VERSION:'No sessions.';});
 await backend.health();assert.equal(calls.length,2);
 } finally {f.cleanup();}
});
test('wrong CLI version and failed connection never launch a session',async()=>{
 const f=fixture();
 try {for(const bad of ['version','connection']) {
 const calls:string[][]=[];const backend=new AsideBackend(f,async args=>{calls.push(args);if(args[0]==='--version')return bad==='version'?'wrong':CLI_VERSION;throw Error('offline');});
 await assert.rejects(backend.createSession());assert.ok(!calls.some(x=>x[0]==='exec'));}}
 finally {f.cleanup();}
});

test('CLI args keep prompt as one literal token; new session is bound by bootstrap marker', async () => {
  const f = fixture();
  const commands: string[][] = []; let bootstrap = '', marker = '', created = false, turn = false;
  const hostile = 'Search \"; touch /tmp/not-a-real-target; $(echo pwn)\\n';
  const exec = async (args: string[]) => {
    commands.push(args);
    if (args[0] === '--version') return CLI_VERSION + '\n';
    if (args[0] === 'exec') {
      bootstrap = args.at(-1)!; marker = bootstrap.match(/READY:([a-f0-9]{48})/)![1]!; created = true;
      return 'untrusted CLI chatter';
    }
    if (args[0] === 'session' && args[1] === 'list') return created ? 'ses_test123  idle  ephemeral  Bootstrap readiness confirmation  2026-09-28T07:33:21.000Z\n' : 'No sessions.\n';
    if (args[0] === 'session' && args[1] === 'queue') { turn = true; return 'ok  running'; }
    if (args[0] === 'repl') {
      const code = args.at(-1)!;
      if (code.includes('sessions.list')) throw Error('REPL list omits ephemeral CLI sessions');
      if (code.includes('sessions.messages')) return frame(code.includes("order:'asc'")
        ? [{ role: 'user', content: [{type:'text',text:bootstrap}] }, assistant(`READY:${marker}`, 'resp_boot')]
        : turn
          ? [...turnRows('turn_new', 'Safe result', 'resp_new'), ...turnRows('turn_boot', `READY:${marker}`, 'resp_boot')]
          : turnRows('turn_boot', `READY:${marker}`, 'resp_boot'));
      if (code.includes('sessions.update')) return frame(true);
    }
    throw Error('unexpected test command');
  };
  try {
    const backend = new AsideBackend(f, exec);
    const sid = await backend.createSession(); assert.equal(sid, 'ses_test123');
    assert.deepEqual(await backend.runTurn(sid, hostile, new AbortController().signal), { text: 'Safe result',model:MODEL });
    const queued = commands.find(x => x[0] === 'session' && x[1] === 'queue')!;
    assert.deepEqual(queued, ['session', 'queue', '--account', 'u0', 'ses_test123', hostile]);
    assert.ok(!commands.some(x => x[0] === 'session' && x[1] === 'resume'));
    assert.ok(!commands.some(x => x.includes('--session') || x.includes('full-access')));
    assert.deepEqual(commands.find(x => x[0] === 'exec')!.slice(0, 12),
      ['exec', '--account', 'u0', '--host', 'local', '-m', MODEL, '--effort', 'medium', '--permission', 'guard', bootstrap]);
    const updates = commands.filter(x => x[0] === 'repl' && x.at(-1)!.includes('sessions.update'));
    assert.equal(updates.length, 0);
    assert.ok(updates.every(x => x.at(-1)!.includes('ses_test123')));
  } finally { f.cleanup(); }
});

test('new selections reach creation args, survive registry adoption and reject a wrong bootstrap model',async()=>{
 const selections:ModelSelection[]=[
  {provider:'openai-codex',modelId:'gpt-6-luna',thinkingLevel:'max',fastMode:true},
  {provider:'openai-codex',modelId:'gpt-5.6-sol',thinkingLevel:'medium',fastMode:false},
  {provider:'openai-codex',modelId:'gpt-6-sol',thinkingLevel:'xhigh',fastMode:false},
 ];
 for(const [selection,wrongBootstrap] of [...selections.map(s=>[s,false] as const),[selections[2]!,true] as const]){
  const f=fixture(),calls:string[][]=[];let created=false,queued=false,bootstrap='',marker='';
  const withModel=(rows:unknown[])=>rows.map(row=>{const r=row as Record<string,unknown>;return r.role==='assistant'?{...r,model:wrongBootstrap?'gpt-6-luna':selection.modelId}:r;});
  const exec=async(args:string[],timeout:number)=>{
   calls.push(args);
   if(args[0]==='--version')return CLI_VERSION;
   if(args[0]==='exec'){assert.equal(timeout,300000);bootstrap=args.at(-1)!;marker=bootstrap.match(/READY:([a-f0-9]{48})/)![1]!;created=true;return '';}
   if(args[0]==='session'&&args[1]==='list')return created?'ses_selected  idle  ephemeral  bootstrap  timestamp':'No sessions.';
   if(args[0]==='session'&&args[1]==='queue'){queued=true;return 'ok running';}
   if(args[0]==='session'&&args[1]==='stop')return '';
   if(args[0]==='repl'){
    const code=args.at(-1)!;
    if(code.includes('sessions.get'))return frame({id:'ses_selected',status:'idle'});
    if(code.includes("order:'asc'"))return frame(withModel([{role:'user',content:bootstrap},assistant(`READY:${marker}`,'resp_boot')]));
    return frame(withModel([...(queued?turnRows('turn_new','Selected answer','resp_new'):[]),...turnRows('turn_boot',`READY:${marker}`,'resp_boot')]));
   }
   throw Error('unexpected selected command');
  };
  try{
   const backend=new AsideBackend(f,exec);
   if(wrongBootstrap)await assert.rejects(backend.createSession(selection),ExecutionUncertainError);
   else{
    const sid=await backend.createSession(selection),reopened=new AsideBackend(f,exec);
    assert.deepEqual(await reopened.runTurn(sid,'Question',new AbortController().signal,selection),{text:'Selected answer',model:`${selection.provider}/${selection.modelId}`});
    assert.deepEqual(await reopened.stop(sid,selection),{confirmed:true});
   }
   assert.deepEqual(calls.find(args=>args[0]==='exec')!.slice(5,-1),['-m',`${selection.provider}/${selection.modelId}`,'--effort',selection.thinkingLevel,'--speed',selection.fastMode?'fast':'default','--permission','guard']);
   assert.ok(!calls.some(args=>args.at(-1)!.includes('sessions.update')));
  }finally{f.cleanup();}
 }
});

test('only completed fresh final-answer text is released, with real tool-result sources', () => {
  const before = new Set(['turn_old', 'resp_old']);
  const source = [{ role: 'toolResult', toolName: 'websearch', toolCallId: 'call1', isError: false, details: { sources: [{ title: 'Source', url: 'https://example.org/path' }] } }];
  assert.equal(finalAnswer([...turnRows('turn_new', 'Answer', 'resp_new', source), ...turnRows('turn_old', 'Old private text', 'resp_old')], before), 'Answer\n\nSources:\n- Source: https://example.org/path');
  assert.throws(() => finalAnswer([assistant('No lifecycle', 'resp_new')], new Set()), ExecutionUncertainError);
  assert.throws(() => finalAnswer(turnRows('turn_new', 'x', 'resp_new').map(x => (x as Record<string, unknown>).role === 'assistant' ? { ...(x as object), model: 'gpt-6-astra' } : x), new Set()), ExecutionUncertainError);
  assert.throws(() => finalAnswer(turnRows('turn_new', 'x', 'resp_new').map(x => (x as Record<string, unknown>).role === 'assistant' ? { ...(x as object), content: [{ type: 'text', text: 'x' }] } : x), new Set()), ExecutionUncertainError);
  assert.throws(() => finalAnswer(turnRows('turn_new', 'x', 'resp_new', [{ ...source[0], details: { sources: [{ title: 'bad', url: 'file:///etc/passwd' }] } }]), new Set()), ExecutionUncertainError);
  assert.throws(() => parseReplJson('unmarked stdout'), ExecutionUncertainError);
});

test('more than 20 valid search sources limit appended links without rejecting the answer', () => {
  const searches = Array.from({length: 3}, (_, search) => ({
    role: 'toolResult', toolName: 'websearch', isError: false,
    details: {sources: Array.from({length: 10}, (_, i) => ({title: `Source ${search * 10 + i}`, url: `https://example.org/${search * 10 + i}`}))},
  }));
  const answer = finalAnswer(turnRows('turn_new', 'Answer', 'resp_new', searches), new Set());
  assert.equal(answer, 'Answer\n\nSources:\n' + searches.flatMap(s => s.details.sources).slice(0, 20).map(s => `- ${s.title}: ${s.url}`).join('\n'));
  searches[2]!.details.sources[9]!.url = 'file:///etc/passwd';
  assert.throws(() => finalAnswer(turnRows('turn_new', 'Answer', 'resp_new', searches), new Set()), ExecutionUncertainError);
});

test('stop never claims confirmation from CLI exit alone', async () => {
  const f = fixture();  let stopped = false;
  const marker = 'a'.repeat(48);
  try {
    await new SessionRegistry(f.registryPath, f.registryKeyPath).add('ses_test123', marker);
    const backend = new AsideBackend(f, async args => {
      if (args[0] === 'session') { stopped = true; return ''; }
      if (args.at(-1)?.includes("order:'desc'")) return frame([{role:'turn-lifecycle',event:'started',turnId:'active'}]);
      if (args.at(-1)?.includes('sessions.messages')) return frame([
        { role: 'user', content: `Bootstrap only. Do not use tools. Reply with exactly READY:${marker} and nothing else.` },
        assistant(`READY:${marker}`, 'resp_boot'),
      ]);
      return frame({ id: 'ses_test123', status: 'running' });
    });
    assert.deepEqual(await backend.stop('ses_test123'), { confirmed: false });
    assert.equal(stopped, true);
    assert.deepEqual(await backend.stop('ses_unowned'), { confirmed: false });
  } finally { f.cleanup(); }
});


test('restart adoption requires the authenticated bootstrap registry, never a caller ID list', async () => {
  const f = fixture();  let calls = 0;
  try {
    const backend = new AsideBackend({ ...f, existingSessionIds: ['ses_forced'] }, async () => { calls++; return ''; });
    await assert.rejects(backend.runTurn('ses_forced', 'hello', new AbortController().signal), ExecutionUncertainError);
    assert.equal(calls, 0);
    const registry = new SessionRegistry(f.registryPath, f.registryKeyPath);
    await registry.add('ses_owned123', 'b'.repeat(48));
    await assert.rejects(backend.runTurn('ses_forced', 'hello', new AbortController().signal), e => e instanceof BackendFailureError && e.code === 'session_not_owned');
    assert.equal(await registry.find('ses_owned123'), 'b'.repeat(48));
    const data = JSON.parse(readFileSync(f.registryPath, 'utf8'));
    data.entries[0].sessionId = 'ses_forced';
    writeFileSync(f.registryPath, JSON.stringify(data));
    await assert.rejects(registry.find('ses_forced'), ExecutionUncertainError);
  } finally { f.cleanup(); }
});

test('operator probe refuses assistant claims and prose-only tool output', () => {
  const command = 'printf ASIDE_DENY_PROBE';
  const call = { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call1', name: 'bash', arguments: { command } }] };
  assert.equal(hasToolDecision([{ role: 'assistant', content: 'The bash tool was denied' }], 'bash', command, 'denied'), false);
  assert.equal(hasToolDecision([call, { role: 'toolResult', toolCallId: 'call1', toolName: 'bash', content: 'permission denied', isError: true, details: { runtime: {} } }], 'bash', command, 'denied'), false);
  const denial = { role: 'toolResult', toolCallId: 'call1', toolName: 'bash', isError: true, details: {}, content:[{type:'text',text:"Permission denied: tool 'bash' usage is blocked by policy"}] };
  assert.equal(hasToolDecision([call, denial], 'bash', command, 'denied'), true);
  assert.equal(hasToolDecision([call, {...denial,isError:false}], 'bash', command, 'denied'), false);
  assert.equal(hasToolDecision([call, {...denial,toolCallId:'other-call'}], 'bash', command, 'denied'), false);
  assert.equal(hasToolDecision([call, denial], 'bash', 'another command', 'denied'), false);
  assert.equal(hasToolDecision([call, { role: 'toolResult', toolCallId: 'call1', toolName: 'bash', isError: false, details: { runtime: { exitCode: 0 } } }], 'bash', command, 'denied'), false);
});


test('bootstrap ownership accepts actual text-block messages but never an assistant-only or mismatched marker',()=>{
 const marker='a'.repeat(48);
 const rows=[{role:'user',content:[{type:'text',text:bootstrapPrompt(marker)}]},assistant(`READY:${marker}`,'resp_boot')];
 assert.equal(hasBootstrapTranscript(rows,marker),true);
 assert.equal(hasBootstrapTranscript(rows,'b'.repeat(48)),false);
 assert.equal(hasBootstrapTranscript(rows.slice(1),marker),false);
 assert.equal(hasBootstrapTranscript([{role:'user',content:[{type:'image',text:bootstrapPrompt(marker)}]},rows[1]],marker),false);
 assert.equal(hasBootstrapTranscript([{role:'user',content:bootstrapPrompt(marker)},rows[1]],marker),true);
});

test('search allow rule uses runtime-validated typed objects, not unsupported strings',()=>{
 assert.deepEqual(READ_ONLY_POLICY.permission.rules.allow,[{type:'tool',tool:'websearch'}]);
 assert.equal(READ_ONLY_POLICY.permission.rules.default,'deny');
});


test('documented CLI session list includes ephemeral sessions and rejects unknown formats',()=>{
 assert.deepEqual(parseSessionList('No sessions.\n'),[]);
 assert.deepEqual(parseSessionList('LwYkKLBgy9MmPaXA  idle  ephemeral  Bootstrap readiness confirmation  2026-09-28T07:33:21.000Z\nother_id123  running  persistent  A title  2026-09-28T07:34:00.000Z\n'),['LwYkKLBgy9MmPaXA','other_id123']);
 assert.deepEqual(parseSessionList('known_id123  idle  ephemeral  Title\ncontinuation text\n'),['known_id123']);
 assert.throws(()=>parseSessionList(''),ExecutionUncertainError);
 assert.throws(()=>parseSessionList('unrecognized output'),ExecutionUncertainError);
});


test('search policy explicitly denies execution and file tools without denying websearch',()=>{
 const rules=READ_ONLY_POLICY.permission.rules;
 assert.equal(rules.default,'deny');
 assert.deepEqual(rules.allow,[{type:'tool',tool:'websearch'}]);
 assert.deepEqual(rules.deny.map(r=>r.tool),['bash','repl','read_file','write_file','edit_file','subagent']);
 assert.ok(rules.deny.every(r=>r.type==='tool'));
 assert.ok(!rules.deny.some(r=>r.tool==='websearch'));
 assert.deepEqual(rules.approved,[]);
});

test('stop confirms remote idle or aborted only with completed turn records',async()=>{
 const f=fixture(),marker='c'.repeat(48);
 try {
 await new SessionRegistry(f.registryPath,f.registryKeyPath).add('ses_test123',marker);
 for(const [status,finished,expected] of [['aborted',true,true],['idle',true,true],['idle',false,false],['running',true,false]] as const){
  let stopSent=false;
  const backend=new AsideBackend(f,async args=>{
   if(args[0]==='session'){stopSent=true;return 'ok';}
   const code=args.at(-1)!;
   if(code.includes("order:'asc'"))return frame([{role:'user',content:bootstrapPrompt(marker)},assistant(`READY:${marker}`,'boot')]);
   if(code.includes('sessions.messages'))return frame([...(stopSent&&finished?[{role:'turn-lifecycle',event:'finished',turnId:'live'}]:[]),{role:'turn-lifecycle',event:'started',turnId:'live'}]);
   return frame({id:'ses_test123',status});
  });
  assert.deepEqual(await backend.stop('ses_test123'),{confirmed:expected});
 }
 }finally{f.cleanup();}
});

test('a wrong intermediate model invalidates the entire fresh turn',()=>{
 const rows=turnRows('new','Final','resp');
 rows.splice(3,0,{role:'assistant',provider:'openai',model:'other',stopReason:'toolUse',content:[]} as never);
 assert.throws(()=>finalAnswer(rows,new Set()),ExecutionUncertainError);
});

test('stop waits for pending queue acceptance and never confirms from an older idle turn',async()=>{
 const f=fixture(),marker='d'.repeat(48);let queued=false,stopCalls=0;
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 try {
 await new SessionRegistry(f.registryPath,f.registryKeyPath).add('ses_test123',marker);
 const backend=new AsideBackend(f,async args=>{
  if(args[0]==='--version')return CLI_VERSION;
  if(args[1]==='list')return 'ses_test123  idle  ephemeral  title';
  if(args[1]==='queue'){queued=true;await gate;return 'ok';}
  if(args[1]==='stop'){stopCalls++;return 'ok';}
  if(args.at(-1)!.includes("order:'asc'"))return frame([{role:'user',content:bootstrapPrompt(marker)},assistant(`READY:${marker}`,'boot')]);
  if(args.at(-1)!.includes('sessions.messages'))return frame(turnRows('boot','READY','boot'));
  return frame({id:'ses_test123',status:'idle'});
 });
 const running=backend.runTurn('ses_test123','hello',new AbortController().signal).catch(()=>{});
 while(!queued)await new Promise(r=>setTimeout(r,1));
 const stopping=backend.stop('ses_test123');await new Promise(r=>setTimeout(r,10));
 assert.equal(stopCalls,0);release();assert.deepEqual(await stopping,{confirmed:false});await running;
 }finally{release?.();f.cleanup();}
});

test('interrupted is acknowledged separately from completed termination',async()=>{
 const f=fixture(),marker='e'.repeat(48);
 try {await new SessionRegistry(f.registryPath,f.registryKeyPath).add('ses_test123',marker);
 const backend=new AsideBackend(f,async args=>{
  if(args[0]==='session')return 'ok';
  if(args.at(-1)!.includes("order:'asc'"))return frame([{role:'user',content:bootstrapPrompt(marker)},assistant(`READY:${marker}`,'boot')]);
  if(args.at(-1)!.includes('sessions.messages'))return frame([{role:'turn-lifecycle',event:'started',turnId:'interrupted-turn'}]);
  return frame({id:'ses_test123',status:'interrupted'});
 });
 assert.deepEqual(await backend.stop('ses_test123'),{confirmed:false,accepted:true});
 }finally{f.cleanup();}
});

test('historical interrupted turns do not prevent confirming a later completed turn',async()=>{
 const f=fixture(),marker='f'.repeat(48);
 try {await new SessionRegistry(f.registryPath,f.registryKeyPath).add('ses_test123',marker);
 const backend=new AsideBackend(f,async args=>{
 if(args[0]==='session')return 'ok';
 if(args.at(-1)!.includes("order:'asc'"))return frame([{role:'user',content:bootstrapPrompt(marker)},assistant(`READY:${marker}`,'boot')]);
 if(args.at(-1)!.includes('sessions.messages'))return frame([...turnRows('latest','done','response'),{role:'turn-lifecycle',event:'started',turnId:'historical-interrupted'}]);
 return frame({id:'ses_test123',status:'idle'});
 });assert.deepEqual(await backend.stop('ses_test123'),{confirmed:true});
 }finally{f.cleanup();}
});

test('bootstrap and fresh answer validate the selected model rather than fixed Luna',()=>{
 const selection={provider:'openai-codex',modelId:'gpt-5.6-sol',thinkingLevel:'medium',fastMode:false};
 const marker='a'.repeat(48);
 const selected=(text:string,response:string)=>({...assistant(text,response),model:'gpt-5.6-sol'});
 assert.equal(Reflect.apply(hasBootstrapTranscript,null,[[{role:'user',content:bootstrapPrompt(marker)},selected(`READY:${marker}`,'boot')],marker,selection]),true);
 const rows=turnRows('new','Selected answer','response').map(row=>(row as {role:string}).role==='assistant'?{...(row as object),model:'gpt-5.6-sol'}:row);
 assert.equal(Reflect.apply(finalAnswer,null,[rows,new Set(),selection]),'Selected answer');
 assert.throws(()=>Reflect.apply(finalAnswer,null,[turnRows('new','Wrong answer','response'),new Set(),selection]),ExecutionUncertainError);
});
