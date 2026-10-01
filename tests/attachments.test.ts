import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, symlinkSync, writeFileSync, mkdirSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentFiles, validateAttachments, ATTACHMENT_LIMITS } from '../src/attachments.js';
import type { AttachmentRef, AttachmentManifest } from '../src/types.js';
import { Store } from '../src/store.js';

const file:AttachmentRef={id:'22',name:'note.txt',size:3,contentType:'text/plain'};
const manifest=(files=[file],sourceId='11'):AttachmentManifest=>({sourceId,threadId:'33',createdAt:1000,files});
function setup(body:Uint8Array|string='abc', fetcher?:typeof fetch) {
 const dir=mkdtempSync(join(tmpdir(),'aside-attachments-'));
 let reads=0;
 const files=new AttachmentFiles(join(dir,'attachments'),async(_thread,source)=>{reads++;return manifest().files.map(f=>({...f,url:'https://cdn.discordapp.com/attachments/'+source+'/'+f.id}));},fetcher??(async()=>new Response(body as BodyInit)) as typeof fetch);
 return {dir,files,reads:()=>reads,close:()=>rmSync(dir,{recursive:true,force:true})};
}

test('validates count, byte limits and formats without trusting names or MIME',()=>{
 const refs=(n:number)=>Array.from({length:n},(_,i)=>({...file,id:String(i+1)}));
 assert.doesNotThrow(()=>validateAttachments(refs(3)));
 assert.throws(()=>validateAttachments(refs(4)));
 assert.doesNotThrow(()=>validateAttachments([{...file,size:65536}]));
 assert.throws(()=>validateAttachments([{...file,size:65537}]));
 for(const patch of [{size:-1},{size:NaN},{size:10*1024*1024+1},{name:'image.png'},{name:'thing.exe'},{contentType:'image/png'},{id:'../escape'}]) assert.throws(()=>validateAttachments([{...file,...patch}]));
 assert.throws(()=>validateAttachments(refs(3).map(f=>({...f,size:8*1024*1024}))));
 assert.doesNotThrow(()=>validateAttachments([{...file,name:'../../note.txt'}]));
 assert.equal(ATTACHMENT_LIMITS.fileBytes,10*1024*1024);
 assert.equal(ATTACHMENT_LIMITS.totalBytes,20*1024*1024);
});

test('stages private files, safely quotes names and preserves exact prompt limit',async()=>{
 const t=setup();try {
 t.files.stage(manifest());
 const prompt=await t.files.prepare('11','Summarize',new AbortController().signal);
 assert.match(prompt,/abc/);assert.match(prompt,/note.txt/);assert.equal(t.reads(),1);
 assert.equal(statSync(join(t.dir,'attachments/11/22.txt')).mode&0o777,0o600);
 assert.equal(statSync(join(t.dir,'attachments/11')).mode&0o777,0o700);
 assert.throws(()=>t.files.stage(manifest()));
 const m=JSON.parse(readFileSync(join(t.dir,'attachments/11/manifest.json'),'utf8'));
 assert.equal(JSON.stringify(m).includes('https:'),false);
 const base=await t.files.prepare('11','Q',new AbortController().signal);
 assert.equal((await t.files.prepare('11','Q'.repeat(8001-base.length),new AbortController().signal)).length,8000);
 await assert.rejects(t.files.prepare('11','Q'.repeat(8002-base.length),new AbortController().signal));
 } finally {t.close();}
});

test('rejects invalid UTF-8, NUL, oversize streams and failed responses',async()=>{
 for(const [body,response] of [[new Uint8Array([255,255,255]),200],['a\0c',200],['abcd',200],['abc',302],['abc',403]] as const) {
 const t=setup(body,async()=>new Response(body as BodyInit,{status:response,headers:{'content-length':'3'}}));
 try {t.files.stage(manifest());await assert.rejects(t.files.prepare('11','Q',new AbortController().signal));assert.equal(existsSync(join(t.dir,'attachments/11/22.txt')),false);} finally {t.close();}
 }
});

test('rejects unsafe URLs, changed metadata, missing manifests and symlinks',async()=>{
 const t=setup();try {
 for(const url of ['http://cdn.discordapp.com/a','https://cdn.discordapp.com.evil.test/a','https://localhost/a','https://u:p@cdn.discordapp.com/a','https://cdn.discordapp.com:444/a']) {
 let fetched=false;
 const files=new AttachmentFiles(join(t.dir,'attachments'),async()=>[{...file,url}],async()=>{fetched=true;return new Response('abc');});
 if(!existsSync(join(t.dir,'attachments/11')))files.stage(manifest());
 await assert.rejects(files.prepare('11','Q',new AbortController().signal));assert.equal(fetched,false);
 }
 await assert.rejects(t.files.prepare('99','Q',new AbortController().signal));
 const changed=new AttachmentFiles(join(t.dir,'attachments'),async()=>[{...file,size:4,url:'https://cdn.discordapp.com/a'}]);
 await assert.rejects(changed.prepare('11','Q',new AbortController().signal));
 writeFileSync(join(t.dir,'outside'),'KEEP');symlinkSync(join(t.dir,'outside'),join(t.dir,'attachments/11/22.txt'));
 await assert.rejects(t.files.prepare('11','Q',new AbortController().signal));assert.equal(readFileSync(join(t.dir,'outside'),'utf8'),'KEEP');
 } finally {t.close();}
});

test('abort cancels stream and leaves no downloaded payload',async()=>{
 const controller=new AbortController();let cancel=false;
 const t=setup('abc',async()=>new Response(new ReadableStream({pull(){controller.abort();},cancel(){cancel=true;}})));
 try {t.files.stage(manifest());await assert.rejects(t.files.prepare('11','Q',controller.signal));assert.equal(cancel,true);assert.equal(existsSync(join(t.dir,'attachments/11/22.txt')),false);} finally {t.close();}
});

test('retention keeps active/uncertain/stop-requested files and only removes expired owned data',async()=>{
 const t=setup();const store=new Store(join(t.dir,'db'));
 try {
 store.bindThread({threadId:'33',guildId:'g',parentChannelId:'p',ownerUserId:'o'},'origin');
 const states=['completed','failed','cancelled','queued','uncertain','cancel_requested','stop_requested'] as const;
 for(let i=0;i<states.length;i++){
 const source=String(100+i);t.files.stage(manifest([file],source));
 const q=store.enqueue(source,'33','Q',20);assert.equal(q.kind,'queued');if(q.kind!=='queued')throw Error();
 // Create isolated persisted states without Store's global uncertainty admission gate.
 }
 for(let i=0;i<states.length;i++)store.db.prepare('UPDATE requests SET state=?,error_code=? WHERE source_id=?').run(states[i]==='stop_requested'?'cancelled':states[i]!,states[i]==='stop_requested'?'stop_requested':null,String(100+i));
 t.files.stage(manifest([file],'200')); // orphan
 await t.files.prune(store,2000);
 await t.files.prune(store,2000+86400000-1);
 assert.equal(existsSync(join(t.dir,'attachments/100')),true);
 await t.files.prune(store,2000+86400000);
 for(let i=0;i<states.length;i++)assert.equal(existsSync(join(t.dir,'attachments',String(100+i))),i>=3);
 assert.equal(existsSync(join(t.dir,'attachments/200')),false);
 mkdirSync(join(t.dir,'attachments/999'));writeFileSync(join(t.dir,'attachments/999/unknown'),'KEEP');
 symlinkSync(t.dir,join(t.dir,'attachments/998'));
 await t.files.prune(store,1e12);assert.equal(readFileSync(join(t.dir,'attachments/999/unknown'),'utf8'),'KEEP');
 }finally{store.close();t.close();}
});

test('disk ceiling refuses new reservations without deleting existing bytes',()=>{
 const t=setup();try {
 writeFileSync(join(t.dir,'attachments/held'),'');truncateSync(join(t.dir,'attachments/held'),200*1024*1024);
 assert.throws(()=>t.files.stage(manifest()));assert.equal(statSync(join(t.dir,'attachments/held')).size,200*1024*1024);
 }finally{t.close();}
});

test('manifest excludes transport URLs and unrequested fields',()=>{
 const t=setup();try{
 t.files.stage({...manifest(),extra:'secret',files:[{...file,url:'https://cdn.discordapp.com/signed-secret'}]} as unknown as AttachmentManifest);
 const saved=readFileSync(join(t.dir,'attachments/11/manifest.json'),'utf8');
 assert.equal(saved.includes('secret'),false);assert.equal(saved.includes('url'),false);
 }finally{t.close();}
});

test('partial multi-file failure cannot leave a payload or silently omit failed files',async()=>{
 const t=setup();let fetched=0;
 const refs=[file,{...file,id:'23'}];
 const files=new AttachmentFiles(join(t.dir,'attachments'),async()=>refs.map(f=>({...f,url:'https://cdn.discordapp.com/'+f.id})),async()=>{fetched++;return new Response(fetched===1?'abc':'bad!',{status:200});});
 try{files.stage(manifest(refs));await assert.rejects(files.prepare('11','Q',new AbortController().signal));assert.equal(existsSync(join(t.dir,'attachments/11/22.txt')),false);assert.equal(existsSync(join(t.dir,'attachments/11/23.txt')),false);}finally{t.close();}
});

test('rejected HTTP headers cancel the body without consuming unbounded data',async()=>{
 let cancelled=false;
 const t=setup('abc',async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:403}));
 try{t.files.stage(manifest());await assert.rejects(t.files.prepare('11','Q',new AbortController().signal));assert.equal(cancelled,true);}finally{t.close();}
});

test('file timeout is bounded at 30 seconds and whole preparation at 60 seconds',async(context)=>{
 const seen:number[]=[];const controller=new AbortController();let release:ReturnType<typeof setTimeout>|undefined;
 context.mock.method(AbortSignal,'timeout',(ms:number)=>{seen.push(ms);if(ms===30000)release=setTimeout(()=>controller.abort(),1);return controller.signal;});
 const t=setup('abc',async()=>new Response(new ReadableStream({})));
 try{t.files.stage(manifest());await assert.rejects(t.files.prepare('11','Q',new AbortController().signal));assert.deepEqual(seen,[60000,30000]);}finally{clearTimeout(release);t.close();}
});

test('queued reservations include metadata so later downloads cannot exceed the disk ceiling',()=>{
 const t=setup();try{
 const capacity=ATTACHMENT_LIMITS.diskBytes;
 writeFileSync(join(t.dir,'attachments/held'),'');truncateSync(join(t.dir,'attachments/held'),capacity-65536-8192-8192-3);
 t.files.stage(manifest([{...file,size:65536}],'11'));
 // First payload is not downloaded yet; the second reservation fits exactly.
 t.files.stage(manifest([file],'12'));
 assert.throws(()=>t.files.stage(manifest([file],'13')));
 }finally{t.close();}
});
