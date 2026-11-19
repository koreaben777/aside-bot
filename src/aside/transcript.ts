/** Executed inside the official Aside REPL before serialization. Keep this
 * function self-contained: its emitted JS is embedded in the read command.
 * Preserve ordering and evidence used by ownership/model/turn validation;
 * discard thinking, tool arguments, tool bodies and unrelated metadata. */
export function projectTranscript(value:unknown):unknown {
 const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
 if(!Array.isArray(value))return value;
 return value.map(m=>{
  if(!object(m))return m;
  if(m.role==='turn-lifecycle')return {role:m.role,event:m.event,turnId:m.turnId,timestamp:m.timestamp};
  if(m.role==='assistant')return {role:m.role,provider:m.provider,model:m.model,responseId:m.responseId,stopReason:m.stopReason,timestamp:m.timestamp,
   content:m.stopReason==='stop'&&Array.isArray(m.content)?m.content.filter(c=>object(c)&&c.type==='text').map(c=>({type:c.type,text:c.text,textSignature:c.textSignature})):[]};
  if(m.role==='user')return {role:m.role,timestamp:m.timestamp,content:typeof m.content==='string'?m.content:Array.isArray(m.content)?m.content.map(c=>object(c)?{type:c.type,...(c.type==='text'?{text:c.text}:{})}:c):m.content};
  if(m.role==='toolResult'&&m.toolName==='websearch'&&m.isError===false)return {role:m.role,toolName:m.toolName,isError:m.isError,details:object(m.details)?{sources:Array.isArray(m.details.sources)?m.details.sources.map(s=>object(s)?{id:s.id,title:s.title,url:s.url}:s):m.details.sources}:null};
  return {role:m.role};
 });
}
