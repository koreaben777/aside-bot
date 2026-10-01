import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { BotConfig } from './types.js';

export interface AppConfig extends BotConfig {
  applicationId: string;
  cliPath: string;
  asideAccount: string;
  asideModel: string;
  dataDir: string;
  keychainService: string;
}
export async function loadConfig(file = 'config.local.json'): Promise<AppConfig> {
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!value || typeof value !== 'object') throw new Error('invalid_config');
  const c=value as Record<string,unknown>;
  const out = {} as AppConfig;
  for(const key of ['ownerUserId','guildId','channelId','applicationId'] as const) {
    if(typeof c[key]!=='string' || !/^\d{17,20}$/.test(c[key])) throw new Error('invalid_'+key);
    out[key]=c[key];
  }
  if(typeof c.asideAccount!=='string' || !/^u\d+$/.test(c.asideAccount)) throw new Error('invalid_aside_account');
  if(typeof c.asideModel!=='string' || !/^openai-codex\/[a-zA-Z0-9._-]+$/.test(c.asideModel)) throw new Error('subscription_model_required');
  if(typeof c.cliPath!=='string'||!isAbsolute(c.cliPath)) throw new Error('absolute_cli_path_required');
  if(typeof c.dataDir!=='string'||!isAbsolute(c.dataDir)) throw new Error('absolute_data_path_required');
  out.cliPath=await realpath(c.cliPath);
  out.dataDir=resolve(c.dataDir);
  out.asideAccount=c.asideAccount;out.asideModel=c.asideModel;
  out.keychainService='local.aside-discord-search.'+out.applicationId;
  return out;
}
