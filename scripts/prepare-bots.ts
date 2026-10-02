import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {loadConfig} from '../src/config.js';
import {loadSlackConfig} from '../src/slack/config.js';
import {parseSessionList,runAsideCli,shutdownAsideCliChildren} from '../src/aside/backend.js';

export async function prepareBots(signal?:AbortSignal):Promise<void>{
 signal?.throwIfAborted();const config=await loadConfig();signal?.throwIfAborted();await loadSlackConfig();signal?.throwIfAborted();
 await runAsideCli('/usr/bin/open',['-g','-j','-b','at.studio.AsideBrowser'],10_000);signal?.throwIfAborted();
 for(let attempt=0;attempt<10;attempt++){
  signal?.throwIfAborted();
  try{parseSessionList(await runAsideCli(config.cliPath,['session','list','--account',config.asideAccount],5000));signal?.throwIfAborted();return;}catch{signal?.throwIfAborted();}
  if(attempt<9)await delay(1000,undefined,{signal});
 }
 throw Error('aside_unavailable');
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const controller=new AbortController();
 const stop=()=>{controller.abort();void shutdownAsideCliChildren();};
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
 try{await prepareBots(controller.signal);}catch{if(!controller.signal.aborted){console.error('시작 준비 실패. 양쪽 설정과 Aside 설치·로그인·연결을 확인하세요.');process.exitCode=1;}}
 finally{await shutdownAsideCliChildren();}
}
