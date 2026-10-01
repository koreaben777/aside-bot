import {SocketModeClient,LogLevel} from '@slack/socket-mode';
import {mkdir,chmod,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {loadSlackConfig} from './config.js';
import {createSlackApi,connectSlack,createSlackOutbound,allowedSlackParent,SlackBot} from './bot.js';
import {readSlackToken} from '../keychain.js';
import {AsideBackend,ACCOUNT,MODEL} from '../aside/backend.js';
import {AsideSettings} from '../aside/settings.js';
import {Store} from '../store.js';
import {Engine} from '../core/engine.js';
import {acquireServiceLock} from '../service-lock.js';
import {preventIdleSleep} from '../power.js';

process.umask(0o077);
let cleanup:(()=>Promise<void>)|undefined,releaseSleep:(()=>void)|undefined;
let socket:SocketModeClient|undefined,engine:Engine|undefined,timer:NodeJS.Timeout|undefined;
let stage='로컬 설정',stopped=false;
const shutdown=async(code=0)=>{
  if(stopped)return;stopped=true;
  engine?.close();if(timer)clearInterval(timer);
  await socket?.disconnect().catch(()=>{});
  if(engine){
    const rows=engine.store.db.prepare("SELECT DISTINCT thread_id FROM requests WHERE state IN ('running','cancel_requested')").all() as Array<{thread_id:string}>;
    for(const row of rows)await engine.stop(row.thread_id,engine.config.ownerUserId,engine.config.guildId).catch(()=>{});
  }
  await cleanup?.();releaseSleep?.();process.exit(code);
};
try{
  const config=await loadSlackConfig();
  if(config.asideAccount!==ACCOUNT||config.asideModel!==MODEL)throw new Error('account_model_mismatch');
  await mkdir(config.dataDir,{recursive:true,mode:0o700});await chmod(config.dataDir,0o700);
  stage='단일 실행 잠금';cleanup=await acquireServiceLock(config.dataDir);
  process.once('SIGINT',()=>void shutdown());process.once('SIGTERM',()=>void shutdown());
  stage='자동 잠자기 방지';releaseSleep=await preventIdleSleep();
  stage='슬랙 토큰 Keychain 조회';
  const botToken=await readSlackToken(config.keychainService,'bot'),appToken=await readSlackToken(config.keychainService,'app');
  const api=createSlackApi(botToken);
  stage='워크스페이스·앱·개인 DM 확인';const identity=await connectSlack(api,config);config.channelId=identity.dmChannelId;
  const store=new Store(join(config.dataDir,'state.sqlite'));
  const backend=new AsideBackend({cliPath:config.cliPath,registryPath:join(config.dataDir,'aside-registry.json'),registryKeyPath:join(config.dataDir,'aside-registry.key')});
  stage='Aside CLI 연결';await backend.health();
  engine=new Engine(config,store,backend,createSlackOutbound(api,config,store,config.channelMentions),undefined,new AsideSettings(config.cliPath),parent=>allowedSlackParent(config,parent,config.channelMentions));
  const bot=new SlackBot(engine,api,config.applicationId,{enabled:config.channelMentions,botUserId:identity.botUserId,channelThreadAutoReply:config.channelThreadAutoReply});
  // SDK diagnostics may contain tokens, WebSocket URLs or message bodies.
  const silentLogger={getLevel:()=>LogLevel.ERROR,setLevel:()=>{},setName:()=>{},debug:()=>{},info:()=>{},warn:()=>{},error:()=>{}};
  socket=new SocketModeClient({appToken,logger:silentLogger,clientOptions:{timeout:30_000,retryConfig:{retries:0}}});
  socket.on('error',()=>console.error('슬랙 연결 오류 (세부 정보 생략).'));
  socket.on('slack_event',({type,body,ack}:{type:string;body:unknown;ack:()=>Promise<void>})=>{
    void (async()=>{
      await ack();
      if(type==='events_api'&&!stopped)await bot.handle(body);
    })().catch(()=>console.error('슬랙 요청 처리 실패 (세부 정보 생략). !aside status와 Mac의 Aside 연결을 확인하세요.'));
  });
  stage='Socket Mode 연결';await socket.start();
  engine.start();
  const retention=()=>store.db.prepare("UPDATE outbox SET content='' WHERE state='sent' AND attempted_at<?").run(Date.now()-24*60*60*1000);
  retention();timer=setInterval(retention,60*60*1000);timer.unref();
  await writeFile(join(config.dataDir,'startup-status.json'),JSON.stringify({pid:process.pid,ready:true,platform:'slack',channelThreadAutoReply:config.channelThreadAutoReply,readyAt:new Date().toISOString()})+'\n',{mode:0o600});
  console.log(`Aside Slack 준비 완료: 지정 개인 계정의 1:1 DM${config.channelMentions?` 및 채널 @Aside 멘션(스레드 자동 응답 ${config.channelThreadAutoReply?'켜짐':'꺼짐'})`:''}을 사용합니다.`);
}catch{
  console.error(`슬랙 봇 시작 실패: ${stage}. docs/slack-setup.md의 설정과 연결을 확인하세요.`);
  await shutdown(1);
}
