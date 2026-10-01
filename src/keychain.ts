import { spawn } from 'node:child_process';

export type SecurityRunner = (args:string[], input?:string) => Promise<string>;

function security(args:string[], input?:string):Promise<string> {
  return new Promise((resolve,reject)=>{
    const p=spawn('/usr/bin/security',args,{shell:false,stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',HOME:process.env.HOME}});
    let out='';let tooLarge=false;
    const timer=setTimeout(()=>{p.kill('SIGKILL');reject(new Error('keychain_timeout'));},30_000);
    p.stdout.on('data',(b:Buffer)=>{out+=b.toString();if(out.length>16_384){tooLarge=true;p.kill('SIGKILL');}});
    // Never expose security's diagnostic stream; interactive commands may echo secrets.
    p.stderr.resume();
    p.on('error',()=>{clearTimeout(timer);reject(new Error('keychain_unavailable'));});
    p.on('close',code=>{clearTimeout(timer);code===0&&!tooLarge?resolve(out):reject(new Error('keychain_unavailable'));});
    p.stdin.on('error',()=>{});p.stdin.end(input);
  });
}
const tokenPattern=/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}$/;
export async function readBotToken(service:string, run:SecurityRunner=security):Promise<string> {
  if(!/^local\.aside-discord-search\.\d{17,20}$/.test(service)) throw new Error('invalid_service');
  const value=(await run(['find-generic-password','-s',service,'-a','discord-bot','-w'])).trim();
  if(!tokenPattern.test(value)) throw new Error('invalid_stored_token');
  return value;
}
export async function saveBotToken(service:string,token:string,run:SecurityRunner=security):Promise<void> {
  if(!/^local\.aside-discord-search\.\d{17,20}$/.test(service)||!tokenPattern.test(token)) throw new Error('invalid_credential');
  // Input is tightly validated and sent over stdin, never process argv or shell history.
  // security -i exits on stdin EOF. It has no 'quit' command: sending one makes
  // a successful credential write appear to fail with exit status 1.
  await run(['-i'],`add-generic-password -U -s ${service} -a discord-bot -w ${token}\n`);
  const saved=await readBotToken(service,run);
  if(saved!==token) throw new Error('keychain_verification_failed');
}

type SlackTokenKind='bot'|'app';
function validSlackCredential(service:string,kind:SlackTokenKind,token?:string):boolean {
  return /^local\.aside-slack\.A[A-Z0-9]{8,}$/.test(service) && ['bot','app'].includes(kind)
    && (token===undefined || new RegExp(`^${kind==='bot'?'xoxb':'xapp'}-[A-Za-z0-9-]{10,}$`).test(token));
}
export async function readSlackToken(service:string,kind:SlackTokenKind,run:SecurityRunner=security):Promise<string> {
  if(!validSlackCredential(service,kind))throw new Error('invalid_service');
  const token=(await run(['find-generic-password','-s',service,'-a',`slack-${kind}`,'-w'])).trim();
  if(!validSlackCredential(service,kind,token))throw new Error('invalid_stored_token');
  return token;
}
export async function saveSlackToken(service:string,kind:SlackTokenKind,token:string,run:SecurityRunner=security):Promise<void> {
  if(!validSlackCredential(service,kind,token))throw new Error('invalid_credential');
  await run(['-i'],`add-generic-password -U -s ${service} -a slack-${kind} -w ${token}\n`);
  if(await readSlackToken(service,kind,run)!==token)throw new Error('keychain_verification_failed');
}
