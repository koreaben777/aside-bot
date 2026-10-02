import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reduceConnection} from '../src/runtime-control.js';

test('connection reduction requires preparation and keeps stop terminal',()=>{
 assert.equal(reduceConnection('starting','ready',false),'starting');
 assert.equal(reduceConnection('starting','ready',true),'connected');
 assert.equal(reduceConnection('connected','closed',true),'reconnecting');
 assert.equal(reduceConnection('reconnecting','fatal',true),'error');
 assert.equal(reduceConnection('stopping','ready',true),'stopping');
});

import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {connect,type Socket} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';

async function until(check:()=>Promise<boolean>){for(let i=0;i<200;i++){if(await check())return;await delay(10);}assert.fail('fixture timed out');}
function exchange(s:Socket,value:unknown):Promise<any>{return new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>{s.off('data',read);reject(Error('timeout'));},1000);const read=(b:Buffer)=>{text+=b.toString();if(text.includes('\n')){clearTimeout(timer);s.off('data',read);resolve(JSON.parse(text.split('\n')[0]!));}};s.on('data',read);s.write(JSON.stringify(value)+'\n');});}

test('both real entrypoints stop safely in keychain, health, and SDK startup, and publish reconnects',async()=>{
 for(const platform of ['discord','slack'])for(const scenario of ['keychain','health','ready','events']){
  const dir=await mkdtemp('/tmp/al-');const data=join(dir,'data');const cli=join(dir,'cli');
  await writeFile(join(dir,'scenario'),scenario);
  await writeFile(join(dir,'config.local.json'),JSON.stringify({ownerUserId:'111111111111111111',guildId:'222222222222222222',channelId:'333333333333333333',applicationId:'444444444444444444',cliPath:cli,asideAccount:'u0',asideModel:'openai-codex/gpt-6-luna',dataDir:data}));
  await writeFile(join(dir,'config.slack.local.json'),JSON.stringify({ownerUserId:'U12345678',teamId:'T12345678',applicationId:'A12345678'}));
  await writeFile(cli,`#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';
if(process.argv[2]==='--version'){
 if(readFileSync('scenario','utf8')==='health'){writeFileSync('health-wait','');setInterval(()=>{},1000);process.on('SIGTERM',()=>process.exit(1));}
 else console.log('1.26.916.1741');
}else console.log('No sessions.');`,{mode:0o700});
  const keychain=`import {existsSync,readFileSync,writeFileSync} from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';async function key(){writeFileSync('keychain-wait','');if(readFileSync('scenario','utf8')==='keychain')while(!existsSync('release'))await delay(10);return 'fake';}export const readBotToken=key,readSlackToken=key;`;
  const common=`import {EventEmitter} from 'node:events';import {readFileSync,writeFileSync,existsSync} from 'node:fs';const scenario=readFileSync('scenario','utf8');`;
  const discord=common+`
export const Events={Error:'error',ClientReady:'ready',ShardReady:'shardReady',ShardResume:'shardResume',ShardReconnecting:'reconnecting',ShardDisconnect:'disconnect',ShardError:'shardError'};
export const GatewayIntentBits={};export const ChannelType={GuildText:0};export const PermissionFlagsBits={Administrator:1};
export class Client extends EventEmitter{
 connected=false;user={id:'444444444444444444'};channels={fetch:async()=>({type:0,guildId:'222222222222222222',guild:{ownerId:'111111111111111111',members:{fetchMe:async()=>({})},roles:{fetch:async()=>({filter:()=>({map:()=>[]})})}},permissionsFor:()=>({has:x=>Array.isArray(x)}),permissionOverwrites:{cache:{map:()=>[]}}})};
 login(){writeFileSync('sdk-wait','');return new Promise((resolve,reject)=>{this.finish=resolve;this.fail=reject;if(scenario!=='ready'){this.connected=true;this.emit('ready');resolve();}this.timer=setInterval(()=>{if(scenario==='ready'&&existsSync('release')){this.connected=true;this.emit('ready');this.finish();}if(existsSync('close-sdk')){this.connected=false;this.emit('disconnect',{code:1006});}if(existsSync('recover-sdk')){this.connected=true;this.emit('shardResume');}},10);});}
 isReady(){return this.connected;}
 async destroy(){clearInterval(this.timer);this.connected=false;writeFileSync('sdk-destroyed','');setTimeout(()=>this.emit('ready'),10);}
}`;
  const slack=common+`
export const LogLevel={ERROR:1};export class SocketModeClient extends EventEmitter{
 start(){writeFileSync('sdk-wait','');return new Promise((resolve,reject)=>{this.finish=resolve;this.fail=reject;if(scenario!=='ready'){this.emit('connected');resolve({ok:true});}this.timer=setInterval(()=>{if(scenario==='ready'&&existsSync('release')){this.emit('connected');this.finish({ok:true});}if(existsSync('close-sdk'))this.emit('close');if(existsSync('recover-sdk'))this.emit('connected');},10);});}
 async disconnect(){clearInterval(this.timer);this.emit('disconnected');writeFileSync('sdk-destroyed','');setTimeout(()=>this.emit('connected'),10);}
}`;
  const botModule=platform==='discord'?`export function attachDiscordBot(){}export function createDiscordOutbound(){return {send:async()=> 'msg'}}export function resolveDiscordAttachments(){return async()=>{throw Error()}}`:`export function createSlackApi(){return {}}export async function connectSlack(){return {dmChannelId:'D12345678',botUserId:'U87654321'}}export function createSlackOutbound(){return {send:async()=> 'msg'}}export function allowedSlackParent(){return true}export class SlackBot{async handle(){}}`;
  const preload=`import {registerHooks} from 'node:module';
const url=s=>'data:text/javascript,'+encodeURIComponent(s);
registerHooks({resolve(specifier,context,next){
 if(specifier==='discord.js')return {url:url(${JSON.stringify(discord)}),shortCircuit:true};
 if(specifier==='@slack/socket-mode')return {url:url(${JSON.stringify(slack)}),shortCircuit:true};
 if(specifier.endsWith('keychain.js'))return {url:url(${JSON.stringify(keychain)}),shortCircuit:true};
 if(specifier.endsWith('/bot.js')||specifier==='./bot.js')return {url:url(${JSON.stringify(botModule)}),shortCircuit:true};
 if(specifier.endsWith('/privacy.js'))return {url:url('export function assertPrivateChannel(){}'),shortCircuit:true};
 return next(specifier,context);
}});`;
  await writeFile(join(dir,'preload.mjs'),preload);
  const child=spawn(process.execPath,['--import',pathToFileURL(join(dir,'preload.mjs')).href,resolve(platform==='discord'?'dist/src/main.js':'dist/src/slack/main.js')],{cwd:dir,env:{HOME:process.env.HOME,PATH:'/usr/bin:/bin',ASIDE_MENU_MANAGED:'1'},stdio:['pipe','ignore','pipe']});
  let diagnostic='';child.stderr.on('data',b=>diagnostic+=b.toString());const closed=new Promise<number|null>(resolve=>child.once('close',resolve));
  const token='b'.repeat(64);child.stdin.end(JSON.stringify({v:1,token,sleepEnabled:false})+'\n');
  const socketPath=join(data,platform==='slack'?'slack/control.sock':'control.sock');let owner:Socket|undefined;
  try{
   await until(()=>stat(socketPath).then(()=>true,()=>false));owner=connect(socketPath);owner.on('error',()=>{});
   let snapshot=(await exchange(owner,{v:1,id:'s',op:'status'})).status;
   assert.equal((await exchange(owner,{v:1,id:'c',op:'claim',instanceId:snapshot.instanceId,token})).ok,true);
   const marker=scenario==='keychain'?'keychain-wait':scenario==='health'?'health-wait':'sdk-wait';
   await until(()=>stat(join(dir,marker)).then(()=>true,()=>false));
   if(scenario==='events'){
    await until(async()=>{snapshot=(await exchange(owner!,{v:1,id:'s',op:'status'})).status;return snapshot.phase==='connected';});
    assert.equal(snapshot.preflightPassed,true);assert.equal(snapshot.engineStarted,true);
    await writeFile(join(dir,'close-sdk'),'');await until(async()=>{snapshot=(await exchange(owner!,{v:1,id:'s',op:'status'})).status;return snapshot.phase==='reconnecting';});
    await rm(join(dir,'close-sdk'));await writeFile(join(dir,'recover-sdk'),'');await until(async()=>{snapshot=(await exchange(owner!,{v:1,id:'s',op:'status'})).status;return snapshot.phase==='connected';});
    owner.destroy();
   }else{child.kill('SIGTERM');await writeFile(join(dir,'release'),'');}
   const code=await Promise.race([closed,delay(4000).then(()=>{throw Error('entrypoint failed to stop: '+diagnostic);})]);assert.equal(code,0,diagnostic);
   if(scenario==='ready'||scenario==='events')assert.equal(await stat(join(dir,'sdk-destroyed')).then(()=>true,()=>false),true);
   assert.equal(await stat(socketPath).then(()=>true,()=>false),false);
   const lockPath=join(data,platform==='slack'?'slack/service.lock':'service.lock');assert.equal(await stat(lockPath).then(()=>true,()=>false),false);
   if(scenario!=='events')assert.equal(await readFile(join(data,platform==='slack'?'slack/startup-status.json':'startup-status.json'),'utf8').then(()=>true,()=>false),false);
  }finally{owner?.destroy();await writeFile(join(dir,'release'),'');if(child.exitCode===null)child.kill('SIGTERM');await closed;await rm(dir,{recursive:true,force:true});}
 }
});
