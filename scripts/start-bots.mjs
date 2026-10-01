import {spawn} from 'node:child_process';

// Each bot retains its own service lock; only children of this launcher are stopped.
const children=new Set();
let stopping=false,exitCode=0;
function stop(code=0){
  if(stopping)return;
  stopping=true;exitCode=code;
  for(const child of children)child.kill('SIGTERM');
}
process.on('SIGINT',()=>stop());
process.on('SIGTERM',()=>stop());
for(const [name,file] of [['Discord','dist/src/main.js'],['Slack','dist/src/slack/main.js']]){
  const child=spawn(process.execPath,[file],{stdio:'inherit'});
  children.add(child);
  child.on('error',()=>{
    console.error(`${name} 봇을 실행하지 못했습니다.`);
    stop(1);
  });
  child.on('close',(code,signal)=>{
    children.delete(child);
    if(!stopping){
      console.log(`${name} 봇이 종료되어 함께 시작한 봇도 종료합니다.`);
      stop(code??(signal?1:0));
    }
    if(children.size===0)process.exitCode=exitCode;
  });
}
