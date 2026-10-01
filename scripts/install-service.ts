import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { loadConfig } from '../src/config.js';
import { readBotToken } from '../src/keychain.js';
import { AsideBackend } from '../src/aside/backend.js';
const xml=(x:string)=>x.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
try {
  const c=await loadConfig();
  const backend=new AsideBackend({cliPath:c.cliPath,registryPath:join(c.dataDir,'aside-registry.json'),registryKeyPath:join(c.dataDir,'aside-registry.key')});
  await backend.health();await readBotToken(c.keychainService);
  const label='local.aside-discord-search';
  const folder=join(homedir(),'Library','LaunchAgents');await mkdir(folder,{recursive:true});
  const target=join(folder,label+'.plist');
  const plist=`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(resolve('dist/src/main.js'))}</string></array>\n<key>WorkingDirectory</key><string>${xml(process.cwd())}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>60</integer>\n<key>Umask</key><integer>63</integer>\n<key>StandardOutPath</key><string>${xml(join(c.dataDir,'service.log'))}</string>\n<key>StandardErrorPath</key><string>${xml(join(c.dataDir,'service-error.log'))}</string>\n</dict></plist>\n`;
  // Existing installation is never silently overwritten or restarted.
  await writeFile(target,plist,{mode:0o600,flag:'wx'});
  const code=await new Promise<number|null>(res=>{const p=spawn('/bin/launchctl',['bootstrap',`gui/${process.getuid!()}`,target],{shell:false,stdio:'ignore'});p.on('error',()=>res(null));p.on('close',res);});
  if(code!==0)throw new Error('launchagent_not_loaded');
  console.log('검증된 봇의 LaunchAgent를 등록했습니다. 실제 Discord 연결 상태는 service.log에서 확인하세요.');
} catch {console.error('상시 실행을 설치하지 못했습니다. Keychain, CLI 연결, 기존 LaunchAgent를 확인하세요.');process.exitCode=1;}
