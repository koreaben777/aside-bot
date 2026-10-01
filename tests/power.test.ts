import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

test('sleep prevention creates a macOS idle sleep assertion and releases it', {skip:process.platform!=='darwin'},async()=>{
 const modulePath='../src/power.js';
 const power=await import(modulePath).catch(()=>({}));
 assert.equal(typeof power.preventIdleSleep,'function','sleep prevention must be available');
 const assertions=async()=>(await promisify(execFile)('/usr/bin/pmset',['-g','assertions'])).stdout;
 const hasAssertion=(text:string)=>text.split(/\n(?=\s*pid \d+\()/).some(block=>block.includes(`Created for PID: ${process.pid}.`)&&block.includes('PreventUserIdleSystemSleep'));
 const waitFor=async(expected:boolean)=>{
  for(let i=0;i<50;i++){if(hasAssertion(await assertions())===expected)return;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.fail(`own idle sleep assertion did not become ${expected}`);
 };
 const release=await power.preventIdleSleep();
 try{await waitFor(true);}finally{release();}
 await waitFor(false);
});
