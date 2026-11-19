import {splitOutput} from '../core/split.js';

/** Each message is parsed independently by Slack. Keep Markdown spans together,
 * and reopen long code/emphasis spans in each message. Discord splitting is unchanged. */
export function splitSlackMarkdown(text:string):string[] {
  const limit=1900,parts:string[]=[];let current='';
  const flush=()=>{if(current){parts.push(current);current='';}};
  const prose=(value:string)=>{
    while(value){
      const room=limit-current.length;
      if(value.length<=room){current+=value;break;}
      if(room<2){flush();continue;}
      const piece=splitOutput(value,room)[0]!;
      current+=piece;value=value.slice(piece.length);flush();
    }
  };
  const atomic=(value:string)=>{if(current.length+value.length>limit)flush();current+=value;};
  const framed=(content:string,open:string,close:string,emphasis=false)=>{
    const budget=limit-open.length-close.length;
    if(budget<2){prose(open+content+close);return;}
    for(const piece of splitOutput(content,budget)){
      if(emphasis){
        const leading=/^\s*/.exec(piece)![0],trailing=/\s*$/.exec(piece)![0];
        const body=piece.slice(leading.length,piece.length-trailing.length);
        atomic(body?leading+open+body+close+trailing:piece);
      }else atomic(open+piece+close);
    }
  };
  // Treat fences, inline code, links, emphasis and ordinary pipe tables as units.
  const tokens=/(`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?\r?\n\1|(`+)[\s\S]*?\2|!?\[[^\]\r\n]*\]\([^\)\r\n]*\)|(\*{1,3}|_{1,3}|~~)(?=\S)[\s\S]*?\S\3|^[ \t]*\|[^\r\n]*\r?\n[ \t]*\|(?:[ :\-]+\|)+[ \t]*\r?\n(?:[ \t]*\|[^\r\n]*(?:\r?\n|$))+/gm;
  let at=0;
  for(const match of text.matchAll(tokens)){
    prose(text.slice(at,match.index));const token=match[0];at=match.index+token.length;
    if(token.length<=limit){atomic(token);continue;}
    const fence=/^(`{3,}|~{3,})([^\r\n]*)\r?\n([\s\S]*?)\r?\n\1$/.exec(token);
    if(fence){framed(fence[3]!,fence[1]!+fence[2]!+'\n','\n'+fence[1]);continue;}
    const delimiter=match[2]??match[3];
    if(delimiter){framed(token.slice(delimiter.length,-delimiter.length),delimiter,delimiter,!!match[3]);continue;}
    const link=/^(!?\[)([^\]]*)\](\([^\r\n]*\))$/.exec(token);
    if(link&&limit-link[1]!.length-link[3]!.length-1>=2){framed(link[2]!,link[1]!,']'+link[3]);continue;}
    // An oversized table or URL cannot remain one unit; preserve it as literal code.
    const fenceSize=Math.max(3,...[...token.matchAll(/`+/g)].map(run=>run[0].length+1));
    const literalFence='`'.repeat(fenceSize);
    framed(token,literalFence+'\n','\n'+literalFence);
  }
  prose(text.slice(at));flush();
  return parts;
}
