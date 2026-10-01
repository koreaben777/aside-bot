import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {DatabaseSync} from 'node:sqlite';
import {EventEmitter} from 'node:events';
import {Collection,type Client} from 'discord.js';
import {runInNewContext} from 'node:vm';
import {Engine} from '../src/core/engine.js';
import {AsideSettings} from '../src/aside/settings.js';
import {asideCommand,attachDiscordBot,createDiscordOutbound} from '../src/discord/bot.js';
import {LEGACY_SELECTION,parseSelection,type ModelSelection} from '../src/types.js';

test('new thread and pending request keep the original selection across reopening',()=>{
 const dir=mkdtempSync(join(tmpdir(),'aside-presets-')),file=join(dir,'state.sqlite');
 const selection={provider:'openai-codex',modelId:'gpt-5.6-sol',thinkingLevel:'medium',fastMode:false};
 let store=new Store(file);
 try {
  Reflect.apply(store.bindThread,store,[{threadId:'thread',guildId:'guild',parentChannelId:'parent',ownerUserId:'owner'},'origin',{presetName:'standard',selection}]);
  store.enqueue('source','thread','Question');
  assert.deepEqual(Reflect.get(store.session('thread')!,'selection'),selection);
  assert.deepEqual(Reflect.get(store.requestBySource('source')!,'selection'),selection);
  store.setDefaultPreset('deep');
  store.close();store=new Store(file);
  assert.equal(store.defaultPreset(),'deep');
  assert.deepEqual(Reflect.get(store.session('thread')!,'selection'),selection);
  assert.deepEqual(Reflect.get(store.nextQueued()!,'selection'),selection);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

const config={ownerUserId:'owner',guildId:'guild',channelId:'parent'};
async function until(check:()=>boolean){for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('timed out');}
function uiFixture(answer='Answer'){
 const dir=mkdtempSync(join(tmpdir(),'aside-button-')),store=new Store(join(dir,'state.sqlite'));
 store.bindThread({threadId:'original',guildId:'guild',parentChannelId:'parent',ownerUserId:'owner'},'original-origin');
 const definitions={fast:{provider:'openai-codex',modelId:'gpt-6-luna',thinkingLevel:'max',fastMode:true},standard:{provider:'openai-codex',modelId:'gpt-5.6-sol',thinkingLevel:'medium',fastMode:false},deep:{provider:'openai-codex',modelId:'gpt-6-sol',thinkingLevel:'xhigh',fastMode:false}};
 const state:Record<string,unknown>={modelCategories:definitions,defaultModel:{provider:'openai-codex',modelId:'gpt-6-astra'}};
 const settings=new AsideSettings('/fake/aside',async args=>{
  const outputs:string[]=[];runInNewContext(args.at(-1)!,{aside:{settings:{get:(key:string)=>structuredClone(state[key]),set:(key:string,value:unknown)=>{state[key]=structuredClone(value);}}},console:{log:(text:string)=>outputs.push(text)}});return outputs.join('\n');
 });
 const messages=new Map<string,any>(),channels=new Map<string,any>(),sent:Array<{threadId:string;content:string;answerRequestId?:number}>=[];
 const creates:ModelSelection[]=[],runs:Array<{id:string;prompt:string;selection:ModelSelection}>=[];
 const threadNames:string[]=[];
 let serial=0,threadSerial=0;
 const channel=(id:string)=>({id,parentId:'parent',guildId:'guild',isThread:()=>true,messages:{fetch:async(options:{message:string})=>{const msg=messages.get(options.message);if(!msg||msg.channelId!==id)throw new Error('missing');return msg;}}});
 channels.set('original',channel('original'));
 const parent={id:'parent',guildId:'guild',type:0,isThread:()=>false,threads:{create:async(options:{name:string})=>{
  threadNames.push(options.name);
  const id=`comparison-${++threadSerial}`,thread={...channel(id),delete:async()=>{channels.delete(id);}};channels.set(id,thread);return thread;
 }}};channels.set('parent',parent);
 const events=new EventEmitter(),client=Object.assign(events,{user:{id:'bot'},channels:{fetch:async(id:string)=>channels.get(id)}}) as unknown as Client;
 const outbound={send:async(threadId:string,content:string,_nonce:string,answerRequestId?:number)=>{
  const id=String(111111111111111111n+BigInt(++serial));messages.set(id,{id,author:{id:'bot',bot:true},guildId:'guild',channelId:threadId,webhookId:null,content,attachments:new Collection()});sent.push({threadId,content,answerRequestId});return id;
 }};
 const backend={health:async()=>{},createSession:async(selection:ModelSelection=LEGACY_SELECTION)=>{creates.push(structuredClone(selection));return `sid-${creates.length}`;},runTurn:async(id:string,prompt:string,_signal:AbortSignal,selection:ModelSelection=LEGACY_SELECTION)=>{runs.push({id,prompt,selection:structuredClone(selection)});return {text:answer,model:`${selection.provider}/${selection.modelId}`};},stop:async()=>({confirmed:true})};
 const engine=new Engine(config,store,backend,outbound,undefined,settings);attachDiscordBot(client,engine);
 const userMessage=(id:string,content:string)=>{const message={id,author:{id:'owner',bot:false},guildId:'guild',channelId:'original',webhookId:null,content,attachments:new Collection()};messages.set(id,message);return message;};
 const complete=async(sourceId='source',question='Original question')=>{
  userMessage(sourceId,question);engine.submit({sourceId,userId:'owner',guildId:'guild',channelId:'original',content:question});await until(()=>!!store.latestAnswer('original'));return store.latestAnswer('original')!;
 };
 function interaction(id:string,customId:string,selected=false,overrides:Record<string,unknown>={}){
  const replies:any[]=[];
  const targetId=selected?'picker':store.latestAnswer('original')!.messageId;
  const fake:any={id,customId,user:{id:'owner'},guildId:'guild',channelId:'original',channel:channels.get('original'),client,
   message:selected?{id:targetId,author:{id:'bot'},guildId:'guild',channelId:'original',webhookId:null}:messages.get(targetId),
   isChatInputCommand:()=>false,isButton:()=>!selected,isStringSelectMenu:()=>selected,values:['standard'],
   deferReply:async()=>{fake.deferred=true;},reply:async(payload:unknown)=>{replies.push(payload);fake.replied=true;},editReply:async(payload:unknown)=>{replies.push(payload);},...overrides};
  return {fake,replies,emit:()=>events.emit('interactionCreate',fake)};
 }
 function command(id:string,sub:string,values:Record<string,string>={},threadId='parent',group?:string){
  const replies:any[]=[],fake:any={id,commandName:'aside',user:{id:'owner'},guildId:'guild',channelId:threadId,channel:channels.get(threadId),client,
   options:{getSubcommand:()=>sub,getSubcommandGroup:()=>group,getString:(key:string)=>values[key]??null},isChatInputCommand:()=>true,
   deferReply:async()=>{fake.deferred=true;},reply:async(payload:unknown)=>{replies.push(payload);fake.replied=true;},editReply:async(payload:unknown)=>{replies.push(payload);}};
  return {fake,replies,emit:()=>events.emit('interactionCreate',fake)};
 }
 return {dir,store,settings,definitions,state,messages,channels,sent,creates,runs,threadNames,engine,events,client,complete,interaction,command,
 cleanup:()=>{engine.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('new and ask apply the AI title only while the original title remains',async()=>{
 const t=uiFixture(),renames:Array<{threadId:string;title:string;expectedTitle?:string}>=[];
 const run=t.engine.backend.runTurn.bind(t.engine.backend);
 t.engine.backend.runTurn=async(...args)=>({...await run(...args),threadTitle:'향수 추천'});
 Reflect.set(t.engine.outbound,'setThreadTitle',async(threadId:string,title:string,expectedTitle?:string)=>{renames.push({threadId,title,expectedTitle});});
 try{
  for(const sub of ['new','ask']){
   const event=t.command('title-'+sub,sub,{question:'향수\n추천\u0000 '+ '😀'.repeat(45)});event.emit();await until(()=>event.replies.length>0);
   assert.equal(t.threadNames.at(-1),'향수 추천 '+ '😀'.repeat(34));
   const threadId=t.store.sessionByOrigin('title-'+sub)!.threadId;
   await until(()=>!!t.store.latestAnswer(threadId)&&renames.some(row=>row.threadId===threadId));
   assert.deepEqual(renames.filter(row=>row.threadId===threadId),[{threadId,title:'향수 추천',expectedTitle:'향수 추천 '+ '😀'.repeat(34)}]);
  }
 }finally{await until(()=>!Reflect.get(t.engine,'pumping'));t.cleanup();}
});

test('rename changes a managed title without creating a turn and rejects invalid destinations',async()=>{
 const t=uiFixture(),thread=t.channels.get('original'),binding=t.store.session('original');
 thread.name='Original question';thread.setName=async(name:string)=>{thread.name=name;};
 Reflect.set(t.engine.outbound,'setThreadTitle',createDiscordOutbound(t.client,config,t.store).setThreadTitle);
 try{
  const command=asideCommand.toJSON(),rename=command.options?.find(option=>option.name==='rename');
  assert.ok(rename&&'options' in rename);assert.ok(rename.options?.some(option=>option.name==='title'&&option.required));
  const good=t.command('rename-good','rename',{title:'향수\n추천\u0000'},'original');good.emit();
  await until(()=>good.replies.length>0);assert.equal(thread.name,'향수 추천');assert.match(good.replies[0].content,/<#original>/);
  assert.deepEqual(t.store.session('original'),binding);assert.equal(t.store.counts().queued,0);assert.equal(t.runs.length,0);
  for(const [id,channel,title,user] of [['empty','original','\u0000\n','owner'],['parent','parent','Forbidden','owner'],['owner','original','Forbidden','other']]){
   const event=t.command('rename-'+id,'rename',{title:title!},channel!);event.fake.user.id=user;event.emit();
   await until(()=>event.replies.length>0);assert.equal(thread.name,'향수 추천');assert.doesNotMatch(event.replies[0].content,/변경했습니다/);
  }
  thread.parentId='foreign';
  const stale=t.command('rename-stale','rename',{title:'Forbidden'},'original');stale.fake.channel={...thread,parentId:'parent'};stale.emit();
  await until(()=>stale.replies.length>0);assert.equal(thread.name,'향수 추천');assert.doesNotMatch(stale.replies[0].content,/변경했습니다/);
 }finally{t.cleanup();}
});

test('recent lists scoped threads by last question, includes archives, and skips unavailable threads',async()=>{
 const t=uiFixture(),fetched:string[]=[],fetch=t.client.channels.fetch.bind(t.client.channels);
 t.client.channels.fetch=(async(id:string,...args:unknown[])=>{fetched.push(id);return Reflect.apply(fetch,t.client.channels,[id,...args]);}) as typeof t.client.channels.fetch;
 const run=async(id:string)=>{const event=t.command(id,'recent');event.emit();await until(()=>event.replies.length>0);return event.replies[0].content as string;};
 try{
  assert.ok(asideCommand.toJSON().options?.some(option=>option.name==='recent'));
  t.store.db.exec('DELETE FROM sessions');assert.match(await run('recent-empty'),/아직|없습니다/);
  for(let i=1;i<=13;i++){
   const id='thread-'+i;t.store.bindThread({threadId:id,guildId:'guild',parentChannelId:'parent',ownerUserId:'owner'},'origin-'+i);
   t.store.db.prepare('UPDATE sessions SET created_at=? WHERE thread_id=?').run(i*1000,id);
   t.channels.set(id,{id,guildId:'guild',parentId:'parent',isThread:()=>true,archived:i===1});
  }
  t.store.enqueue('follow-up','thread-1','Revived');t.store.db.prepare('UPDATE requests SET created_at=100000').run();
  t.store.bindThread({threadId:'out-of-scope',guildId:'foreign',parentChannelId:'parent',ownerUserId:'owner'},'foreign-origin');
  t.store.bindThread({threadId:'missing',guildId:'guild',parentChannelId:'parent',ownerUserId:'owner'},'missing-origin');
  t.store.bindThread({threadId:'moved',guildId:'guild',parentChannelId:'parent',ownerUserId:'owner'},'moved-origin');
  t.channels.set('moved',{id:'moved',guildId:'guild',parentId:'foreign',isThread:()=>true});
  t.store.db.prepare("UPDATE sessions SET created_at=200000 WHERE thread_id IN ('missing','moved')").run();
  const content=await run('recent-list'),ids=[...content.matchAll(/<#([^>]+)>/g)].map(match=>match[1]);
  assert.deepEqual(ids,['thread-1','thread-13','thread-12','thread-11','thread-10','thread-9','thread-8','thread-7']);
  assert.match(content,/<t:100:R>/);assert.match(content,/보관됨/);assert.ok(content.length<=2000);
  assert.ok(!fetched.includes('out-of-scope'));assert.equal(t.runs.length,0);
  const denied=t.command('recent-denied','recent');denied.fake.user.id='other';denied.emit();
  await until(()=>denied.replies.length>0);assert.doesNotMatch(denied.replies[0].content,/<#thread-/);
 }finally{t.cleanup();}
});

test('manual title wins over overlapping automatic updates in either order',async()=>{
 const t=uiFixture(),thread=t.channels.get('original'),rename=Reflect.get(createDiscordOutbound(t.client,config,t.store),'setThreadTitle') as (id:string,title:string,expected?:string)=>Promise<void>;
 thread.setName=async(name:string)=>{await new Promise(resolve=>setTimeout(resolve,2));thread.name=name;};
 try{
  thread.name='Original question';
  await Promise.all([rename('original','Manual'),rename('original','AI title','Original question')]);assert.equal(thread.name,'Manual');
  thread.name='Original question';
  await Promise.all([rename('original','AI title','Original question'),rename('original','Manual')]);assert.equal(thread.name,'Manual');
 }finally{t.cleanup();}
});

test('Discord title updates require a managed destination and sanitize the title',async()=>{
 const t=uiFixture(),names:string[]=[];
 try{
  const thread=t.channels.get('original');thread.setName=async(name:string)=>{names.push(name);};
  const sink=createDiscordOutbound(t.client,config,t.store),rename=Reflect.get(sink,'setThreadTitle');
  assert.equal(typeof rename,'function');
  assert.ok(rename);
  await rename('original','향수\n추천\u0000');assert.deepEqual(names,['향수 추천']);
  await rename('original','\u0000\n');assert.equal(names.length,1);
  await assert.rejects(rename('unmanaged','Title'));
  thread.parentId='foreign';await assert.rejects(rename('original','Title'));assert.equal(names.length,1);
 }finally{t.cleanup();}
});

test('legacy database adoption preserves queued Luna/medium and backend binding',()=>{
 const dir=mkdtempSync(join(tmpdir(),'aside-legacy-')),file=join(dir,'state.sqlite'),db=new DatabaseSync(file);
 db.exec(`CREATE TABLE sessions(thread_id TEXT PRIMARY KEY,guild_id TEXT,parent_channel_id TEXT,owner_user_id TEXT,origin_id TEXT UNIQUE,backend_id TEXT UNIQUE,blocked INTEGER DEFAULT 0,created_at INTEGER);
 CREATE TABLE requests(id INTEGER PRIMARY KEY,source_id TEXT UNIQUE,thread_id TEXT,prompt TEXT,state TEXT,error_code TEXT,created_at INTEGER,updated_at INTEGER);
 CREATE TABLE outbox(id INTEGER PRIMARY KEY,request_id INTEGER,thread_id TEXT,part INTEGER,content TEXT,nonce TEXT UNIQUE,state TEXT,attempted_at INTEGER,discord_message_id TEXT,UNIQUE(request_id,part));
 INSERT INTO sessions VALUES('old','guild','parent','owner','old-origin','old-backend',0,1);
 INSERT INTO requests VALUES(1,'old-source','old','Old queued question','queued',NULL,1,1);`);db.close();
 const store=new Store(file);
 try{
  assert.equal(store.session('old')?.backendId,'old-backend');assert.equal(store.session('old')?.presetName,null);
  assert.deepEqual(store.nextQueued()?.selection,LEGACY_SELECTION);assert.equal(store.nextQueued()?.prompt,'Old queued question');
  assert.equal(store.defaultPreset(),'fast');store.setDefaultPreset('deep');
  assert.deepEqual(store.nextQueued()?.selection,LEGACY_SELECTION);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('preset commands apply defaults and explicit choices only to new conversations',async()=>{
 const t=uiFixture();
 try{
  const run=async(id:string,sub:string,values:Record<string,string>={},threadId='parent',group?:string)=>{const event=t.command(id,sub,values,threadId,group);event.emit();await until(()=>event.replies.length>0);return event.replies[0].content as string;};
  await run('first-new','new',{question:'First'});await until(()=>!!t.store.latestAnswer(t.store.sessionByOrigin('first-new')!.threadId));
  assert.deepEqual(t.store.sessionByOrigin('first-new')!.selection,await t.settings.readPreset('fast'));
  await run('use-deep','use',{name:'deep'},'parent','preset');assert.equal(t.store.defaultPreset(),'deep');
  await run('explicit-new','ask',{question:'Explicit',preset:'standard'});await until(()=>!!t.store.latestAnswer(t.store.sessionByOrigin('explicit-new')!.threadId));
  assert.equal(t.store.sessionByOrigin('explicit-new')?.selection.modelId,'gpt-5.6-sol');assert.equal(t.store.defaultPreset(),'deep');
  await run('default-new','new',{question:'Default'});await until(()=>!!t.store.latestAnswer(t.store.sessionByOrigin('default-new')!.threadId));
  const binding=t.store.sessionByOrigin('default-new')!,fixed=binding.selection;
  assert.equal(fixed.modelId,'gpt-6-sol');
  assert.match(await run('thread-use','use',{name:'fast'},binding.threadId,'preset'),/지정 채널/);assert.equal(t.store.defaultPreset(),'deep');
  assert.match(await run('thread-edit','edit',{name:'deep',model:'gpt-6-luna',effort:'low'},binding.threadId,'preset'),/기존·대기 중/);
  assert.deepEqual(t.store.session(binding.threadId)?.selection,fixed);
  const view=await run('settings','settings',{},binding.threadId);assert.match(view,/고정 설정: 깊은 분석 \(gpt-6-sol/);assert.match(view,/확인된 모델: openai-codex\/gpt-6-sol/);assert.match(view,/추론은 지정값/);
 }finally{t.cleanup();}
});

test('unexpected answer models become uncertain without an answer or buttons',async()=>{
 const t=uiFixture();
 try{
  t.engine.backend.runTurn=async()=>({text:'Wrong model answer',model:'openai-codex/gpt-6-sol'});
  t.engine.submit({sourceId:'mismatch',userId:'owner',guildId:'guild',channelId:'original',content:'Question'});
  await until(()=>t.store.requestBySource('mismatch')?.state==='uncertain');
  assert.equal(t.store.session('original')?.blocked,1);assert.equal(t.store.latestAnswer('original'),undefined);assert.equal(t.sent.length,0);
 }finally{t.cleanup();}
});

test('settings also displays edited definitions that are not the default preset',async()=>{
 const t=uiFixture();
 try{
  await t.settings.editPreset('standard','gpt-6-sol','low');
  const event=t.command('shared-settings','settings');event.emit();await until(()=>event.replies.length>0);
  assert.equal(t.store.defaultPreset(),'fast');assert.match(event.replies[0].content,/일반: gpt-6-sol · 추론 지정값 low/);assert.match(event.replies[0].content,/깊은 분석: gpt-6-sol/);
 }finally{t.cleanup();}
});

test('edited definitions affect new threads while queued and follow-up turns keep their snapshot',async()=>{
 const t=uiFixture();
 try{
  const first=await t.settings.readPreset('standard');
  t.store.bindThread({threadId:'a',guildId:'guild',parentChannelId:'parent',ownerUserId:'owner'},'a-origin',{presetName:'standard',selection:first});
  t.store.enqueue('a-first','a','A');
  await t.settings.editPreset('standard','gpt-6-sol','high');
  const second=await t.settings.readPreset('standard');
  t.store.bindThread({threadId:'b',guildId:'guild',parentChannelId:'parent',ownerUserId:'owner'},'b-origin',{presetName:'standard',selection:second});
  t.store.enqueue('b-first','b','B');t.engine.start();await until(()=>t.store.requestBySource('b-first')?.state==='completed');
  t.engine.submit({sourceId:'a-follow',userId:'owner',guildId:'guild',channelId:'a',content:'Follow'});await until(()=>t.store.requestBySource('a-follow')?.state==='completed');
  assert.deepEqual(t.creates,[first,second]);assert.deepEqual(t.runs.map(run=>run.selection),[first,second,first]);assert.deepEqual(t.runs.map(run=>run.id),['sid-1','sid-2','sid-1']);
  assert.throws(()=>t.store.db.prepare('UPDATE sessions SET model_selection=? WHERE thread_id=?').run(JSON.stringify(second),'a'));
 }finally{t.cleanup();}
});

test('answer button metadata appears only on the last split part and never on questions or failures',async()=>{
 const t=uiFixture('🌲'.repeat(2200));
 try{
  t.engine.submit({sourceId:'initial',userId:'owner',guildId:'guild',channelId:'original',content:'Question'},{publishQuestion:true,inputKind:'initial'});
  await until(()=>!!t.store.latestAnswer('original'));
  assert.ok(t.sent.length>=4);assert.equal(t.sent.filter(row=>row.answerRequestId!==undefined).length,1);
  assert.ok(t.sent.at(-1)?.answerRequestId);assert.equal(t.sent[0]?.answerRequestId,undefined);
  const req=t.store.requestBySource('initial')!;assert.equal(req.prompt,null);assert.equal(req.actualModel,'openai-codex/gpt-6-luna');
 }finally{t.cleanup();}
});

test('summary buttons validate targets, latestness, pending work and duplicate events',async()=>{
 const t=uiFixture();
 try{
  const first=await t.complete();
  for(const overrides of [{user:{id:'intruder'}},{guildId:'other'},{channelId:'other'},{message:{...t.messages.get(first.messageId),id:'forged'}},{message:{...t.messages.get(first.messageId),author:{id:'other'}}},{message:{...t.messages.get(first.messageId),webhookId:'bot',applicationId:'bot'}}]){
   const event=t.interaction('forged-'+JSON.stringify(overrides),`aside:summary:${first.request.id}`,false,overrides);event.emit();await until(()=>event.replies.length>0);assert.equal(t.runs.length,1);
  }
  const event=t.interaction('summary-event',`aside:summary:${first.request.id}`);event.emit();event.emit();await until(()=>t.store.requestBySource('summary-event')?.state==='completed');
  assert.equal(t.runs.length,2);assert.equal(t.runs[1]?.id,t.runs[0]?.id);assert.deepEqual(t.runs[1]?.selection,LEGACY_SELECTION);
  const stale=t.interaction('stale-event',`aside:detail:${first.request.id}`,false,{message:t.messages.get(first.messageId)});stale.emit();await until(()=>stale.replies.length>0);assert.equal(t.runs.length,2);assert.match(stale.replies[0].content,/최신/);
  const latest=t.store.latestAnswer('original')!;t.store.enqueue('waiting','original','Queued');
  const busy=t.interaction('busy-event',`aside:detail:${latest.request.id}`);busy.emit();await until(()=>busy.replies.length>0);assert.equal(t.runs.length,2);assert.match(busy.replies[0].content,/대기/);
 }finally{t.cleanup();}
});

test('comparison picker uses different models, creates an independent linked session and dedupes selection',async()=>{
 const t=uiFixture();
 try{
  const target=await t.complete();const originalId=t.store.session('original')?.backendId;
  const button=t.interaction('compare-button',`aside:compare:${target.request.id}`);button.emit();await until(()=>button.replies.length>0);
  const menu=button.replies[0].components[0].toJSON().components[0];assert.deepEqual(menu.options.map((option:{value:string})=>option.value),['standard','deep']);
  const select=t.interaction('compare-selection',menu.custom_id,true,{message:{id:'picker',author:{id:'bot'},guildId:'guild',channelId:'original',webhookId:'bot',applicationId:'bot'}});select.emit();select.emit();
  await until(()=>select.replies.length>0);assert.match(select.replies[0].content,/질문을 등록/);
  await until(()=>t.store.requestBySource('compare-selection')?.state==='completed');
  const binding=t.store.sessionByOrigin('compare-selection')!;assert.notEqual(binding.backendId,originalId);assert.equal(binding.comparisonRequestId,target.request.id);
  assert.equal(binding.selection.modelId,'gpt-5.6-sol');assert.equal(t.store.session('original')?.backendId,originalId);assert.equal(t.creates.length,2);
  assert.match(t.runs[1]!.prompt,/Original question/);assert.match(t.runs[1]!.prompt,/Answer/);assert.ok(!t.runs[1]!.prompt.includes('entire history'));
  assert.ok(t.sent.some(row=>row.threadId==='original'&&row.content.includes(binding.threadId)));
  assert.ok(t.sent.some(row=>row.threadId===binding.threadId&&row.content.includes(target.messageId)));
 }finally{t.cleanup();}
});

test('comparison refuses a changed same-model preset, missing original or oversized input',async()=>{
 for(const failure of ['same-model','missing','missing-answer','foreign-picker','oversized'] as const){
  const t=uiFixture(failure==='oversized'?'A'.repeat(8000):'Answer');
  try{
   const target=await t.complete();
   if(failure==='same-model')await t.settings.editPreset('standard','gpt-6-luna','medium');
   if(failure==='missing')t.messages.delete('source');
   if(failure==='missing-answer')t.messages.delete(target.messageId);
   const overrides=failure==='foreign-picker'?{message:{id:'picker',author:{id:'bot'},guildId:'guild',channelId:'original',webhookId:'other',applicationId:'bot'}}:{};
   const select=t.interaction('rejected-select',`aside:select:${target.request.id}:${target.messageId}`,true,overrides);select.emit();await until(()=>select.replies.length>0);
   assert.equal(t.creates.length,1);assert.equal(t.store.sessionByOrigin('rejected-select'),undefined);assert.equal(t.store.requestBySource('rejected-select'),undefined);
   assert.match(select.replies[0].content,failure==='same-model'?/같은 모델/:failure==='oversized'?/8000/:failure==='foreign-picker'?/완료하지 못했습니다/:failure==='missing-answer'?/메시지를 확인/:/원래 질문/);
  }finally{t.cleanup();}
 }
});

test('outbound renders three buttons for a verified final answer and no buttons for notices',async()=>{
 const t=uiFixture();
 try{
  const target=await t.complete(),payloads:any[]=[];
  const parent=t.channels.get('parent');parent.guild={roles:{fetch:async()=>new Collection()}};parent.permissionOverwrites={cache:new Collection([['guild',{id:'guild',type:0,allow:{bitfield:0n},deny:{bitfield:1024n}}]])};
  t.channels.get('original').send=async(payload:unknown)=>{payloads.push(payload);return {id:'actual-message'};};
  const sink=createDiscordOutbound(t.client,config,t.store);
  await sink.send('original','Answer','nonce-answer',target.request.id);await sink.send('original','Notice','nonce-notice');
  assert.deepEqual(payloads[0].components[0].toJSON().components.map((button:{label:string})=>button.label),['짧게 요약','더 자세히','다른 모델로 비교']);
  assert.deepEqual(payloads[1].components,[]);assert.equal(payloads[0].enforceNonce,true);
 }finally{t.cleanup();}
});
