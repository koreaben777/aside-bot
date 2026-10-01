import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertPrivateChannel} from '../src/discord/privacy.js';

test('private channel rejects extra role/member read grants while accepting only owner and managed bot',()=>{
 const base=[{id:'guild',type:0,allow:'0',deny:'1024'},{id:'bot-role',type:0,allow:'1024',deny:'0'}];
 const roles=new Set(['bot-role']);
 assert.doesNotThrow(()=>assertPrivateChannel(base,'guild','owner','bot',roles));
 assert.throws(()=>assertPrivateChannel([],'guild','owner','bot',roles),/private_channel_required/);
 for(const grant of [{id:'other-role',type:0},{id:'other-user',type:1}])assert.throws(()=>assertPrivateChannel([...base,{...grant,allow:'1024',deny:'0'}],'guild','owner','bot',roles),/unexpected_channel_reader/);
 assert.doesNotThrow(()=>assertPrivateChannel([...base,{id:'owner',type:1,allow:'1024',deny:'0'}],'guild','owner','bot',roles));
});
