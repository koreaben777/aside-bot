import {Client,Events,GatewayIntentBits,ChannelType,PermissionFlagsBits} from 'discord.js';
import {mkdir,chmod,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {loadConfig} from './config.js';
import {readBotToken} from './keychain.js';
import {AsideBackend,ACCOUNT,MODEL,shutdownAsideCliChildren} from './aside/backend.js';
import {AsideSettings} from './aside/settings.js';
import {Store} from './store.js';
import {Engine} from './core/engine.js';
import {AttachmentFiles} from './attachments.js';
import {attachDiscordBot,createDiscordOutbound,resolveDiscordAttachments} from './discord/bot.js';
import {assertPrivateChannel} from './discord/privacy.js';
import {acquireServiceLock} from './service-lock.js';
import {createSleepController} from './power.js';
import {startRuntimeControl,readManagedBootstrap,reduceConnection,type RuntimeControl,type Phase,type Snapshot} from './runtime-control.js';

process.umask(0o077);
const sleep=createSleepController();
let cleanup:(()=>Promise<void>)|undefined,control:RuntimeControl|undefined;
let client:Client|undefined,engine:Engine|undefined,store:Store|undefined,timer:NodeJS.Timeout|undefined;
let stopping=false,shutdownTask:Promise<void>|undefined,phase:Phase='starting',stage='bootstrap',prepared=false;
let startup=Promise.resolve();
const readyWork=new Set<Promise<void>>();
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
  // SDK gateway discovery can create shards after an early destroy. Settle it first.
  await startup.catch(()=>{});await Promise.allSettled([...readyWork]);await client?.destroy().catch(()=>{});await control?.close();
  await engine?.waitForIdle();store?.close();await sleep.close();await cleanup?.();process.exitCode=code;
 })().catch(()=>{publish({errorCode:'shutdown_pending'});process.exitCode=1;});return shutdownTask;
}
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
async function initialize(){
 const bootstrap=await readManagedBootstrap();checkpoint();stage='config';
 const config=await loadConfig();checkpoint();
 if(config.asideAccount!==ACCOUNT||config.asideModel!==MODEL)throw Error('config_invalid');
 await mkdir(config.dataDir,{recursive:true,mode:0o700});checkpoint();await chmod(config.dataDir,0o700);checkpoint();
 stage='lock';cleanup=await acquireServiceLock(config.dataDir);checkpoint();
 control=await startRuntimeControl({dataDir:config.dataDir,platform:'discord',ownerToken:bootstrap.token,initialSleep:bootstrap.sleepEnabled,setSleep:sleep.set,sleepActive:sleep.active,shutdown:()=>shutdown(),beforeStatus:()=>{
  if(prepared&&!stopping&&phase==='connected'&&!client?.isReady())connection('closed');
 }});checkpoint();
 stage='owner';publish();await control.waitForOwner();checkpoint();
 if(!bootstrap.token&&!await sleep.set(bootstrap.sleepEnabled)&&bootstrap.sleepEnabled)throw Error('sleep_unavailable');checkpoint();
 store=new Store(join(config.dataDir,'state.sqlite'));
 const backend=new AsideBackend({cliPath:config.cliPath,registryPath:join(config.dataDir,'aside-registry.json'),registryKeyPath:join(config.dataDir,'aside-registry.key')});
 stage='aside';publish();try{await backend.health();}catch{publish({asideHealth:{state:'error',checkedAt:new Date().toISOString()}});throw Error('aside_unavailable');}checkpoint();
 publish({asideHealth:{state:'ok',checkedAt:new Date().toISOString()}});
 client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent],allowedMentions:{parse:[]}});
 const activeClient=client,activeStore=store;
 const attachments=new AttachmentFiles(join(config.dataDir,'attachments'),resolveDiscordAttachments(client,config));
 engine=new Engine(config,store,backend,createDiscordOutbound(client,config,store,()=>stopping),attachments,new AsideSettings(config.cliPath));const activeEngine=engine;
 client.on(Events.ShardReconnecting,()=>connection('reconnecting'));
 client.on(Events.ShardDisconnect,event=>{connection([4004,4010,4011,4012,4013,4014].includes(event.code)?'fatal':'closed');});
 client.on(Events.ShardReady,()=>{if(activeClient.isReady())connection('ready');});
 client.on(Events.ShardResume,()=>{if(activeClient.isReady())connection('ready');});
 client.on(Events.ShardError,()=>{if(!activeClient.isReady())connection('closed');});
 client.on(Events.Error,()=>{if(!activeClient.isReady())connection('closed');});
 client.once(Events.ClientReady,()=>{
  const work=(async()=>{
   checkpoint();stage='preflight';publish();
   if(activeClient.user?.id!==config.applicationId)throw Error('preflight_failed');
   const channel=await activeClient.channels.fetch(config.channelId);checkpoint();
   if(!channel||channel.type!==ChannelType.GuildText||channel.guildId!==config.guildId)throw Error('preflight_failed');
   const me=await channel.guild.members.fetchMe();checkpoint();const permissions=channel.permissionsFor(me);
   const needed=[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.CreatePublicThreads,PermissionFlagsBits.SendMessagesInThreads,PermissionFlagsBits.ReadMessageHistory];
   if(!permissions||!permissions.has(needed)||permissions.has(PermissionFlagsBits.Administrator)||channel.guild.ownerId!==config.ownerUserId)throw Error('preflight_failed');
   const roles=await channel.guild.roles.fetch();checkpoint();
   const botRoles=new Set(roles.filter(r=>r.managed&&r.tags?.botId===config.applicationId).map(r=>r.id));
   assertPrivateChannel(channel.permissionOverwrites.cache.map(o=>({id:o.id,type:o.type,allow:o.allow.bitfield.toString(),deny:o.deny.bitfield.toString()})),config.guildId,config.ownerUserId,config.applicationId,botRoles);
   checkpoint();attachDiscordBot(activeClient,activeEngine,()=>shutdown());stage='engine';activeEngine.start();prepared=true;
   publish({preflightPassed:true,engineStarted:true});connection(activeClient.isReady()?'ready':'closed');
   const retention=()=>{if(stopping)return;activeStore.db.prepare("UPDATE outbox SET content='' WHERE state='sent' AND attempted_at<?").run(Date.now()-86400000);void activeEngine.trackWork(attachments.prune(activeStore,Date.now()).catch(()=>{}));};
   retention();timer=setInterval(retention,3600000);timer.unref();
   await writeFile(join(config.dataDir,'startup-status.json'),JSON.stringify({pid:process.pid,ready:true,readyAt:new Date().toISOString()})+'\n',{mode:0o600}).catch(()=>{});
  })();readyWork.add(work);void work.catch(()=>{if(!stopping){phase='error';publish({errorCode:'preflight_failed'});void shutdown(1);}}).finally(()=>readyWork.delete(work));
 });
 stage='keychain';publish();const token=await readBotToken(config.keychainService);checkpoint();stage='platform';publish();await client.login(token);checkpoint();
}
startup=initialize();void startup.catch(error=>{
 if(stopping)return;phase='error';const code=error instanceof Error?error.message:'';
 const allowed=['service_already_running','invalid_service_lock','sleep_unavailable','aside_unavailable','socket_path_too_long','invalid_owner','owner_timeout'];
 publish({errorCode:allowed.includes(code)?code:stage==='keychain'?'keychain_unavailable':stage==='config'?'config_invalid':'platform_unavailable'});
 console.error(`봇 시작 실패 (${stage}). 설정과 연결을 확인하세요.`);void shutdown(1);
});
