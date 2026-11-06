/** The persisted delimiter is also understood by the scanner and older clients. */
export const barcodeAliasKey=(value:string)=>value.normalize("NFKC").trim().toLowerCase();
export function splitProductBarcodes(...values:(string|undefined|null)[]):string[]{
 const aliases=new Map<string,string>();
 for(const value of values)for(const raw of (value??"").split(" / ")){const text=raw.trim();if(text&&!aliases.has(barcodeAliasKey(text)))aliases.set(barcodeAliasKey(text),text);}
 return [...aliases.values()];
}
/** Validate only the new array contract; historical identifier fields are preserved separately. */
export function parseProductBarcodes(value:unknown):string{
 if(!Array.isArray(value)||value.length>20||value.some(v=>typeof v!=="string"))throw new Error("条码请填写最多 20 个文本编号");
 if(value.some(v=>/[\u0000-\u001f\u007f]/.test(v)||v.includes(" / ")))throw new Error("每个条码须为单独编号，不能包含换行或条码分隔符");
 const combined=splitProductBarcodes(...value).join(" / ");
 if(combined.length>500)throw new Error("条码合计长度不能超过 500 个字符");
 return combined;
}
export function productBarcodeOverlap(left:readonly (string|undefined|null)[],right:readonly (string|undefined|null)[]):boolean{
 const valid=(s:string)=>!/^(?:见备注|混装|无|未知|待确认|未填写|N\/?A|-+)$/i.test(s);
 const keys=new Set(splitProductBarcodes(...left).filter(valid).map(barcodeAliasKey));
 return splitProductBarcodes(...right).filter(valid).some(s=>keys.has(barcodeAliasKey(s)));
}
