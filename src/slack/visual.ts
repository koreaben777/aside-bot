const entities:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
function decode(text:string):string {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(entity:string,key:string)=>{
    if(!key.startsWith('#'))return entities[key.toLowerCase()]??entity;
    const value=key[1]?.toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1));
    return value>0&&value<=0x10ffff&&!(value>=0xd800&&value<=0xdfff)?String.fromCodePoint(value):entity;
  });
}
function staticText(html:string):string {
  html=html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi,(_tag,attributes:string,body:string)=>{
    const href=/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
    try{
      const url=new URL(decode(href?.[1]??href?.[2]??href?.[3]??''));
      if(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password)return body+' ('+url.href+')';
    }catch{/* Keep the label when a link cannot be used safely. */}
    return body;
  });
  const text=html.replace(/<br\b[^>]*>/gi,'\n').replace(/<\/(?:p|div|h[1-6]|li|section|article|tr)\s*>/gi,'\n\n')
    .replace(/<(?!\/?citation\b)[^>]*>/gi,'').replace(/[\t\r ]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  // Citation attributes are consumed by the existing source mapper, not Markdown.
  return text.split(/((?:<|&lt;|&amp;lt;)\/?citation(?=[\s>]|&(?:amp;)?gt;)[^<>]*?(?:>|&gt;|&amp;gt;))/gi)
    .map((part,i)=>i%2?part:decode(part).replace(/[\\`*_[\]~|]/g,'\\$&').replaceAll('<','&lt;').replaceAll('>','&gt;')).join('');
}

function visualText(html:string):string {
  // shortcut: static HTML text only; use a separate renderer if interactive visuals are needed.
  html=html.replace(/<!--[\s\S]*?(?:-->|$)/g,'').replace(/<(head|style|script)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,'');
  const tables:string[]=[];
  html=html.replace(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi,(_table,content:string)=>{
    let headers:string[]=[];const rows:string[]=[];
    for(const row of content.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)){
      const cells=[...row[1]!.matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)];
      if(!cells.length)continue;
      const values=cells.map(cell=>staticText(cell[3]!).replace(/\n+/g,' / '));
      if(!headers.length&&cells.every(cell=>cell[1]!.toLowerCase()==='th')){headers=values;continue;}
      if(!headers.length||values.length<2){rows.push(values.join(' / '));continue;}
      let column=1;
      rows.push('**'+values[0]+'**\n'+values.slice(1).map((value,i)=>{
        const span=/\bcolspan\s*=\s*["']?(\d+)/i.exec(cells[i+1]![2]!);
        const width=Math.max(1,Math.min(headers.length,Number(span?.[1]??1)));
        const title=headers.slice(column,column+width).join(' / ');column+=width;
        return '- '+(title?title+': ':'')+value;
      }).join('\n'));
    }
    tables.push(rows.join('\n\n')||headers.join(' / '));
    return `\n\n\u0000TABLE${tables.length-1}\u0000\n\n`;
  });
  return staticText(html).replace(/\u0000TABLE(\d+)\u0000/g,(_token,index:string)=>tables[Number(index)]??'')
    ||'(시각 자료에 표시할 텍스트가 없습니다.)';
}

/** Convert app-only visual fences before Markdown splitting; ordinary code stays literal. */
export function slackVisualFallback(text:string):string {
  const fences=/^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n/gm;
  let at=0,result='';
  for(let open=fences.exec(text);open;open=fences.exec(text)){
    const close=new RegExp('^ {0,3}'+open[1]![0]+'{'+open[1]!.length+',}[ \\t]*\\r?$','gm');
    close.lastIndex=fences.lastIndex;const end=close.exec(text),after=end?end.index+end[0].length:text.length;
    result+=text.slice(at,open.index);
    result+=open[2]!.trim().toLowerCase()==='visual'?visualText(text.slice(fences.lastIndex,end?.index??text.length)):text.slice(open.index,after);
    at=after;fences.lastIndex=after;
  }
  return result+text.slice(at);
}
