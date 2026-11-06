import {stockProductDetails, type StockProduct} from "./stock-product";
const clean=(s:string)=>s.normalize("NFKC").trim().replace(/\s+/g," ");
const tokens=(s:string)=>[...s.matchAll(/[\p{Script=Han}]|[\p{L}\p{N}]+|[^\p{L}\p{N}\s]/gu)].map(m=>({text:m[0],start:m.index!,end:m.index!+m[0].length}));

/** Suggest the longest shared phrase, respecting whole English/model tokens (AB is not B). */
export function commonMatchedProduct(products:readonly string[]) {
  const names=[...new Set(products.map(s=>stockProductDetails({product:s}).name).filter(Boolean))];
  if(!names.length)return "";if(names.length===1)return names[0];
  const first=tokens(names[0]);let shared=first.map((_,i)=>i+1);
  for(const name of names.slice(1)) {
    const other=tokens(name),best=new Array(first.length).fill(0);let previous=new Array(other.length+1).fill(0);
    for(let i=0;i<first.length;i++) {const next=new Array(other.length+1).fill(0);for(let j=0;j<other.length;j++)if(first[i].text.toLowerCase()===other[j].text.toLowerCase()){next[j+1]=previous[j]+1;best[i]=Math.max(best[i],next[j+1])}previous=next;}
    shared=shared.map((n,i)=>Math.min(n,best[i]));
  }
  let value="";
  shared.forEach((length,end)=>{if(length){const candidate=names[0].slice(first[end-length+1].start,first[end].end).trim();if(candidate.length>value.length)value=candidate}});
  // Keep colour words intact in the marker rather than leaving a meaningless leading 色 in the product.
  if(value.startsWith("色")&&names.every(n=>/[黄绿红蓝黑白粉紫灰橙棕银金]$/.test(n.slice(0,n.indexOf(value)).trim())))value=value.slice(1).trim();
  value=value.replace(/^[\s·:：,，/\-()（）]+|[\s·:：,，/\-()（）]+$/g,"");
  return value.length>=2&&!/^[\p{N}\p{P}\p{S}\s]+$/u.test(value)?value:"";
}

/** Preserve all nonshared text and existing marks; the original stock itself is never rewritten. */
export function matchedProductParts(stock:StockProduct, product:string) {
  const details=stockProductDetails(stock),name=clean(product),source=tokens(details.name),target=tokens(name);
  let start=-1,end=-1;
  for(let i=0;target.length&&i+target.length<=source.length;i++)if(target.every((t,j)=>t.text.toLowerCase()===source[i+j].text.toLowerCase())){start=source[i].start;end=source[i+target.length-1].end;break;}
  const trim=(s:string)=>s.trim().replace(/^[\s·:：,，/\-()（）]+|[\s·:：,，/\-()（）]+$/g,"");
  const extra=start<0?details.name:[trim(details.name.slice(0,start)),trim(details.name.slice(end))].filter(Boolean).join(" · ");
  const prefix=[...new Set([details.prefix,extra].filter(Boolean))].join(" · ");
  return {name:name||details.name,prefix,condition:details.condition,label:[details.condition==="damaged"?"残次品":details.condition==="good"?"正品":"",prefix].filter(Boolean).join(" · ")};
}
