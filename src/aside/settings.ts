import {isDeepStrictEqual} from 'node:util';
import {ACCOUNT,runAsideCli,replCode,parseReplJson} from './backend.js';
import {PRESET_NAMES,parseSelection,presetName,type ModelSelection,type PresetName} from '../types.js';

type Raw={modelCategories:Record<string,Record<string,unknown>>;defaultModel:unknown};
export class AsideSettings {
  private edits:Promise<unknown>=Promise.resolve();
  constructor(readonly cliPath:string,private exec=(args:string[],timeout:number)=>runAsideCli(cliPath,args,timeout)){}
  private async repl(body:string):Promise<unknown>{
    return parseReplJson(await this.exec(['repl','--account',ACCOUNT,replCode(body)],130000));
  }
  private async read():Promise<Raw>{
    const value=await this.repl("const result={modelCategories:aside.settings.get('modelCategories'),defaultModel:aside.settings.get('defaultModel')};") as Raw;
    if(!value?.modelCategories||typeof value.modelCategories!=='object'||Array.isArray(value.modelCategories))throw new Error('invalid_shared_presets');
    return value;
  }
  async readPreset(name:PresetName):Promise<ModelSelection>{
    return parseSelection((await this.read()).modelCategories[presetName(name)]);
  }
  async readPresets():Promise<Record<PresetName,ModelSelection>>{
    const raw=await this.read();
    return Object.fromEntries(PRESET_NAMES.map(name=>[name,parseSelection(raw.modelCategories[name])])) as Record<PresetName,ModelSelection>;
  }
  async editPreset(name:PresetName,modelId:ModelSelection['modelId'],thinkingLevel:ModelSelection['thinkingLevel']):Promise<ModelSelection>{
    name=presetName(name);parseSelection({provider:'openai-codex',modelId,thinkingLevel});
    const edit=this.edits.catch(()=>{}).then(async()=>{
      const before=await this.read(),original=before.modelCategories[name];
      parseSelection(original);
      const updated={...original,modelId,thinkingLevel};
      const categories={...before.modelCategories,[name]:updated};
      await this.repl(`aside.settings.set('modelCategories',${JSON.stringify(categories)}); const result=true;`);
      const after=await this.read();
      if(!isDeepStrictEqual(after,{...before,modelCategories:categories}))throw new Error('preset_save_unverified');
      return parseSelection(after.modelCategories[name]);
    });
    this.edits=edit;return edit;
  }
}
