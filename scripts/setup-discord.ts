import { open, lstat, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { REST, Routes } from 'discord.js';
import { loadConfig } from '../src/config.js';
import { readBotToken, saveBotToken } from '../src/keychain.js';
import { asideCommand } from '../src/discord/bot.js';
import { assertPrivateChannel, type ChannelOverwrite } from '../src/discord/privacy.js';

try {
  const c=await loadConfig();
  const staging=join(c.dataDir,'bootstrap-token');
  const folder=await lstat(c.dataDir);
  if(!folder.isDirectory()||(folder.mode&0o077)||folder.uid!==process.getuid?.())throw new Error('unsafe_staging_permissions');
  let staged:string|undefined;
  try {
    const file=await open(staging,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {const info=await file.stat();if(!info.isFile()||(info.mode&0o077)||info.uid!==process.getuid?.())throw new Error('unsafe_staging_permissions');staged=(await file.readFile('utf8')).trim();} finally {await file.close();}
  } catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(staged) {await saveBotToken(c.keychainService,staged);await unlink(staging);staged=undefined;}
  const api=new REST({version:'10'}).setToken(await readBotToken(c.keychainService));
  const app=await api.get(Routes.oauth2CurrentApplication()) as {id:string;owner?:{id:string}};
  if(app.id!==c.applicationId||app.owner?.id!==c.ownerUserId) throw new Error('owner_mismatch');
  const channel=await api.get(Routes.channel(c.channelId)) as {id:string;guild_id:string;type:number;permission_overwrites?:ChannelOverwrite[]};
  if(channel.guild_id!==c.guildId||channel.type!==0) throw new Error('channel_mismatch');
  const guild=await api.get(Routes.guild(c.guildId)) as {owner_id:string};
  if(guild.owner_id!==c.ownerUserId)throw new Error('guild_owner_required');
  const roles=await api.get(Routes.guildRoles(c.guildId)) as Array<{id:string;managed:boolean;tags?:{bot_id?:string}}>;
  const botRoles=new Set(roles.filter(r=>r.managed&&r.tags?.bot_id===c.applicationId).map(r=>r.id));
  assertPrivateChannel(channel.permission_overwrites??[],c.guildId,c.ownerUserId,c.applicationId,botRoles);
  // App is new; POST upserts only /aside and preserves unrelated application commands.
  const command=asideCommand.setDefaultMemberPermissions(0n).toJSON();
  const registered=await api.post(Routes.applicationGuildCommands(c.applicationId,c.guildId),{body:command}) as {id:string;name:string};
  await writeFile(join(c.dataDir,'discord-setup.json'),JSON.stringify({verifiedAt:new Date().toISOString(),applicationId:app.id,ownerId:app.owner.id,channelId:channel.id,commandId:registered.id,commandName:registered.name,tokenInKeychain:true},null,2)+'\n',{mode:0o600});
  console.log('Discord 소유자·비공개 채널 확인 및 /aside 명령 등록 완료. 토큰은 Keychain에 저장됐습니다. 대화형 봇은 Aside Guard로 실행합니다.');
} catch(e) {
  const known=['owner_mismatch','channel_mismatch','private_channel_required','unexpected_channel_reader','guild_owner_required','unsafe_staging_permissions','keychain_unavailable','keychain_timeout','keychain_verification_failed'];
  const reason=e instanceof Error&&known.includes(e.message)?e.message:'setup_blocked';
  console.error('Discord 설정 중단: '+reason+'. 비밀 값은 출력하지 않았습니다.');process.exitCode=1;
}
