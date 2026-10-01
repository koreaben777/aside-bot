import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {loadConfig,type AppConfig} from '../config.js';

/** Reuse the installed Aside runtime, with a separate Slack store and registry. */
export interface SlackConfig extends AppConfig {channelMentions:boolean}
export async function loadSlackConfig(file='config.slack.local.json',runtimeFile='config.local.json'):Promise<SlackConfig> {
  const base=await loadConfig(runtimeFile);
  const value:unknown=JSON.parse(await readFile(file,'utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_slack_config');
  const c=value as Record<string,unknown>;
  for(const [key,pattern] of [['ownerUserId',/^[UW][A-Z0-9]{8,}$/],['teamId',/^T[A-Z0-9]{8,}$/],['applicationId',/^A[A-Z0-9]{8,}$/]] as const){
    if(typeof c[key]!=='string'||!pattern.test(c[key]))throw new Error('invalid_slack_'+key);
  }
  if(c.channelMentions!==undefined&&typeof c.channelMentions!=='boolean')throw new Error('invalid_slack_channelMentions');
  return {...base,channelMentions:c.channelMentions===true,ownerUserId:c.ownerUserId as string,guildId:c.teamId as string,applicationId:c.applicationId as string,
    channelId:'owner-dm',dataDir:join(base.dataDir,'slack'),keychainService:'local.aside-slack.'+c.applicationId};
}
