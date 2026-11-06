import type {GoodsProductSpec} from './goods-product-spec';
import type {PickCondition} from './goods-operation-input';
import {splitProductBarcodes} from './product-barcodes';
export type GoodsMode='inbound'|'outbound';
export type GoodsReceipt={barcodes?:string[];inboundOrder?:string;note?:string;inboundSource:string;productSpec:GoodsProductSpec;sku:string;fnsku:string;barcode:string;productPrefix:string;productCondition:string};
export type GoodsPlacement={palletCount?:string;note?:string;barcodes?:string[];key:string;locationCode:string;layerCount:string;quantity:string;boxes:string;productPrefix:string;productCondition:string};
export type GoodsPick={quantity:string;boxes:string;pallets?:string};
export type GoodsLineInput={lineId?:string;outboundOrder?:string;stagingTaskId?:string;allowedStockIds?:number[];inventoryUnit:'item'|'box';quantity:string;boxes:string;receipt:GoodsReceipt;placements:GoodsPlacement[];picks:Record<number,GoodsPick>;autoPlacement:boolean;pickCondition:PickCondition};
export type SavedGoodsLine=GoodsLineInput&{choiceKey:string;product:string;customerName?:string};
export type PendingGoodsRequest={path:'/api/goods'|'/api/goods/document'|'/api/goods/staging';body:Record<string,unknown>;kind:'document'|'create'|'staging'};
export type GoodsOperationDraft={version:1;inboundDateAutomatic?:boolean;merchantScope?:string;outboundDate?:string;newBarcodes?:string[];mode:GoodsMode;customer:string;query:string;lines:SavedGoodsLine[];inboundDate:string;inboundOrder:string;note:string;receiptSource:string;creating:boolean;newCustomer:string;newProduct:string;newSku:string;newBarcode:string;newSpec:GoodsProductSpec;pending:PendingGoodsRequest|null};
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const strings=(v:Record<string,unknown>,keys:string[])=>keys.every(k=>typeof v[k]==='string'&&(v[k] as string).length<=16000);
const spec=(v:unknown)=>record(v)&&['item','box'].includes(String(v.billingMode))&&['itemLengthCm','itemWidthCm','itemHeightCm','boxLengthCm','boxWidthCm','boxHeightCm','itemVolumeM3','boxVolumeM3'].every(k=>typeof v[k]==='number'&&Number.isFinite(v[k])&&Number(v[k])>=0);
const pick=(v:unknown)=>record(v)&&strings(v,['quantity','boxes'])&&(v.pallets===undefined||typeof v.pallets==='string'&&v.pallets.length<=16000);
const optionalStrings=(v:Record<string,unknown>,keys:string[])=>keys.every(k=>v[k]===undefined||(typeof v[k]==='string'&&(v[k] as string).length<=16000));
const codeList=(v:unknown)=>v===undefined||(Array.isArray(v)&&v.length<=20&&v.every(code=>typeof code==='string'&&code.length<=16000));
const line=(v:unknown)=>record(v)&&optionalStrings(v,['customerName'])&&strings(v,['choiceKey','product','quantity','boxes'])&&['item','box'].includes(String(v.inventoryUnit))&&typeof v.autoPlacement==='boolean'&&['all','good','damaged','unmarked'].includes(String(v.pickCondition))&&record(v.receipt)&&codeList(v.receipt.barcodes)&&optionalStrings(v.receipt,['inboundOrder','note'])&&strings(v.receipt,['inboundSource','sku','fnsku','barcode','productPrefix','productCondition'])&&spec(v.receipt.productSpec)&&Array.isArray(v.placements)&&v.placements.length<=100&&v.placements.every(p=>record(p)&&optionalStrings(p,['note','palletCount'])&&codeList(p.barcodes)&&strings(p,['key','locationCode','layerCount','quantity','boxes','productPrefix','productCondition']))&&record(v.picks)&&Object.entries(v.picks).every(([id,p])=>/^\d+$/.test(id)&&pick(p));
/** Drafts retain inputs, never an authoritative copy of live inventory. */
export function parseGoodsOperationDraft(raw:string,mode:GoodsMode):GoodsOperationDraft|null{
 try{
  if(raw.length>2000000)return null;
  const v:unknown=JSON.parse(raw);
  if(!record(v)||(v.inboundDateAutomatic!==undefined&&typeof v.inboundDateAutomatic!=='boolean')||v.version!==1||v.mode!==mode||!optionalStrings(v,['outboundDate','merchantScope'])||!codeList(v.newBarcodes)||!strings(v,['customer','query','inboundDate','inboundOrder','note','receiptSource','newCustomer','newProduct','newSku','newBarcode'])||typeof v.creating!=='boolean'||!spec(v.newSpec)||!Array.isArray(v.lines)||v.lines.length>25||!v.lines.every(line))return null;
  if(v.lines.some(l=>!optionalStrings(l,['lineId','outboundOrder','stagingTaskId'])||(l.allowedStockIds!==undefined&&(!Array.isArray(l.allowedStockIds)||l.allowedStockIds.length>10000||l.allowedStockIds.some((id:unknown)=>typeof id!=='number'||!Number.isSafeInteger(id)||id<=0)||new Set(l.allowedStockIds).size!==l.allowedStockIds.length))||(l.lineId!==undefined&&(!l.lineId.trim()||l.lineId.length>200))||(l.outboundOrder!==undefined&&(l.outboundOrder.length>200||/[\r\n\x00-\x1f]/.test(l.outboundOrder)))))return null;
  const ids=v.lines.filter(l=>l.lineId!==undefined).map(l=>l.lineId);
  if(new Set(ids).size!==ids.length)return null;
  if(new Set(v.lines.map(l=>l.choiceKey)).size!==v.lines.length&&(mode!=='outbound'||ids.length!==v.lines.length))return null;
  if(v.pending!==null){const p=v.pending;if(!record(p)||!record(p.body)||typeof p.body.requestId!=='string'||!p.body.requestId||!((p.kind==='document'&&p.path==='/api/goods/document'&&p.body.mode===mode)||(mode==='inbound'&&p.kind==='create'&&p.path==='/api/goods')||(mode==='outbound'&&p.kind==='staging'&&p.path==='/api/goods/staging')))return null;}
  return v as GoodsOperationDraft;
 }catch{return null;}
}
export const goodsDraftKey=(userId:number,mode:GoodsMode)=>`warehouse-goods-draft:v1:${userId}:${mode}`;
/** Materialize legacy inherited fields once; empty placement markers then remain explicitly empty. */
export function explicitGoodsPlacements<T extends GoodsLineInput>(line:T):T{
 return {...line,receipt:{...line.receipt,productPrefix:'',productCondition:'',fnsku:'',barcode:'',barcodes:[]},placements:line.placements.map(p=>({...p,palletCount:p.palletCount??'1',note:p.note??line.receipt.note,productPrefix:p.productPrefix||line.receipt.productPrefix,productCondition:p.productCondition||line.receipt.productCondition,barcodes:p.barcodes??line.receipt.barcodes??splitProductBarcodes(line.receipt.fnsku,line.receipt.barcode)}))};
}
export function nextGoodsPlacement(previous:GoodsPlacement|undefined,key:string):GoodsPlacement{
 return {key,locationCode:'',layerCount:'1',quantity:'0',boxes:'0',palletCount:'1',productPrefix:previous?.productPrefix??'',productCondition:previous?.productCondition??'',barcodes:[]};
}
export function goodsInboundDetailsProblem(line:GoodsLineInput):string{
 if(!['return','domestic','unspecified'].includes(line.receipt.inboundSource))return '请选择入库来源：退货、国内或无';
 if(line.placements.some(p=>!['good','damaged'].includes(p.productCondition)))return '请在 ＋ 库位分配窗口为每个库位选择正品或残次品';
 return '';
}
export function remapGoodsDraftSku(draft:GoodsOperationDraft,previousKey:string,nextKey:string,sku:string):GoodsOperationDraft{
 if(draft.pending)return draft;
 return {...draft,lines:draft.lines.map(line=>line.choiceKey===previousKey?{...line,choiceKey:nextKey,receipt:{...line.receipt,sku}}:line)};
}
export function goodsStockLabel(row:{locationCode:string;layerCount:number;inboundDate:string;inboundOrder?:string}){
 return `${row.locationCode} · 第 ${row.layerCount||1} 层 · 入库 ${row.inboundDate||'日期未填写'}${row.inboundOrder?' · 入库单号 '+row.inboundOrder:''}`;
}
