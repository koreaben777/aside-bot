import { Client, Events, GatewayIntentBits, ChannelType, PermissionFlagsBits } from 'discord.js';
import { mkdir, chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { readBotToken } from './keychain.js';
import { AsideBackend, ACCOUNT, MODEL } from './aside/backend.js';
import {AsideSettings} from './aside/settings.js';
import { Store } from './store.js';
import { Engine } from './core/engine.js';
import { AttachmentFiles } from './attachments.js';
import { attachDiscordBot, createDiscordOutbound, resolveDiscordAttachments } from './discord/bot.js';
import { assertPrivateChannel } from './discord/privacy.js';
import {acquireServiceLock} from './service-lock.js';
import {preventIdleSleep} from './power.js';

process.umask(0o077);
let cleanup:(()=>Promise<void>)|undefined;
let releaseSleep:(()=>void)|undefined;
let startupStage='로컬 설정';
try {
  const config=await loadConfig();
  if(config.asideAccount!==ACCOUNT||config.asideModel!==MODEL) throw new Error('account_model_mismatch');
  await mkdir(config.dataDir,{recursive:true,mode:0o700});await chmod(config.dataDir,0o700);
  startupStage='단일 실행 잠금';
  cleanup=await acquireServiceLock(config.dataDir);
  startupStage='자동 잠자기 방지';
  releaseSleep=await preventIdleSleep();
  // The store is opened only after taking an exclusive single-process lock.
  startupStage='로컬 상태 저장소';
  const store=new Store(join(config.dataDir,'state.sqlite'));
  const backend=new AsideBackend({cliPath:config.cliPath,registryPath:join(config.dataDir,'aside-registry.json'),registryKeyPath:join(config.dataDir,'aside-registry.key')});
  startupStage='Aside CLI 연결';
  await backend.health(); // Verify CLI availability before connecting to Discord.
  const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent],allowedMentions:{parse:[]}});
  const attachments=new AttachmentFiles(join(config.dataDir,'attachments'),resolveDiscordAttachments(client,config));
  const engine=new Engine(config,store,backend,createDiscordOutbound(client,config,store),attachments,new AsideSettings(config.cliPath));
  client.on(Events.Error,()=>console.error('Discord connection error (details withheld).'));
  const purgeDelivered=()=>store.db.prepare("UPDATE outbox SET content='' WHERE state='sent' AND attempted_at<?").run(Date.now()-24*60*60*1000);
  const retention=()=>{purgeDelivered();void attachments.prune(store,Date.now()).catch(()=>console.error('첨부 보관 점검 실패 (세부 정보 생략).'));};
  retention();
  const retentionTimer=setInterval(retention,60*60*1000);retentionTimer.unref();
  let stopped=false;
  const shutdown=async(exitCode=0)=>{
    if(stopped)return;stopped=true;engine.close();clearInterval(retentionTimer);
    const active=store.db.prepare("SELECT DISTINCT thread_id FROM requests WHERE state IN ('running','cancel_requested')").all() as Array<{thread_id:string}>;
    for(const row of active) await engine.stop(row.thread_id,config.ownerUserId,config.guildId).catch(()=>{});
    client.destroy();
    // Do not close the database while an outstanding CLI promise may still settle.
    await cleanup?.();releaseSleep?.();process.exit(exitCode);
  };
  process.once('SIGTERM',()=>void shutdown());process.once('SIGINT',()=>void shutdown());
  client.once(Events.ClientReady,async()=>{
    try {
      if(client.user?.id!==config.applicationId) throw new Error('application_mismatch');
      const channel=await client.channels.fetch(config.channelId);
      if(!channel||channel.type!==ChannelType.GuildText||channel.guildId!==config.guildId) throw new Error('channel_mismatch');
      const me=await channel.guild.members.fetchMe();
      const permissions=channel.permissionsFor(me);
      const needed=[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.CreatePublicThreads,PermissionFlagsBits.SendMessagesInThreads,PermissionFlagsBits.ReadMessageHistory];
      if(!permissions||!permissions.has(needed)||permissions.has(PermissionFlagsBits.Administrator)) throw new Error('permissions_mismatch');
      if(channel.guild.ownerId!==config.ownerUserId)throw new Error('guild_owner_required');
      const roles=await channel.guild.roles.fetch();
      const botRoles=new Set(roles.filter(r=>r.managed&&r.tags?.botId===config.applicationId).map(r=>r.id));
      assertPrivateChannel(channel.permissionOverwrites.cache.map(o=>({id:o.id,type:o.type,allow:o.allow.bitfield.toString(),deny:o.deny.bitfield.toString()})),config.guildId,config.ownerUserId,config.applicationId,botRoles);
      attachDiscordBot(client,engine,()=>shutdown());engine.start();
      await writeFile(join(config.dataDir,'startup-status.json'),JSON.stringify({pid:process.pid,ready:true,readyAt:new Date().toISOString()})+'\n',{mode:0o600}).catch(()=>{});
      console.log('Aside Search ready: owner-only, designated private channel, Aside Guard conversation backend.');
    } catch {console.error('Discord safety preflight failed; service stopped.');await shutdown(1);}
  });
  startupStage='Discord 토큰 Keychain 조회';
  const token=await readBotToken(config.keychainService);
  startupStage='Discord 로그인';
  await client.login(token);
} catch(error) {
  releaseSleep?.();
  await cleanup?.();
  const reasons:Record<string,string>={service_already_running:'이미 실행 중인 PID이거나 PID 상태를 확인할 수 없습니다.',invalid_service_lock:'잠금 파일 형식을 확인할 수 없어 보존했습니다.',service_lock_unavailable:'macOS 잠금 도구를 실행하지 못했습니다.'};
  const reason=error instanceof Error?reasons[error.message]:undefined;
  console.error(`봇 시작 실패: ${startupStage}.${reason?' '+reason:''} npm run doctor로 연결을 진단할 수 있습니다.`);
  process.exitCode=1;
}
