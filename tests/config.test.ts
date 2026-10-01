import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { readBotToken, saveBotToken } from '../src/keychain.js';

test('configuration pins subscription provider and rejects malformed Discord IDs', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'aside-config-test-'));
 const file=join(dir,'config.json');
 const base={ownerUserId:'333333333333333333',guildId:'444444444444444444',channelId:'1111111111111111111',applicationId:'2222222222222222222',cliPath:process.execPath,asideAccount:'u0',asideModel:'openai-codex/gpt-6-luna',dataDir:dir};
 try {
  await writeFile(file,JSON.stringify(base));assert.equal((await loadConfig(file)).asideModel,base.asideModel);
  await writeFile(file,JSON.stringify({...base,asideModel:'openai/gpt-6-luna'}));await assert.rejects(loadConfig(file),/subscription_model_required/);
  await writeFile(file,JSON.stringify({...base,ownerUserId:'*'}));await assert.rejects(loadConfig(file),/invalid_ownerUserId/);
  await writeFile(file,JSON.stringify({...base,cliPath:'./aside'}));await assert.rejects(loadConfig(file),/absolute_cli_path_required/);
 } finally {await rm(dir,{recursive:true,force:true});}
});
test('Keychain inputs reject injection before spawning security',async()=>{
 await assert.rejects(readBotToken('bad;service'),/invalid_service/);
 await assert.rejects(saveBotToken('local.aside-discord-search.2222222222222222222','abc\nquit'),/invalid_credential/);
});
