/** Split without changing text. Count UTF-16 units to stay below Discord's limit,
 * while keeping surrogate pairs intact and preferring nearby whitespace. */
export function splitOutput(text:string,limit=1900):string[] {
  if(!Number.isInteger(limit) || limit<2 || limit>1900) throw new RangeError('invalid output limit');
  if(!text) return ['(답변 내용이 없습니다.)'];
  const chars=Array.from(text);
  const parts:string[]=[];
  let at=0;
  while(at<chars.length) {
    let end=at,units=0;
    while(end<chars.length && units+chars[end]!.length<=limit) {
      units+=chars[end]!.length;
      end++;
    }
    if(end===at) throw new RangeError('character exceeds output limit');
    if(end<chars.length) {
      for(let i=end-1;i>at;i--) {
        if((chars[i]==='\n' || chars[i]===' ') && chars.slice(at,i+1).join('').length>limit/2) {end=i+1;break;}
      }
    }
    parts.push(chars.slice(at,end).join(''));
    at=end;
  }
  return parts;
}
