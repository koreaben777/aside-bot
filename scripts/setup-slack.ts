import {open,lstat,unlink,mkdir,chmod} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {loadSlackConfig} from '../src/slack/config.js';
import {readSlackToken,saveSlackToken} from '../src/keychain.js';
import {createSlackApi,connectOwnerDm} from '../src/slack/bot.js';

process.umask(0o077);
let stage='로컬 설정';
try{
  const config=await loadSlackConfig();
  await mkdir(config.dataDir,{recursive:true,mode:0o700});
  const folder=await lstat(config.dataDir);
  if(!folder.isDirectory()||(folder.mode&0o077)||folder.uid!==process.getuid?.())throw new Error('unsafe_staging_permissions');
  await chmod(config.dataDir,0o700);
  stage='토큰 Keychain 이전';
  for(const kind of ['bot','app'] as const){
    const path=join(config.dataDir,`bootstrap-${kind}-token`);
    let token:string|undefined;
    try{
      const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{
        const info=await file.stat();
        if(!info.isFile()||(info.mode&0o077)||info.uid!==process.getuid?.()||info.size>4096)throw new Error('unsafe_staging_permissions');
        token=(await file.readFile('utf8')).trim();
      }finally{await file.close();}
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(token!==undefined){await saveSlackToken(config.keychainService,kind,token);await unlink(path);}
    await readSlackToken(config.keychainService,kind);
  }
  stage='워크스페이스·앱·개인 DM 확인';
  await connectOwnerDm(createSlackApi(await readSlackToken(config.keychainService,'bot')),config);
  console.log('슬랙 개인 DM 확인 완료. 토큰은 Keychain에 저장됐습니다. Aside를 실행한 뒤 npm run start:slack으로 봇을 시작하세요.');
}catch{
  console.error(`슬랙 설정 실패: ${stage}. docs/slack-setup.md를 확인하세요. 비밀 값은 출력하지 않았습니다.`);process.exitCode=1;
}
