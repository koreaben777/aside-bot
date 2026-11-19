interface SocketClient {
 start():Promise<unknown>;
 disconnect():Promise<void>;
 websocket?:{isActive():boolean};
 on(event:string,listener:()=>void):unknown;
 off(event:string,listener:()=>void):unknown;
}
type State='connected'|'reconnecting'|'error';
const permanent=(error:unknown)=>{
 const code=(error as {data?:{error?:unknown}}|null)?.data?.error;
 return ['not_authed','invalid_auth','account_inactive','user_removed_from_team','team_disabled','missing_scope'].includes(String(code));
};

/** Own reconnects with SDK autoReconnectEnabled=false. Only connection setup
 * is retried; messages and agent submissions never pass through this loop. */
export class SlackConnection {
 private readonly abort=new AbortController();
 private stopped=false;
 private failed=false;
 private ready=false;
 private loop:Promise<void>|undefined;
 private disconnecting:Promise<void>|undefined;
 private resolveFirst!:()=>void;
 private rejectFirst!:(error:Error)=>void;
 private readonly first=new Promise<void>((resolve,reject)=>{this.resolveFirst=resolve;this.rejectFirst=reject;});
 private readonly connected=()=>{if(!this.stopped&&!this.failed){this.ready=true;this.report('connected');}};
 private readonly closed=()=>{if(!this.client.websocket?.isActive())this.lost();};
 private readonly disconnected=()=>this.lost();
 private readonly errored=()=>{if(!this.client.websocket?.isActive())this.lost();};
 constructor(private readonly client:SocketClient,private readonly report:(state:State)=>void){
  void this.first.catch(()=>{});
  client.on('connected',this.connected);client.on('close',this.closed);client.on('disconnected',this.disconnected);client.on('error',this.errored);
 }
 isConnected():boolean {return !this.stopped&&!this.failed&&this.ready&&(this.client.websocket?.isActive()??true);}
 private lost():void {this.ready=false;if(!this.stopped&&!this.failed)this.report('reconnecting');}
 start():Promise<void>{this.loop??=this.run();return this.first;}
 private disconnect():Promise<void>{
  if(this.disconnecting)return this.disconnecting;
  const task=Promise.resolve().then(()=>this.client.disconnect());this.disconnecting=task;
  void task.then(()=>{if(this.disconnecting===task)this.disconnecting=undefined;},()=>{if(this.disconnecting===task)this.disconnecting=undefined;});
  return task;
 }
 private pause(ms:number):Promise<void>{
  const signal=this.abort.signal;
  return new Promise((resolve,reject)=>{
   signal.throwIfAborted();
   const abort=()=>{clearTimeout(timer);reject(signal.reason);};
   const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
   signal.addEventListener('abort',abort,{once:true});
  });
 }
 private async run():Promise<void>{
  let failures=0;
  try{
   while(!this.stopped){
    let retryAfter=0;
    this.lost();
    // The SDK bounds HTTP discovery at 30s; also bound a missing WebSocket hello.
    const timeout=setTimeout(()=>{this.lost();void this.disconnect().catch(()=>{});},60_000);timeout.unref();
    try{await this.client.start();}
    catch(error){
     if(permanent(error)){this.failed=true;this.report('error');this.rejectFirst(Error('platform_unavailable'));break;}
     const limited=error as {code?:string;retryAfter?:number};
     if(limited?.code==='slack_webapi_rate_limited_error'&&Number.isFinite(limited.retryAfter)&&limited.retryAfter!>0)retryAfter=Math.min(2_147_483_647,limited.retryAfter!*1000);
     failures++;
    }
    finally{clearTimeout(timeout);}
    if(this.stopped)break;
    if(this.isConnected()){
     failures=0;let lastTick=Date.now();this.resolveFirst();
     while(!this.stopped&&this.isConnected()){
      await this.pause(1000);
      const now=Date.now();
      // A sleep/resume gap invalidates a stale open socket, even without close.
      if(now-lastTick>30_000){this.lost();break;}
      lastTick=now;
     }
    }
    this.lost();await this.disconnect();
    if(!this.stopped)await this.pause(Math.max(retryAfter,Math.min(60_000,5000*2**Math.min(Math.max(0,failures-1),4))));
   }
  }catch{
   if(!this.stopped){this.failed=true;this.report('error');this.rejectFirst(Error('platform_unavailable'));}
  }finally{
   this.ready=false;await this.disconnect().catch(()=>{});
  }
 }
 async close():Promise<void>{
  this.stopped=true;this.ready=false;this.rejectFirst(Error('shutdown_pending'));this.abort.abort();
  // Close now to settle a waiting hello; wait for late HTTP discovery, then close
  // again so startup cannot create a socket after shutdown has finished.
  await this.disconnect().catch(()=>{});await this.loop;await this.disconnect().catch(()=>{});
  this.client.off('connected',this.connected);this.client.off('close',this.closed);this.client.off('disconnected',this.disconnected);this.client.off('error',this.errored);
 }
}
