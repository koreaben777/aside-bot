import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

async function run(binary:string,args:string[]):Promise<{code:number|null;out:string;error:string}> {
  return new Promise(resolve=>{
    let out='',error='',size=0,done=false;
    const child=spawn(binary,args,{shell:false,stdio:['ignore','pipe','pipe'],env:{HOME:process.env.HOME,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',TMPDIR:process.env.TMPDIR,LANG:'en_US.UTF-8'}});
    const finish=(code:number|null)=>{if(done)return;done=true;clearTimeout(timer);resolve({code,out,error});};
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(null);},30_000);
    for(const [stream,which] of [[child.stdout,'out'],[child.stderr,'error']] as const) stream.on('data',(b:Buffer)=>{size+=b.length;if(size>1_000_000){child.kill('SIGKILL');finish(null);return;}if(which==='out')out+=b.toString();else error+=b.toString();});
    child.on('error',()=>finish(null));child.on('close',finish);
  });
}
try {
  const c=await loadConfig();
  const version=await run(c.cliPath,['--version']);
  const check=await run(c.cliPath,['repl','--account',c.asideAccount,'--host','local',`console.log('ASIDE_BOT_DOCTOR:' + JSON.stringify({accountReachable:true,defaultModel:aside.settings.get('defaultModel')}));`]);
  const match=check.out.match(/ASIDE_BOT_DOCTOR:(\{[^\n]+\})/);
  let model:string|null=null;
  if(match) { try {const data=JSON.parse(match[1]!);model=data.defaultModel?.provider+'/'+data.defaultModel?.modelId;} catch {} }
  const rawFailure=check.error+'\n'+check.out;
  const reason=check.code===0&&match?'connected':/keychain|SecItem|cdp-sign/i.test(rawFailure)?'macos_keychain_auth_blocked':'cli_connection_failed';
  const report={checkedAt:new Date().toISOString(),cliVersion:version.code===0?version.out.trim().replace(/[^a-zA-Z0-9. -]/g,'').slice(0,80):null,cliConnected:reason==='connected',reason,configuredAccount:c.asideAccount,configuredModel:c.asideModel,desktopDefaultModel:model,executionMode:"aside-guard",actualModelVerified:false};
  await mkdir(c.dataDir,{recursive:true,mode:0o700});
  await writeFile(join(c.dataDir,'doctor-report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(report,null,2));
  if(!report.cliConnected) {console.log('CLI 연결이 차단되어 검색 실행과 서비스 설치를 진행하지 않았습니다.');process.exitCode=1;}
} catch {console.error('진단 실패: 로컬 설정과 CLI 경로를 확인하세요. 비밀 값은 출력하지 않았습니다.');process.exitCode=1;}
