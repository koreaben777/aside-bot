import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {runAsideCli} from '../src/aside/backend.js';import {ExecutionUncertainError} from '../src/types.js';
test('missing window for fixed account is classified without retaining profile or email diagnostics',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'aside-profile-'));try{
  const file=join(dir,'cli.mjs');writeFileSync(file,"process.stderr.write('No browser window is open for account u0 — private@example.invalid (Profile 0). Open a window and retry.');process.exitCode=1;");
  await assert.rejects(runAsideCli(process.execPath,[file],5000),e=>e instanceof ExecutionUncertainError&&e.code==='aside_profile_window_closed'&&!JSON.stringify(e).includes('private')&&!e.message.includes('example'));
  writeFileSync(file,"process.stderr.write('No browser window is open for account u1');process.exitCode=1;");
  await assert.rejects(runAsideCli(process.execPath,[file],5000),e=>e instanceof ExecutionUncertainError&&e.code==='cli_execution_unknown');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
