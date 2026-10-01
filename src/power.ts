import {spawn} from 'node:child_process';
import {once} from 'node:events';

export async function preventIdleSleep():Promise<()=>void> {
  const child=spawn('/usr/bin/caffeinate',['-i','-w',String(process.pid)],{stdio:'ignore'});
  await once(child,'spawn');
  child.unref();
  return ()=>{child.kill();};
}
