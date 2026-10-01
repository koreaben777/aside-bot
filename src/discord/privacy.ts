const VIEW_CHANNEL=1024n;
export interface ChannelOverwrite {id:string;type:number;allow:string;deny:string}
/** Administrators bypass Discord overwrites; this cannot hide content from them. */
export function assertPrivateChannel(overwrites:readonly ChannelOverwrite[],guildId:string,ownerId:string,botId:string,managedBotRoleIds:ReadonlySet<string>):void {
  const everyone=overwrites.find(x=>x.id===guildId&&x.type===0);
  if(!everyone||!(BigInt(everyone.deny)&VIEW_CHANNEL)) throw new Error('private_channel_required');
  for(const row of overwrites) {
    if(!(BigInt(row.allow)&VIEW_CHANNEL))continue;
    const allowed=row.type===1?(row.id===ownerId||row.id===botId):managedBotRoleIds.has(row.id);
    if(!allowed) throw new Error('unexpected_channel_reader');
  }
}
