/** Discord titles are one line; count Unicode code points to avoid splitting surrogate pairs. */
export function normalizeThreadTitle(value:unknown):string|undefined {
  if(typeof value!=='string')return undefined;
  const title=Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u200b\u200e-\u200f\u202a-\u202e\u2060-\u206f]/g,' ').replace(/\s+/g,' ').trim()).slice(0,40).join('');
  return title||undefined;
}
