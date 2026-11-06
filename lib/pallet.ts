export function parsePalletValue(value:unknown){
 const raw=String(value??"").trim();if(!raw)return 0;
 const mixed=raw.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);if(mixed){const d=Number(mixed[3]);return d?Number(mixed[1])+Number(mixed[2])/d:NaN}
 const fraction=raw.match(/^([+-]?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);if(fraction){const d=Number(fraction[2]);return d?Number(fraction[1])/d:NaN}
 return Number(raw);
}
/** Blank defaults are operation-specific; explicit zero must always survive. */
export function palletCountValue(value:unknown,blankDefault=0):number{
 if(value===undefined||typeof value==='string'&&!value.trim())return blankDefault;
 if(typeof value!=='number'&&typeof value!=='string')return NaN;
 const count=parsePalletValue(value);
 return Number.isFinite(count)&&count>=0&&count<=Number.MAX_SAFE_INTEGER?count:NaN;
}
/** Absorb floating-point addition noise, with a cap that still rejects real over-allocation. */
export function palletCountsEqual(left:number,right:number):boolean{
 return Number.isFinite(left)&&Number.isFinite(right)&&Math.abs(left-right)<=Math.min(1e-9,Number.EPSILON*32*Math.max(Math.abs(left),Math.abs(right)));
}
export const palletCountExceeds=(count:number,available:number)=>count>available&&!palletCountsEqual(count,available);
export const palletRemaining=(available:number,deducted:number)=>palletCountsEqual(available,deducted)?0:Math.max(0,available-deducted);
export function palletLabel(value:number,label?:string):string{
 if(label&&Number.isFinite(parsePalletValue(label)))return label.trim();
 if(!Number.isFinite(value))return "0";const rounded=Math.round(value);if(Math.abs(value-rounded)<1e-8)return String(rounded);
 if(value<0)return `-${palletLabel(-value)}`;
 for(let d=2;d<=12;d++){const n=Math.round(value*d);if(Math.abs(value-n/d)<1e-8){const whole=Math.floor(n/d),rest=n%d;return whole&&rest?`${whole} ${rest}/${d}`:whole?String(whole):`${rest}/${d}`}}
 return String(Number(value.toFixed(3)));
}
