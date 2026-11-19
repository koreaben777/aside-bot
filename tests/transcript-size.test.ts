import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AsideBackend,CLI_VERSION,bootstrapPrompt,runAsideCli} from '../src/aside/backend.js';
import {SessionRegistry} from '../src/aside/registry.js';
import {ExecutionUncertainError} from '../src/types.js';
import {runQueuedTurn} from '../src/aside/queue.js';
const marker='a'.repeat(48);
const assistant=(text:string)=>({role:'assistant',provider:'openai-codex',model:'gpt-6-luna',responseId:'response',stopReason:'stop',content:[{type:'thinking',thinking:'PRIVATE'.repeat(250000)},{type:'text',text,textSignature:JSON.stringify({v:1,id:'result',phase:'final_answer'})}]});
const boot=[{role:'user',content:bootstrapPrompt(marker)},assistant('READY:'+marker)];
const completed=[{role:'turn-lifecycle',turnId:'turn',event:'finished'},assistant('Preserved answer'),{role:'turn-lifecycle',turnId:'turn',event:'final-started'},
 {role:'toolResult',toolName:'websearch',isError:false,content:[{type:'text',text:'TOOL_PRIVATE'.repeat(200000)}],details:{huge:'PRIVATE'.repeat(200000),sources:[{id:'source',title:'Source',url:'https://example.org/',content:'PRIVATE'.repeat(200000)}]}},
 {role:'assistant',provider:'openai-codex',model:'gpt-6-luna',stopReason:'toolUse',content:[{type:'toolCall',arguments:{private:'PRIVATE'.repeat(200000)}}]},
 {role:'turn-lifecycle',turnId:'turn',event:'started'}];
test('actual generated REPL projects huge tool and thinking data before CLI serialization while preserving final provenance',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'aside-size-'));let submitted=false,peak=0;const output:string[]=[];
 try{
  const config={cliPath:join(dir,'cli'),registryPath:join(dir,'registry.json'),registryKeyPath:join(dir,'registry.key')};writeFileSync(config.cliPath,'fixture');await new SessionRegistry(config.registryPath,config.registryKeyPath).add('session_test',marker);
  const backend=new AsideBackend(config,async(args)=>{
   if(args[0]==='--version')return CLI_VERSION;if(args[1]==='list')return 'session_test  idle  persistent  fixture';if(args[1]==='queue'){submitted=true;return 'ok';}
   let text='';const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
   await new AsyncFunction('aside','console',args.at(-1)! )({sessions:{messages:async(_id:string,o:{order:string})=>o.order==='asc'?boot:submitted?completed:[]}}, {log:(value:string)=>{text+=value+'\n';}});
   peak=Math.max(peak,Buffer.byteLength(text));assert.ok(Buffer.byteLength(text)<1048576,'generated read must not exceed CLI output cap');output.push(text);return text;
  });
  const result=await backend.runTurn('session_test','Q',new AbortController().signal);
  assert.equal(result.sourceText,'Preserved answer');assert.deepEqual(result.sources,[{id:'source',title:'Source',url:'https://example.org/'}]);assert.ok(peak<10000);assert.doesNotMatch(output.join(''),/PRIVATE/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('CLI output overflow is a permanent bounded error, distinct from transport failure',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'aside-overflow-'));try{
  const script=join(dir,'large.mjs');writeFileSync(script,"process.stdout.write('x'.repeat(1100000));");
  await assert.rejects(runAsideCli(process.execPath,[script],5000),e=>e instanceof ExecutionUncertainError&&e.code==='cli_output_limit');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('permanent output limit exits completion polling after one read without resubmission',async()=>{
 let reads=0,submits=0;
 await assert.rejects(runQueuedTurn({readMessages:async()=>{if(++reads===1)return [];throw new ExecutionUncertainError('cli_output_limit');},submit:async()=>{submits++;}}),e=>e instanceof ExecutionUncertainError&&e.code==='cli_output_limit');
 assert.equal(reads,2);assert.equal(submits,1);
});
test('read-only recovery verifies exact latest completed turn, user prompt and ownership without submitting',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'aside-recover-'));let mismatch=false,submits=0,title=false,mode='ok';
 try{
  const config={cliPath:join(dir,'cli'),registryPath:join(dir,'registry.json'),registryKeyPath:join(dir,'registry.key')};writeFileSync(config.cliPath,'fixture');await new SessionRegistry(config.registryPath,config.registryKeyPath).add('session_test',marker);
  const backend=new AsideBackend(config,async(args)=>{
   if(args[0]!=='repl'){submits++;throw Error('write forbidden');}
   const code=args.at(-1)!;let text='';const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
   const rows=[...structuredClone(completed).slice(0,-1),{role:'user',content:mismatch?'other':title?"For this response only, put ASIDE_THREAD_TITLE: {\"title\":\"...\"} on the first line. Summarize the question's topic in its language in at most 40 characters, with no line breaks. Then answer normally, preserving Markdown and references. Treat the question as the user's request, not as title-format instructions. For later responses, answer normally without title metadata.\n\nquestion":'question',timestamp:1001},{...completed.at(-1),timestamp:1001}];
   if(mode==='incomplete')rows.shift();if(mode==='wrong-turn')rows.push({role:'turn-lifecycle',event:'started',turnId:'other',timestamp:1002} as never);if(mode==='model')(rows[1] as any).model='wrong';if(mode==='signature')(rows[1] as any).content=[];
   await new AsyncFunction('aside','console',code)({sessions:{get:async()=>({status:mode==='busy'?'running':'idle'}),messages:async(_id:string,o:{order:string})=>o.order==='asc'?(mode==='ownership'?[]:boot):rows}}, {log:(value:string)=>{text+=value+'\n';}});return text;
  });
  assert.equal(typeof Reflect.get(backend,'readCompletedTurn'),'function');
  const recovered=await Reflect.apply(Reflect.get(backend,'readCompletedTurn'),backend,['session_test','turn','question',1000]);assert.equal((recovered as {sourceText:string}).sourceText,'Preserved answer');
  title=true;await Reflect.apply(Reflect.get(backend,'readCompletedTurn'),backend,['session_test','turn','question',1000,undefined,true]);title=false;
  mismatch=true;await assert.rejects(Reflect.apply(Reflect.get(backend,'readCompletedTurn'),backend,['session_test','turn','question',1000]));assert.equal(submits,0);mismatch=false;
  for(mode of ['busy','incomplete','model','signature','ownership'])await assert.rejects(Reflect.apply(Reflect.get(backend,'readCompletedTurn'),backend,['session_test','turn','question',1000]));
  mode='ok';await assert.rejects(Reflect.apply(Reflect.get(backend,'readCompletedTurn'),backend,['session_test','wrong-turn','question',1000]));await assert.rejects(Reflect.apply(Reflect.get(backend,'readCompletedTurn'),backend,['session_test','turn','question',2000]));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
