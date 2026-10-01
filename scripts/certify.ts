import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { certifyAsideLive, CertificationBlockedError } from '../src/aside/operator-certify.js';

process.umask(0o077);
let reportPath:string|undefined;
const progress:Array<{stage:string;sessionId?:string}>=[];
try {
  const c=await loadConfig();await mkdir(c.dataDir,{recursive:true,mode:0o700});
  reportPath=join(c.dataDir,'certification-report.json');
  const privatePath=join(c.dataDir,'policy-operator-private.pem');
  const publicPath=join(c.dataDir,'policy-public.pem');
  let privateKey:string;
  try {
    privateKey=await readFile(privatePath,'utf8');
    const info=await stat(privatePath);if(info.mode&0o077)throw new Error('private_key_permissions');
  } catch(e) {
    if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;
    const pair=generateKeyPairSync('ed25519');
    privateKey=pair.privateKey.export({format:'pem',type:'pkcs8'}).toString();
    await writeFile(privatePath,privateKey,{mode:0o600,flag:'wx'});
  }
  const publicKey=createPublicKey(privateKey).export({format:'pem',type:'spki'}).toString();
  await writeFile(publicPath,publicKey,{mode:0o600});
  console.log('고정된 안전 테스트를 시작합니다. 실제 도구 차단 증거가 없으면 인증하지 않습니다.');
  console.log('질문 전달 경로: session queue. 접수 응답이 아니라 실제 턴 완료를 확인합니다.');
  await certifyAsideLive({cliPath:c.cliPath,projectRoot:process.cwd(),certificatePath:join(c.dataDir,'policy-certificate.json'),operatorPrivateKeyPath:privatePath,
    onProgress:async event=>{
      progress.push(event);
      await writeFile(reportPath!,JSON.stringify({checkedAt:new Date().toISOString(),certified:false,progress},null,2)+'\n',{mode:0o600});
      console.log('검증 단계: '+event.stage);
    },
  });
  const report={checkedAt:new Date().toISOString(),certified:true,progress};
  await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log('검색 전용 권한 검증을 통과했습니다. 실제 Discord 질문·후속 대화 시험 후 상시 실행을 설치하세요.');
} catch(e) {
  const reason=e instanceof CertificationBlockedError?e.reason:'operator_probe_failed';
  const report={checkedAt:new Date().toISOString(),certified:false,reason,progress};
  if(reportPath)await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.error('권한 검증이 중단됐습니다: '+reason+'. 검색 기능은 활성화하지 않았습니다.');process.exitCode=1;
}
