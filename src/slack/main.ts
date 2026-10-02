import {SocketModeClient,LogLevel} from '@slack/socket-mode';
import {mkdir,chmod,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {loadSlackConfig} from './config.js';
import {createSlackApi,connectSlack,createSlackOutbound,allowedSlackParent,SlackBot} from './bot.js';
import {readSlackToken} from '../keychain.js';
import {AsideBackend,ACCOUNT,MODEL,shutdownAsideCliChildren} from '../aside/backend.js';
import {AsideSettings} from '../aside/settings.js';
import {Store} from '../store.js';
import {Engine} from '../core/engine.js';
import {acquireServiceLock} from '../service-lock.js';
import {createSleepController} from '../power.js';
import {startRuntimeControl,readManagedBootstrap,reduceConnection,type RuntimeControl,type Phase,type Snapshot} from '../runtime-control.js';

process.umask(0o077);
const sleep=createSleepController();
let cleanup:(()=>Promise<void>)|undefined,control:RuntimeControl|undefined;
let socket:SocketModeClient|undefined,engine:Engine|undefined,store:Store|undefined,timer:NodeJS.Timeout|undefined;
let stopping=false,shutdownTask:Promise<void>|undefined,phase:Phase='starting',stage='bootstrap',prepared=false,sdkConnected=false;
let startup=Promise.resolve();
const sdkStarts=new Set<Promise<unknown>>();
const checkpoint=()=>{if(stopping)throw Error('shutdown_pending');};
const publish=(patch:Partial<Snapshot>={})=>control?.publish({phase,stage,sleepActive:sleep.active(),...patch});
const connection=(event:Parameters<typeof reduceConnection>[1])=>{phase=reduceConnection(phase,event,prepared);publish();};
function shutdown(code=0):Promise<void>{
 if(shutdownTask)return shutdownTask;
 stopping=true;phase='stopping';stage='shutdown';publish();engine?.close();if(timer)clearInterval(timer);
 shutdownTask=(async()=>{
  if(engine){const rows=engine.store.db.prepare("SELECT DISTINCT thread_id FROM requests WHERE state IN ('running','cancel_requested')").all() as Array<{thread_id:string}>;
   for(const row of rows)await engine.stop(row.thread_id,engine.config.ownerUserId,engine.config.guildId).catch(()=>{});
  }
  engine?.abortLocalWork();await shutdownAsideCliChildren();
  // SDK URL discovery can create a socket after an early disconnect. Settle every start first.
  await startup.catch(()=>{});while(sdkStarts.size)await Promise.allSettled([...sdkStarts]);await socket?.disconnect().catch(()=>{});await control?.close();
  await engine?.waitForIdle();store?.close();await sleep.close();await cleanup?.();process.exitCode=code;
 })().catch(()=>{publish({errorCode:'shutdown_pending'});process.exitCode=1;});return shutdownTask;
}
process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());
async function initialize(){
 const bootstrap=await readManagedBootstrap();checkpoint();stage='config';
 const config=await loadSlackConfig();checkpoint();if(config.asideAccount!==ACCOUNT||config.asideModel!==MODEL)throw Error('config_invalid');
 await mkdir(config.dataDir,{recursive:true,mode:0o700});checkpoint();await chmod(config.dataDir,0o700);checkpoint();
 stage='lock';cleanup=await acquireServiceLock(config.dataDir);checkpoint();
 control=await startRuntimeControl({dataDir:config.dataDir,platform:'slack',ownerToken:bootstrap.token,initialSleep:bootstrap.sleepEnabled,setSleep:sleep.set,sleepActive:sleep.active,shutdown:()=>shutdown(),beforeStatus:()=>{if(socket?.websocket&&!socket.websocket.isActive())sdkConnected=false;if(prepared&&!sdkConnected&&!stopping&&phase==='connected')connection('closed');}});checkpoint();
 stage='owner';publish();await control.waitForOwner();checkpoint();
 if(!bootstrap.token&&!await sleep.set(bootstrap.sleepEnabled)&&bootstrap.sleepEnabled)throw Error('sleep_unavailable');checkpoint();
 stage='keychain';publish();const botToken=await readSlackToken(config.keychainService,'bot');checkpoint();const appToken=await readSlackToken(config.keychainService,'app');checkpoint();
 const api=createSlackApi(botToken);stage='preflight';publish();const identity=await connectSlack(api,config);checkpoint();config.channelId=identity.dmChannelId;
 store=new Store(join(config.dataDir,'state.sqlite'));const activeStore=store;
 const backend=new AsideBackend({cliPath:config.cliPath,registryPath:join(config.dataDir,'aside-registry.json'),registryKeyPath:join(config.dataDir,'aside-registry.key')});
 stage='aside';publish();try{await backend.health();}catch{publish({asideHealth:{state:'error',checkedAt:new Date().toISOString()}});throw Error('aside_unavailable');}checkpoint();publish({asideHealth:{state:'ok',checkedAt:new Date().toISOString()}});
 engine=new Engine(config,store,backend,createSlackOutbound(api,config,store,config.channelMentions,()=>stopping),undefined,new AsideSettings(config.cliPath),parent=>allowedSlackParent(config,parent,config.channelMentions));const activeEngine=engine;
 const bot=new SlackBot(engine,api,config.applicationId,{enabled:config.channelMentions,botUserId:identity.botUserId,channelThreadAutoReply:config.channelThreadAutoReply});
 const silentLogger={getLevel:()=>LogLevel.ERROR,setLevel:()=>{},setName:()=>{},debug:()=>{},info:()=>{},warn:()=>{},error:()=>{}};
 socket=new SocketModeClient({appToken,logger:silentLogger,clientOptions:{timeout:30000,retryConfig:{retries:0}}});
 socket.on('connecting',()=>{sdkConnected=false;connection('reconnecting');});
 socket.on('connected',()=>{sdkConnected=true;connection('ready');});
 socket.on('reconnecting',()=>{sdkConnected=false;connection('closed');});
 socket.on('close',()=>{if(socket?.websocket?.isActive())return;sdkConnected=false;connection('closed');});
 socket.on('disconnected',()=>{sdkConnected=false;connection(stopping?'stop':'fatal');});
 socket.on('error',()=>{sdkConnected=false;connection('closed');});
 socket.on('slack_event',({type,body,ack}:{type:string;body:unknown;ack:()=>Promise<void>})=>{
  if(stopping)return;
  void activeEngine.trackWork((async()=>{await ack();if(type==='events_api'&&!stopping)await bot.handle(body);})().catch(()=>{}));
 });
 const rawStart=socket.start.bind(socket);
 const startSdk=()=>{if(stopping)return Promise.resolve({ok:false});const pending=rawStart();sdkStarts.add(pending);void pending.then(()=>sdkStarts.delete(pending),()=>sdkStarts.delete(pending));return pending;};
 // SDK 3.1.0 reconnect timer does not catch start rejection. Consume it here.
 socket.start=async()=>{try{return await startSdk();}catch{connection('fatal');return {ok:false};}};
 stage='platform';publish();await startSdk();checkpoint();
 stage='engine';engine.start();prepared=true;publish({preflightPassed:true,engineStarted:true});connection(sdkConnected?'ready':'closed');
 const retention=()=>{if(!stopping)activeStore.db.prepare("UPDATE outbox SET content='' WHERE state='sent' AND attempted_at<?").run(Date.now()-86400000);};
 retention();timer=setInterval(retention,3600000);timer.unref();
 await writeFile(join(config.dataDir,'startup-status.json'),JSON.stringify({pid:process.pid,ready:true,platform:'slack',channelThreadAutoReply:config.channelThreadAutoReply,readyAt:new Date().toISOString()})+'\n',{mode:0o600});checkpoint();
}
startup=initialize();void startup.catch(error=>{
 if(stopping)return;phase='error';const code=error instanceof Error?error.message:'';
 const allowed=['service_already_running','invalid_service_lock','sleep_unavailable','aside_unavailable','socket_path_too_long','invalid_owner','owner_timeout'];
 publish({errorCode:allowed.includes(code)?code:stage==='keychain'?'keychain_unavailable':stage==='config'?'config_invalid':stage==='preflight'?'preflight_failed':'platform_unavailable'});
 console.error(`슬랙 봇 시작 실패 (${stage}). 설정과 연결을 확인하세요.`);void shutdown(1);
});
