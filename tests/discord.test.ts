import assert from 'node:assert/strict';
import {test} from 'node:test';
import {asideCommand} from '../src/discord/bot.js';
import {attachDiscordBot,createDiscordOutbound} from '../src/discord/bot.js';
import {EventEmitter} from 'node:events';
import {Collection,type Client} from 'discord.js';
import {Engine} from '../src/core/engine.js';
import {Store} from '../src/store.js';
test('server shutdown requires owner, configured channel and explicit confirmation before replying then stopping',async t=>{
 const command=asideCommand.toJSON().options?.find(option=>option.name==='shutdown');
 await t.test('registered confirmation option',()=>{
  assert.ok(command&&'options' in command);
  const confirm=command.options?.find(option=>option.name==='confirm');
  assert.equal(confirm?.type,5);assert.equal(confirm?.required,true);
 });
 for(const scenario of ['owner','managed','other_user','other_guild','other_channel','wrong_parent','unmanaged','no_confirmation','reply_failure','no_handler'])await t.test(scenario,async()=>{
  const config={ownerUserId:'owner',guildId:'guild',channelId:'parent'},store=new Store(':memory:');
  store.bindThread({threadId:'thread',...config,parentChannelId:'parent'},'origin');
  store.enqueue('pending','thread','Keep this question');
  const engine=new Engine(config,store,{health:async()=>{},createSession:async()=> 'session',runTurn:async()=>({text:'Answer'}),stop:async()=>({confirmed:true})},{send:async()=> 'message'});
  const events=new EventEmitter(),order:string[]=[],replies:any[]=[];
  const shutdown=async()=>{order.push('shutdown');};
  Reflect.apply(attachDiscordBot,undefined,[events as Client,engine,scenario==='no_handler'?undefined:shutdown]);
  const inThread=['managed','wrong_parent','unmanaged'].includes(scenario);
  const channelId=inThread?scenario==='unmanaged'?'unknown':'thread':scenario==='other_channel'?'other':'parent';
  const guildId=scenario==='other_guild'?'other':'guild';
  const channel={id:channelId,guildId,type:inThread?11:0,isThread:()=>inThread,parentId:scenario==='wrong_parent'?'other':inThread?'parent':null};
  const fake:any={id:'shutdown-'+scenario,commandName:'aside',user:{id:scenario==='other_user'?'other':'owner'},guildId,channelId,channel,
   options:{getSubcommand:()=> 'shutdown',getBoolean:()=>scenario==='no_confirmation'?false:true},isChatInputCommand:()=>true,
   reply:async(payload:unknown)=>{if(scenario==='reply_failure')throw new Error('unavailable');replies.push(payload);order.push('reply');fake.replied=true;},
   editReply:async(payload:unknown)=>{replies.push(payload);}};
  try{
   events.emit('interactionCreate',fake);
   await new Promise(resolve=>setImmediate(resolve));
   assert.deepEqual(order,scenario==='owner'||scenario==='managed'?['reply','shutdown']:scenario==='reply_failure'?[]:['reply']);
   assert.equal(store.requestBySource('pending')?.state,'queued');
   if(replies.length){assert.equal(replies[0].flags,64);assert.deepEqual(replies[0].allowedMentions,{parse:[]});}
  }finally{engine.close();store.close();}
 });
});
test('new and ask both accept a required first question',()=>{
 const command=asideCommand.toJSON();
 for(const name of ['new','ask']) {
 const sub=command.options?.find(x=>x.name===name);
 assert.ok(sub&&'options' in sub);
 const question=sub.options?.find(x=>x.name==='question');
 assert.ok(question&&'max_length' in question);assert.equal(question.required,true);assert.equal(question.max_length,6000);
 }
});

test('attachment resolver refreshes source and rejects a different author before exposing URLs',async()=>{
 const {resolveDiscordAttachments}=await import('../src/discord/bot.js');
 const {Collection}=await import('discord.js');
 const attachments=new Collection([['22',{id:'22',name:'note.txt',size:3,contentType:'text/plain',url:'https://cdn.discordapp.com/fresh'}]]);
 let author='owner';let forced=false;
 const channel={isThread:()=>true,parentId:'parent',guildId:'guild',messages:{fetch:async(options:{force:boolean})=>{forced=options.force;return {author:{id:author,bot:false},guildId:'guild',channelId:'33',attachments};}}};
 const client={channels:{fetch:async()=>channel}} as unknown as import('discord.js').Client;
 const resolver=resolveDiscordAttachments(client,{ownerUserId:'owner',guildId:'guild',channelId:'parent'});
 assert.deepEqual(await resolver('33','11',new AbortController().signal),[...attachments.values()]);assert.equal(forced,true);
 author='other';await assert.rejects(resolver('33','11',new AbortController().signal));
 channel.parentId='other';await assert.rejects(resolver('33','11',new AbortController().signal));
});

test('settings and presets target new conversations and expose three preset choices',()=>{
 const command=asideCommand.toJSON();
 assert.ok(command.options?.some(option=>option.name==='settings'));
 const preset=command.options?.find(option=>option.name==='preset');assert.ok(preset&&'options' in preset);
 assert.deepEqual(preset.options?.map(option=>option.name),['use','edit']);
 for(const name of ['new','ask']){
  const sub=command.options?.find(option=>option.name===name);assert.ok(sub&&'options' in sub);
  const option=sub.options?.find(option=>option.name==='preset');assert.ok(option&&'choices' in option);
  assert.deepEqual(option.choices?.map(choice=>choice.value),['fast','standard','deep']);
 }
 const edit=preset.options?.find(option=>option.name==='edit');assert.ok(edit&&'options' in edit);
 const effort=edit.options?.find(option=>option.name==='effort');assert.ok(effort&&'choices' in effort);
 assert.deepEqual(effort.choices?.map(choice=>choice.value),['off','minimal','low','medium','high','xhigh','max']);
});

test('comparison input rejects missing originals and the final 8000 character overflow',async()=>{
 const module=await import('../src/discord/bot.js');
 const build=Reflect.get(module,'buildComparisonPrompt');assert.equal(typeof build,'function');
 assert.match(build('Original question','Selected answer'),/Original question/);
 assert.match(build('Original question','Selected answer'),/Selected answer/);
 assert.throws(()=>build('','Answer'));
 const overhead=build('Q','A').length-2;
 assert.equal(build('Q','A'.repeat(7999-overhead)).length,8000);
 assert.throws(()=>build('Q','A'.repeat(8000-overhead)));
});

test('elapsed progress replaces prior notices and final cleanup never retries a delivered answer',async t=>{
 for(const scenario of ['split','delivery_failure','delete_failure','progress','progress_delayed_tick','progress_delivery_failure','progress_replacement_delivery_failure','progress_in_flight','progress_delete_failure'])await t.test(scenario,async c=>{
  const config={ownerUserId:'owner',guildId:'guild',channelId:'parent'},store=new Store(':memory:');
  store.bindThread({threadId:'thread',...config,parentChannelId:config.channelId},'origin');
  const live=new Map<string,string>([['unrelated','Keep this message']]),payloads:any[]=[],deleted:string[]=[];
  const hasProgress=scenario.startsWith('progress');
  if(hasProgress)c.mock.timers.enable({apis:['setInterval']});
  let now=0;c.mock.method(Date,'now',()=>now);
  let lastAttempts=0,progressAttempts=0,running=false,failDelivery=scenario==='delivery_failure',release!:()=>void,finishTurn!:()=>void,releaseProgress!:()=>void;
  const finalGate=new Promise<void>(resolve=>{release=resolve;});
  const turnGate=new Promise<void>(resolve=>{finishTurn=resolve;}),progressGate=new Promise<void>(resolve=>{releaseProgress=resolve;});
  const send=async(payload:any)=>{
   if(payload.content.startsWith('답변 중...')){
    progressAttempts++;
    if(scenario==='progress_delivery_failure'&&progressAttempts===1)throw new Error('progress unavailable');
    if(scenario==='progress_replacement_delivery_failure'&&progressAttempts===2)throw new Error('replacement unavailable');
    if(scenario==='progress_in_flight')await progressGate;
   }
   if(/^A+$/.test(payload.content)&&payload.content.length<1900){
    lastAttempts++;
    if(failDelivery)throw new Error('transport unavailable');
    await finalGate;
   }
   payloads.push(payload);const id=`message-${payloads.length}`;live.set(id,payload.content);return {id};
  };
  const thread={id:'thread',guildId:'guild',parentId:'parent',isThread:()=>true,send,messages:{delete:async(id:string)=>{
   deleted.push(id);if(scenario==='delete_failure'&&id==='message-1'||scenario==='progress_delete_failure'&&id==='message-2')throw new Error('deletion unavailable');live.delete(id);
  }}};
  const parent={type:0,guildId:'guild',guild:{roles:{fetch:async()=>new Collection()}},permissionOverwrites:{cache:new Collection([['guild',{id:'guild',type:0,allow:{bitfield:0n},deny:{bitfield:1024n}}]])}};
  const events=new EventEmitter(),client=Object.assign(events,{user:{id:'bot'},channels:{fetch:async(id:string)=>id==='thread'?thread:parent}}) as unknown as Client;
  const backend={health:async()=>{now=120_000;},createSession:async()=> 'session',runTurn:async()=>{running=true;if(hasProgress)await turnGate;return {text:'A'.repeat(2000),...(scenario==='split'?{}:{model:'openai-codex/gpt-6-luna'})};},stop:async()=>({confirmed:true})};
  const engine=new Engine(config,store,backend,createDiscordOutbound(client,config,store));attachDiscordBot(client,engine);
  const until=async(check:()=>boolean)=>{for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('timed out');};
  try{
   events.emit('messageCreate',{id:'source',author:{id:'owner',bot:false},guildId:'guild',channelId:'thread',channel:thread,webhookId:null,content:'Question',attachments:new Collection(),reply:send});
   if(hasProgress){
    await until(()=>running&&payloads.length===1);
    for(let i=1;i<=(scenario==='progress_in_flight'?1:2);i++){
     now=120_000+(scenario==='progress_delayed_tick'&&i===2?70_000:i*10_000);c.mock.timers.tick(10_000);await until(()=>progressAttempts===i);
     if(scenario!=='progress_in_flight')await until(()=>!Reflect.get(engine,'delivering'));
    }
    const progress=[...live.values()].filter(content=>content.startsWith('답변 중...'));
    if(scenario==='progress_in_flight')assert.deepEqual(progress,[]);
    else if(scenario==='progress_delete_failure')assert.deepEqual(progress,['답변 중... (00분 10초)','답변 중... (00분 20초)']);
    else assert.deepEqual(progress,[scenario==='progress_replacement_delivery_failure'?'답변 중... (00분 10초)':scenario==='progress_delayed_tick'?'답변 중... (01분 10초)':'답변 중... (00분 20초)']);
    now+=3550;
    finishTurn();
    if(scenario==='progress_in_flight'){
     await new Promise(resolve=>setTimeout(resolve,0));assert.equal(lastAttempts,0);releaseProgress();
    }
   }
   await until(()=>lastAttempts===1);
   const request=store.requestBySource('source')!,notice=payloads.find(payload=>payload.content.startsWith('요청을 대기열'));
   assert.ok(notice);assert.ok(!deleted.includes('message-1'));assert.equal(live.get('message-1'),notice.content);
   assert.equal(store.outputParts(request.id,'answer').at(-1)?.state,'sending');
   if(failDelivery){
    await until(()=>!Reflect.get(engine,'delivering'));failDelivery=false;release();await engine.flushOutbox();
   }else release();
   await until(()=>store.outputParts(request.id,'answer').every(row=>row.state==='sent'));
   const noticeIds=hasProgress?['progress_in_flight','progress_delivery_failure','progress_replacement_delivery_failure'].includes(scenario)?['message-1','message-2']:['message-1','message-2','message-3']:['message-1'];
   assert.deepEqual([...new Set(deleted)].sort(),noticeIds);assert.equal(live.has('message-1'),scenario==='delete_failure');
   assert.ok(noticeIds.slice(1).every(id=>live.has(id)===(scenario==='progress_delete_failure'&&id==='message-2')));
   assert.equal(engine.status().deliveryUncertain,0);
   assert.equal(live.get('unrelated'),'Keep this message');
   const elapsed=hasProgress?scenario==='progress_in_flight'?'00분 13초':scenario==='progress_delayed_tick'?'01분 13초':'00분 23초':'00분 00초';
   assert.equal(payloads.filter(payload=>payload.content.startsWith('(')||payload.content.startsWith('A')).map(payload=>payload.content).join(''),`(${elapsed} 경과)\n\n`+'A'.repeat(2000));
   assert.ok(payloads.every(payload=>!payload.content.includes('아직 처리 중입니다')));
   assert.deepEqual(notice.reply,{messageReference:'source',failIfNotExists:false});assert.equal(notice.enforceNonce,true);
   await engine.flushOutbox();assert.equal(lastAttempts,scenario==='delivery_failure'?2:1);
   if(hasProgress){c.mock.timers.tick(10_000);assert.equal(progressAttempts,scenario==='progress_in_flight'?1:2);}
  }finally{release();releaseProgress();finishTurn();engine.close();await until(()=>!Reflect.get(engine,'pumping')&&!Reflect.get(engine,'delivering'));store.close();}
 });
});

test('outbound does not send after shutdown while channel lookup was pending',async()=>{
 let release!:(value:any)=>void,stopping=false,sends=0;
 const store=new Store(':memory:');const c={ownerUserId:'owner',guildId:'guild',channelId:'parent'};
 store.bindThread({threadId:'thread',guildId:'guild',parentChannelId:'parent',ownerUserId:'owner'},'origin');
 const parent={type:0,guildId:'guild',guild:{roles:{fetch:async()=>new Collection()}},permissionOverwrites:{cache:new Collection([['guild',{id:'guild',type:0,allow:{bitfield:0n},deny:{bitfield:1024n}}]])}};
 const client={user:{id:'bot'},channels:{fetch:(id:string)=>id==='thread'?new Promise(resolve=>release=resolve):Promise.resolve(parent)}} as unknown as Client;
 const outbound=createDiscordOutbound(client,c,store,()=>stopping);
 const work=outbound.send('thread','answer','nonce');stopping=true;
 release({isThread:()=>true,guildId:'guild',parentId:'parent',id:'thread',send:async()=>{sends++;return {id:'sent'};}});
 try{await assert.rejects(work);assert.equal(sends,0);}finally{store.close();}
});
