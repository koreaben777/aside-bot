import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile,spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {copyFile,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';

test('start command opens Aside hidden, waits for its connection, and refuses to start on failure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'aside-start-'));
 try{
  await mkdir(join(dir,'scripts'));await mkdir(join(dir,'dist/src'),{recursive:true});
  await copyFile('scripts/start.command',join(dir,'scripts/start.command'));
  await copyFile('scripts/start-bots.mjs',join(dir,'scripts/start-bots.mjs'));
  await mkdir(join(dir,'dist/src/slack'));await mkdir(join(dir,'dist/scripts'));
  await copyFile('dist/scripts/prepare-bots.js',join(dir,'dist/scripts/prepare-bots.js'));
  await copyFile('dist/src/slack/config.js',join(dir,'dist/src/slack/config.js'));
  await writeFile(join(dir,'config.slack.local.json'),JSON.stringify({ownerUserId:'U12345678',teamId:'T12345678',applicationId:'A12345678'}));
  await symlink(resolve('node_modules'),join(dir,'node_modules'));
  for(const name of ['config.js','aside'])await symlink(resolve('dist/src',name),join(dir,'dist/src',name));
  await writeFile(join(dir,'package.json'),'{"type":"module"}');
  for(const [file,name] of [['main.js','server'],['slack/main.js','slack']] as const){
   await writeFile(join(dir,'dist/src',file),`import {appendFileSync,readFileSync} from 'node:fs';appendFileSync('events','${name}\\n');setInterval(()=>{const e=readFileSync('events','utf8');if(e.includes('server\\n')&&e.includes('slack\\n'))process.exit(0);},50);`);
  }
  const cli=join(dir,'cli');
  await writeFile(cli,`#!${process.execPath}
import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['session','list','--account','u0']))process.exit(2);
appendFileSync('events','probe\\n');
const scenario=readFileSync('scenario','utf8'),count=readFileSync('events','utf8').split('probe\\n').length-1;
if(!existsSync('opened')||scenario==='never-ready'||(scenario==='closed'&&count<2))process.exit(1);
if(scenario==='cancel-preparation'){writeFileSync('cli-pid',String(process.pid));setInterval(()=>{},1000);}else console.log('No sessions.');
`,{mode:0o700});
  await writeFile(join(dir,'config.local.json'),JSON.stringify({ownerUserId:'111111111111111111',guildId:'222222222222222222',channelId:'333333333333333333',applicationId:'444444444444444444',cliPath:cli,asideAccount:'u0',asideModel:'openai-codex/gpt-6-luna',dataDir:join(dir,'data')}));
  await writeFile(join(dir,'open.mjs'),`import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['-g','-j','-b','at.studio.AsideBrowser']))process.exit(2);
appendFileSync('events','open\\n');
if(readFileSync('scenario','utf8')==='open-failed')process.exit(1);
writeFileSync('opened','yes');`);
  const preload=join(dir,'preload.mjs');
  await writeFile(preload,`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
if(process.argv[1]?.endsWith('/typescript/bin/tsc'))process.exit(0);
const original=cp.spawn;
cp.spawn=(file,args,options)=>file==='/usr/bin/open'?original(process.execPath,['open.mjs',...args],options):original(file,args,options);
syncBuiltinESMExports();`);
  const env={...process.env,NODE_OPTIONS:[process.env.NODE_OPTIONS,`--import=${pathToFileURL(preload).href}`].filter(Boolean).join(' ')};
  for(const scenario of ['closed','running','open-failed','never-ready']){
   await writeFile(join(dir,'scenario'),scenario);await writeFile(join(dir,'events'),'');
   await rm(join(dir,'opened'),{force:true});
   if(scenario==='running')await writeFile(join(dir,'opened'),'yes');
   const run=()=>promisify(execFile)('/bin/bash',['scripts/start.command'],{cwd:dir,env,timeout:20_000});
   if(scenario==='closed'||scenario==='running'){
    await run();
    const events=(await readFile(join(dir,'events'),'utf8')).trim().split('\n');
    assert.deepEqual(events.slice(0,-2),scenario==='closed'?['open','probe','probe']:['open','probe']);
    assert.deepEqual(events.slice(-2).sort(),['server','slack']);
   }else{
    await assert.rejects(run(),(error:any)=>error.code===1);
    const events=await readFile(join(dir,'events'),'utf8');assert.ok(!events.includes('server'));
    assert.ok(events.startsWith('open\n'));
    if(scenario==='open-failed')assert.equal(events,'open\n');
    else assert.ok(events.includes('probe\n'));
   }
  }
  await writeFile(join(dir,'scenario'),'cancel-preparation');
  const preparation=spawn(process.execPath,['--import',pathToFileURL(preload).href,'dist/scripts/prepare-bots.js'],{cwd:dir,env,stdio:'ignore'});
  const preparationClosed=new Promise(resolve=>preparation.once('close',(code,signal)=>resolve({code,signal})));
  try{
   const deadline=Date.now()+5000;while(!await readFile(join(dir,'cli-pid'),'utf8').then(()=>true,()=>false)){assert.ok(Date.now()<deadline);await delay(10);}
   const pid=Number(await readFile(join(dir,'cli-pid'),'utf8'));preparation.kill('SIGTERM');
   assert.deepEqual(await preparationClosed,{code:0,signal:null});
   assert.throws(()=>process.kill(pid,0),(e:any)=>e.code==='ESRCH');
  }finally{preparation.kill('SIGTERM');await preparationClosed;const fixturePid=Number(await readFile(join(dir,'cli-pid'),'utf8').catch(()=>'0'));if(fixturePid>0)try{process.kill(fixturePid,'SIGTERM');}catch{}}
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('combined launcher stops both children on interrupt or one bot failure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'aside-bots-'));
 try{
  await mkdir(join(dir,'dist/src/slack'),{recursive:true});
  await copyFile('scripts/start-bots.mjs',join(dir,'launcher.mjs'));
  for(const [file,name] of [['main.js','discord'],['slack/main.js','slack']] as const){
   await writeFile(join(dir,'dist/src',file),`import {appendFileSync,existsSync} from 'node:fs';
appendFileSync('events','${name} ready\\n');
process.on('SIGTERM',()=>{appendFileSync('events','${name} stopped\\n');process.exit(0);});
setInterval(()=>{if('${name}'==='slack'&&existsSync('fail'))process.exit(1);},20);`);
  }
  for(const scenario of ['interrupt','failure']){
   await writeFile(join(dir,'events'),'');
   const child=spawn(process.execPath,['launcher.mjs'],{cwd:dir,stdio:'ignore'});
   const closed=new Promise(resolve=>child.once('close',resolve));
   try{
    const deadline=Date.now()+5000;
    while(!(await readFile(join(dir,'events'),'utf8')).includes('slack ready')||!(await readFile(join(dir,'events'),'utf8')).includes('discord ready')){
     assert.ok(Date.now()<deadline,'both bots must start');await delay(20);
    }
    if(scenario==='interrupt')child.kill('SIGINT');
    else await writeFile(join(dir,'fail'),'');
    assert.equal(await Promise.race([closed,delay(5000).then(()=>{throw Error('launcher did not stop');})]),scenario==='interrupt'?0:1);
    const events=await readFile(join(dir,'events'),'utf8');
    assert.ok(events.includes('discord stopped'));
    if(scenario==='interrupt')assert.ok(events.includes('slack stopped'));
   }finally{child.kill('SIGTERM');await closed;}
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
