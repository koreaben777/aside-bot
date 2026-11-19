import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter,once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {SocketModeClient,LogLevel} from '@slack/socket-mode';
import {WebSocketServer} from 'ws';
import {SlackConnection} from '../src/slack/connection.js';

async function settle(){for(let i=0;i<20;i++)await Promise.resolve();}
class SocketProbe extends EventEmitter {
 active=false;starts=0;
 websocket={isActive:()=>this.active};
 async start(){this.starts++;this.active=true;this.emit('connected');return {};}
 async disconnect(){this.active=false;this.emit('close');this.emit('disconnected');}
}

test('sleep resume resets a stale open Slack socket before allowing new requests',async context=>{
 context.mock.timers.enable({apis:['setTimeout','Date'],now:100_000});
 const client=new SocketProbe(),states:string[]=[];
 const recovery=new SlackConnection(client,state=>states.push(state));
 try{
  await recovery.start();await settle();assert.equal(recovery.isConnected(),true);
  context.mock.timers.tick(60_000);await settle();
  assert.equal(recovery.isConnected(),false);assert.equal(states.at(-1),'reconnecting');
  context.mock.timers.tick(5000);await settle();
  assert.equal(recovery.isConnected(),true);assert.equal(client.starts,2);
 }finally{await recovery.close();}
});

test('permanent authentication failure stays visible and is not retried',async context=>{
 context.mock.timers.enable({apis:['setTimeout','Date'],now:100_000});
 const client=new SocketProbe(),states:string[]=[];
 client.start=async()=>{client.starts++;throw Object.assign(Error('private error'),{data:{error:'invalid_auth'}});};
 const recovery=new SlackConnection(client,state=>states.push(state));
 try{
  await assert.rejects(recovery.start(),/platform_unavailable/);await settle();
  context.mock.timers.tick(120_000);await settle();
  assert.equal(client.starts,1);assert.equal(states.at(-1),'error');assert.equal(recovery.isConnected(),false);
 }finally{await recovery.close();}
});

test('shutdown during HTTP discovery waits for late startup and closes its socket without retry',async()=>{
 const client=new SocketProbe();let release!:()=>void;
 client.start=async()=>{client.starts++;await new Promise<void>(resolve=>{release=resolve;});client.active=true;client.emit('connected');return {};};
 const recovery=new SlackConnection(client,()=>{});void recovery.start().catch(()=>{});
 await settle();let closed=false;const closing=recovery.close().then(()=>{closed=true;});await settle();
 assert.equal(closed,false);release();await closing;
 assert.equal(client.active,false);assert.equal(client.starts,1);assert.equal(recovery.isConnected(),false);
});

test('rate-limit retry respects Retry-After and shutdown cancels the delay',async context=>{
 context.mock.timers.enable({apis:['setTimeout','Date'],now:100_000});
 const client=new SocketProbe();
 client.start=async()=>{client.starts++;throw Object.assign(Error('rate limited'),{code:'slack_webapi_rate_limited_error',retryAfter:3600});};
 const recovery=new SlackConnection(client,()=>{});void recovery.start().catch(()=>{});
 await settle();context.mock.timers.tick(60_000);await settle();assert.equal(client.starts,1);
 await recovery.close();context.mock.timers.tick(3600_000);await settle();assert.equal(client.starts,1);
});

test('installed SDK rate limiting leaves retry waiting cancellable by the connection owner',async()=>{
 let attempts=0;
 const logger={getLevel:()=>LogLevel.ERROR,setLevel:()=>{},setName:()=>{},debug:()=>{},info:()=>{},warn:()=>{},error:()=>{}};
 const sdk=new SocketModeClient({appToken:'synthetic-test-token',autoReconnectEnabled:false,logger,clientOptions:{retryConfig:{retries:0},timeout:1000,rejectRateLimitedCalls:true,fetch:async()=>{
  attempts++;return new Response('{}',{status:429,headers:{'Retry-After':'3600'}});
 }}});
 const recovery=new SlackConnection(sdk,()=>{});void recovery.start().catch(()=>{});
 try{
  for(let n=0;n<100&&attempts===0;n++)await delay(10);
  assert.equal(attempts,1);await delay(20);
  let deadline:NodeJS.Timeout|undefined;
  try{await Promise.race([recovery.close(),new Promise<never>((_resolve,reject)=>{deadline=setTimeout(()=>reject(Error('shutdown exceeded bound')),1000);})]);}
  finally{clearTimeout(deadline);}
  assert.equal(attempts,1);assert.equal(recovery.isConnected(),false);
 }finally{await recovery.close();}
});

test('installed Slack SDK reconnects after WebSocket loss and a failed HTTP discovery',async()=>{
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
 const address=server.address();assert.ok(address&&typeof address==='object');
 let offline=false,attempts=0;
 server.on('connection',socket=>socket.send(JSON.stringify({type:'hello'})));
 const logger={getLevel:()=>LogLevel.ERROR,setLevel:()=>{},setName:()=>{},debug:()=>{},info:()=>{},warn:()=>{},error:()=>{}};
 const sdk=new SocketModeClient({appToken:'synthetic-test-token',autoReconnectEnabled:false,logger,clientOptions:{retryConfig:{retries:0},timeout:1000,fetch:async url=>{
  assert.ok(String(url).endsWith('/apps.connections.open'));attempts++;if(offline)throw Error('simulated network loss');
  return new Response(JSON.stringify({ok:true,url:`ws://127.0.0.1:${address.port}/`}),{headers:{'Content-Type':'application/json'}});
 }}});
 const recovery=new SlackConnection(sdk,()=>{});
 const until=async(check:()=>boolean)=>{for(let n=0;n<800;n++){if(check())return;await delay(20);}assert.fail('SDK recovery timed out');};
 try{
  await recovery.start();assert.equal(recovery.isConnected(),true);
  offline=true;for(const socket of server.clients)socket.terminate();
  await until(()=>attempts>=2);assert.equal(recovery.isConnected(),false);
  offline=false;await until(()=>recovery.isConnected());assert.ok(attempts>=3);
 }finally{await recovery.close();for(const socket of server.clients)socket.terminate();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
