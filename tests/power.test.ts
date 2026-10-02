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
 try{await waitFor(true);}finally{await release();}
 await waitFor(false);
});


test('sleep controller serializes rapid toggles and repeated close', {skip:process.platform!=='darwin'},async()=>{
 const modulePath='../src/power.js';const power=await import(modulePath) as any;
 assert.equal(typeof power.createSleepController,'function');
 const c=power.createSleepController();
 assert.equal(c.active(),false);
 try{assert.deepEqual(await Promise.all([c.set(true),c.set(true),c.set(false),c.set(true)]),[true,true,false,true]);assert.equal(c.active(),true);assert.equal(await c.set(false),false);assert.equal(c.active(),false);}
 finally{await c.close();await c.close();}
 assert.equal(await c.set(true),false);
});
