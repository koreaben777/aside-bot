import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {certifyAsideLive,CertificationBlockedError} from '../src/aside/operator-certify.js';
import {CLI_VERSION,POLICY_SHA256,READ_ONLY_POLICY,type runAsideCli} from '../src/aside/backend.js';

type Row=Record<string,any>;
const framed=(x:unknown)=>'ASIDE_BOT_JSON:'+JSON.stringify(x)+'\n';

async function fixture(unsafeTool=false){
 const dir=await mkdtemp(join(tmpdir(),'aside-certification-'));
 const cliPath=join(dir,'aside');
 const privatePath=join(dir,'operator.pem');
 const certificatePath=join(dir,'certificate.json');
 await writeFile(cliPath,'test CLI executable');
 const keys=generateKeyPairSync('ed25519');
 await writeFile(privatePath,keys.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
 const rows:Row[]=[]; const events:Array<{stage:string;sessionId?:string}>=[];
 let created=false,stopped=false,modeApplied=false,policyApplied=false,probe=0;
 const final=(text:string)=>({role:'assistant',provider:'openai-codex',model:'gpt-6-luna',stopReason:'stop',responseId:'response-'+probe,content:[{type:'text',text,textSignature:JSON.stringify({v:1,id:'message-'+probe,phase:'final_answer'})}]});
 const run:typeof runAsideCli=async(_path,args)=>{
  if(args[0]==='--version')return CLI_VERSION+'\n';
  if(args[0]==='session'&&args[1]==='list')return created?'test_session123  idle  ephemeral  Bootstrap confirmation  2026-09-28T07:33:21.000Z\n':'No sessions.\n';
  if(args[0]==='exec'){
   assert.equal(args.at(-2),'guard');
   const prompt=args.at(-1)!;const marker=prompt.match(/READY:([a-f0-9]{48})/)![1]!;
   rows.push({role:'user',content:[{type:'text',text:prompt}]},final('READY:'+marker));created=true;return 'Ignored output';
  }
  if(args[0]==='repl'){
   const code=args.at(-1)!;
   if(code.includes('sessions.messages'))return framed(rows);
   if(code.includes('sessions.childSessions'))return framed([]);
   if(code.includes('sessions.update')){
    if(code.includes("permissionMode:'read-only'"))modeApplied=true;
    else {assert.equal(modeApplied,true);assert.ok(code.includes(JSON.stringify(READ_ONLY_POLICY.permission)));policyApplied=true;}
    return framed(true);
   }
   throw Error('Unexpected REPL call');
  }
  if(args[0]==='session'&&args[1]==='queue'){
   assert.equal(policyApplied,true);probe++;
   rows.push({role:'turn-lifecycle',event:'started',turnId:'turn-'+probe});
   const prompt=args.at(-1)!;
   const isChild=prompt.startsWith('Certification probe: invoke subagent');
   const name=isChild?'subagent':prompt.includes('Invoke the bash tool')?'bash':'websearch';
   const arguments_=isChild?{action:'spawn'}:JSON.parse(prompt.match(/with arguments (.*)\. Do not use another tool/)![1]!);
   const callId='call-'+probe;
   rows.push({role:'assistant',provider:'openai-codex',model:'gpt-6-luna',stopReason:'toolUse',content:[{type:'toolCall',id:callId,name,arguments:arguments_}]});
   const success=name==='websearch'||unsafeTool;
   rows.push({role:'toolResult',toolName:name,toolCallId:callId,isError:!success,details:name==='websearch'?{sources:[{title:'Example Domain',url:'https://example.com'}]}:unsafeTool?{runtime:'local-bash',exitCode:0}:{}, content:[{type:'text',text:success?'success':`Permission denied: tool '${name}' usage is blocked by policy`}]});
   rows.push(final('Probe complete'),{role:'turn-lifecycle',event:'finished',turnId:'turn-'+probe});return 'ok  running';
  }
  if(args[0]==='session'&&args[1]==='stop'){stopped=true;return '';}
  throw Error('Unexpected CLI invocation');
 };
 return {options:{cliPath,projectRoot:dir,certificatePath,operatorPrivateKeyPath:privatePath,onProgress:async(event:{stage:string;sessionId?:string})=>{events.push(event);}},run,events,keys,stopped:()=>stopped,cleanup:()=>rm(dir,{recursive:true,force:true})};
}

test('complete operator flow with progress callback binds ephemeral bootstrap, probes tools and issues a verified certificate',async()=>{
 const f=await fixture();
 try{
  await certifyAsideLive(f.options,f.run);
  const cert=JSON.parse(await readFile(f.options.certificatePath,'utf8'));
  assert.equal(cert.payload.policySha256,POLICY_SHA256);
  assert.equal(verify(null,Buffer.from(JSON.stringify(cert.payload)),f.keys.publicKey,Buffer.from(cert.signatureBase64,'base64')),true);
  assert.deepEqual(f.events.map(e=>e.stage),['bootstrap_started','bootstrap_identified','policy_applied','shell_denial_probe','write_denial_probe','search_probe','subagent_denial_probe','all_probes_passed']);
  assert.equal(f.stopped(),true);
 }finally{await f.cleanup();}
});

test('operator flow refuses successful prohibited tools and cleans up without issuing a certificate',async()=>{
 const f=await fixture(true);
 try{
  await assert.rejects(certifyAsideLive(f.options,f.run),e=>e instanceof CertificationBlockedError&&e.reason==='prohibited bash command actually executed despite search-only policy');
  await assert.rejects(access(f.options.certificatePath));
  assert.equal(f.stopped(),true);
 }finally{await f.cleanup();}
});

test('path validation checks only required path fields, still rejects relative paths before CLI use',async()=>{
 const f=await fixture();let calls=0;
 try{
  await assert.rejects(certifyAsideLive({...f.options,projectRoot:'relative'},async()=>{calls++;return '';}),e=>e instanceof CertificationBlockedError&&e.reason==='all paths must be absolute');
  assert.equal(calls,0);
 }finally{await f.cleanup();}
});
