import {volumeFromCm} from "./pricing";

export type GoodsProductSpec={billingMode:"item"|"box";itemLengthCm:number;itemWidthCm:number;itemHeightCm:number;boxLengthCm:number;boxWidthCm:number;boxHeightCm:number;itemVolumeM3:number;boxVolumeM3:number};
const fields=["itemLengthCm","itemWidthCm","itemHeightCm","boxLengthCm","boxWidthCm","boxHeightCm"] as const;
export const emptyGoodsProductSpec=():GoodsProductSpec=>({billingMode:"item",itemLengthCm:0,itemWidthCm:0,itemHeightCm:0,boxLengthCm:0,boxWidthCm:0,boxHeightCm:0,itemVolumeM3:0,boxVolumeM3:0});
/** Product data contains measurements only. Monetary rules belong to warehouse pricing. */
export function parseGoodsProductSpec(raw:unknown,requireVolume=false):GoodsProductSpec{
 if(!raw||typeof raw!=="object")throw new Error("请填写产品尺寸");
 const input=raw as Record<string,unknown>,spec=emptyGoodsProductSpec();
 if(!["item","box"].includes(String(input.billingMode)))throw new Error("请选择产品的体积单位");spec.billingMode=input.billingMode as "item"|"box";
 for(const field of fields){const v=input[field]??0;if((typeof v!=="number"&&typeof v!=="string")||String(v).trim()===""||!Number.isFinite(Number(v))||Number(v)<0||Number(v)>100000)throw new Error("产品尺寸必须是有效的非负数");spec[field]=Number(v);}
 for(const unit of ["item","box"] as const){const values=[spec[`${unit}LengthCm`],spec[`${unit}WidthCm`],spec[`${unit}HeightCm`]];if(values.some(v=>v>0)&&!values.every(v=>v>0))throw new Error("请完整填写产品的长、宽、高");const calculated=volumeFromCm(...values as [number,number,number]);const v=input[`${unit}VolumeM3`]??0;if((typeof v!=="number"&&typeof v!=="string")||String(v).trim()===""||!Number.isFinite(Number(v))||Number(v)<0||Number(v)>1e9)throw new Error("产品体积无效");spec[`${unit}VolumeM3`]=values.every(v=>v>0)?calculated:Number(v);}
 if(requireVolume&&!(spec[`${spec.billingMode}VolumeM3`]>0))throw new Error("请填写有效的产品体积，或完整填写长、宽、高自动计算");
 return spec;
}
export function goodsProductSpec(rows:readonly {updatedAt:string;billingMode:string;itemVolumeM3:number;boxVolumeM3:number}[],stored?:GoodsProductSpec):GoodsProductSpec{
 const spec={...(stored??emptyGoodsProductSpec())};
 // Independently saved product measurements describe future receipts. Old physical
 // rows remain the evidence for their original cost lots and cannot overwrite them.
 if(stored&&goodsProductVolume(stored)>0)return spec;
 const latest=rows.slice().sort((a,b)=>String(b.updatedAt||"").localeCompare(String(a.updatedAt||"")))[0];
 if(!latest)return spec;
 spec.billingMode=latest.billingMode==='box'?'box':'item';
 for(const unit of ["item","box"] as const){const volume=latest[`${unit}VolumeM3`];if(volume>0){if(Math.abs(spec[`${unit}VolumeM3`]-volume)>1e-8){spec[`${unit}LengthCm`]=0;spec[`${unit}WidthCm`]=0;spec[`${unit}HeightCm`]=0;}spec[`${unit}VolumeM3`]=volume;}}
 return spec;
}
export const goodsProductVolume=(spec:GoodsProductSpec)=>spec.billingMode==='box'?spec.boxVolumeM3:spec.itemVolumeM3;
