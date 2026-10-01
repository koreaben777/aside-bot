import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {AsideSettings} from '../src/aside/settings.js';

const categories={fast:{provider:'openai-codex',modelId:'gpt-6-luna',thinkingLevel:'max',fastMode:true,keep:'extra'},standard:{provider:'openai-codex',modelId:'gpt-5.6-sol',thinkingLevel:'medium',fastMode:false},deep:{provider:'openai-codex',modelId:'gpt-6-sol',thinkingLevel:'xhigh',fastMode:false},visual:{provider:'openai-codex',modelId:'gpt-6-sol',thinkingLevel:'high',fastMode:false}};
async function settingsFixture(onSave?:(value:unknown)=>unknown){
 const values:Record<string,unknown>={modelCategories:structuredClone(categories),defaultModel:{provider:'openai-codex',modelId:'gpt-6-astra'}};
 const writes:string[]=[],calls:string[][]=[];
 const settings=new AsideSettings('/test/aside',async(args:string[])=>{
  calls.push(args);const output:string[]=[];
  runInNewContext(args.at(-1)!,{aside:{settings:{get:(key:string)=>structuredClone(values[key]),set:(key:string,value:unknown)=>{writes.push(key);values[key]=structuredClone(onSave?onSave(value):value);}}},console:{log:(text:string)=>output.push(text)}});
  return output.join('\n');
 });
 return {settings,values,writes,calls};
}

test('shared preset edits preserve speed, extra attributes, other presets and app default',async()=>{
 const t=await settingsFixture(),before=structuredClone(t.values);
 const result=await t.settings.editPreset('fast','gpt-6-sol','high');
 assert.equal(result.modelId,'gpt-6-sol');assert.equal(result.thinkingLevel,'high');assert.equal(result.fastMode,true);
 const expected=structuredClone(before) as {modelCategories:typeof categories};
 expected.modelCategories.fast.modelId='gpt-6-sol';expected.modelCategories.fast.thinkingLevel='high';
 assert.deepEqual(t.values,expected);assert.deepEqual(t.writes,['modelCategories']);
 assert.ok(t.calls.every(args=>args[0]==='repl'&&args[2]==='u0'));
});

test('edits serialize and never report success after a mismatching save',async()=>{
 const t=await settingsFixture();
 await Promise.all([t.settings.editPreset('fast','gpt-6-sol','low'),t.settings.editPreset('deep','gpt-5.6-sol','max')]);
 assert.equal((t.values.modelCategories as typeof categories).fast.thinkingLevel,'low');assert.equal((t.values.modelCategories as typeof categories).deep.thinkingLevel,'max');
 const rejected=await settingsFixture(()=>categories);
 await assert.rejects(rejected.settings.editPreset('fast','gpt-6-sol','low'),/preset_save_unverified/);
 assert.equal(rejected.writes.length,1);
});

test('shared definitions reject unsupported models, ultrabrowse and invalid categories before writing',async()=>{
 const t=await settingsFixture();
 for(const [name,model,effort] of [['visual','gpt-6-sol','high'],['fast','gpt-6-astra','high'],['fast','gpt-6-luna','ultrabrowse']])await assert.rejects(Reflect.apply(t.settings.editPreset,t.settings,[name,model,effort]));
 assert.equal(t.writes.length,0);
 (t.values.modelCategories as typeof categories).standard.modelId='unsupported';
 await assert.rejects(t.settings.readPreset('standard'));
 assert.equal((await t.settings.readPreset('fast')).modelId,'gpt-6-luna');
});
