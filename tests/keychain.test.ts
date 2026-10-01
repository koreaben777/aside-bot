import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {saveBotToken, type SecurityRunner} from '../src/keychain.js';

const service='local.aside-discord-search.1111111111111111111';
// Synthetic fixture, not a Discord credential.
const fixture=['a'.repeat(24),'b'.repeat(6),'c'.repeat(24)].join('.');

test('Keychain write ends on stdin EOF and verifies stored token without putting it in argv',async()=>{
 const calls:Array<{args:string[];input?:string}>=[];
 const run:SecurityRunner=async(args,input)=>{calls.push({args,input});return args[0]==='find-generic-password'?fixture+'\n':'';};
 await saveBotToken(service,fixture,run);
 assert.equal(calls.length,2);
 assert.deepEqual(calls[0]!.args,['-i']);
 assert.equal(calls[0]!.input,`add-generic-password -U -s ${service} -a discord-bot -w ${fixture}\n`);
 assert.equal(calls[0]!.input!.includes('\nquit'),false);
 for(const call of calls)assert.equal(call.args.some(x=>x.includes(fixture)),false);
 assert.equal(calls[1]!.args[0],'find-generic-password');
});

test('Keychain write failure stops before verification and mismatched reads remain failures',async()=>{
 let calls=0;
 await assert.rejects(saveBotToken(service,fixture,async()=>{calls++;throw new Error('keychain_unavailable');}),/keychain_unavailable/);
 assert.equal(calls,1);
 await assert.rejects(saveBotToken(service,fixture,async(args)=>args[0]==='-i'?'':['d'.repeat(24),'e'.repeat(6),'f'.repeat(24)].join('.')),/keychain_verification_failed/);
});

test('macOS security interactive mode accepts harmless help followed by EOF', {skip:process.platform!=='darwin'},()=>{
 const result=spawnSync('/usr/bin/security',['-i'],{input:'help\n',encoding:'utf8',timeout:5000});
 assert.equal(result.status,0);
 // No keychain access, writes or credential reads occur in this integration test.
});
