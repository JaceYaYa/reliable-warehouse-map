import {parseInboundMessage,type MessageReferenceStock} from './inbound-message';
import {stockProductDetails} from './stock-product';
import {emptyGoodsProductSpec} from './goods-product-spec';
import {exactOperationMatches,operationChoices,matchesPickCondition} from './goods-operation-input';
import type {GoodsChoice} from './goods-flow';
import type {GoodsLineInput,GoodsMode} from './goods-operation-draft';
export type MessageGoodsRow={palletCount?:string;key:string;product:string;customerName:string;sku:string;barcodes:string[];quantity:number;boxes:number;locationCode:string;layerCount:number;productCondition:string;productPrefix:string;inboundSource:string;inboundOrder:string;note:string;warnings:string[];choiceKey:string;referenceIds:number[]};
export type MessageGoodsImport={id:string;mode:GoodsMode;date:string;rows:Array<Pick<MessageGoodsRow,'choiceKey'|'quantity'|'boxes'|'locationCode'|'layerCount'|'productCondition'|'productPrefix'|'inboundSource'|'inboundOrder'|'note'|'barcodes'|'palletCount'>>};
const compact=(v:string)=>v.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
export function recognizeGoodsMessage(text:string,{locations,stocks,date,mode}:{locations:readonly string[];stocks:readonly MessageReferenceStock[];date:string;mode:GoodsMode}){
 const normalized=text.normalize('NFKC'),transfer=/(?:移到|移至|移往|移动到|转到|移库|搬到|搬至|转移)|[→⇒]|[A-Za-z]\d+[^\n]*->[^\n]*[A-Za-z]\d+/u.test(normalized),transferText=normalized.split('\n').find(line=>/(?:移到|移至|移往|移动到|转到|移库|搬到|搬至|转移)|[→⇒]|[A-Za-z]\d+.*->.*[A-Za-z]\d+/.test(line))??'';
 const transferDestination=transferText.match(/(?:移到|移至|移往|移动到|转到)\s*((?:新)?[A-Za-z]\s*\d+(?:通道)?)\s*(?:第)?(\d+|[一二两三四五六七八九十]+)?\s*层?/);
 const destination=transferDestination?.[1]?.replace(/\s/g,'')??'',layers:Record<string,number>={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
 const layer=transferDestination?.[2]?(layers[transferDestination[2]]??Number(transferDestination[2])):1;
 const prepared=normalized.split('\n').flatMap(line=>{
  if(/(?:移到|移至|移往|移动到|转到|移库|搬到|搬至|转移)|[→⇒]|[A-Za-z]\d+.*->.*[A-Za-z]\d+|^\d{1,2}[/-]\d{1,2}.*清点/.test(line))return [];
  const direct=line.match(/^(.*?)\s*(?:出库|入库|收货)\s*[:：]?\s*(\d+.*(?:件|个|只|套|台|箱).*)$/);
  if(direct&&direct[1].trim()&&!/^FBA|^IB/i.test(direct[1].trim())){
   const customer=stocks.find(s=>compact(s.customerName)===compact(direct[1]));
   return [customer?'客户：'+customer.customerName:'产品：'+direct[1].trim(),direct[2]];
  }
  return [line.replace(/^出库清点\s*[:：]?$/,'入库清点').replace(/^(出库单号|出库单)\s*[:：]/,'入库单号：')];
 }).join('\n');
 const result=parseInboundMessage(prepared,{locations,stocks,inboundDate:date});
 const explicit=parseInboundMessage(prepared,{locations,stocks:[],inboundDate:date});
 const globalPosition=prepared.split('\n').filter(line=>/^(?:放在|位于|库位|位置|存放)/.test(line));
 const lastPosition=result.items.at(-1);
 const sourceKinds=[/退货|退件/.test(normalized)?'return':'',/国内/.test(normalized)?'domestic':'',/(?:来源|状态)\s*[:：]\s*无/.test(normalized)?'unspecified':''].filter(Boolean);
 const source=sourceKinds.length===1?sourceKinds[0]:'';
 const rows:MessageGoodsRow[]=result.items.map((item,index)=>{
  const raw=item.rawProduct.replace(/无卡|没卡|不带卡|有卡|带卡/g,'').replace(/^[!！·\-—:：\s]+/,'').trim(),codes=[item.messageIdentifiers?.fnsku,item.messageIdentifiers?.barcode].filter((s):s is string=>!!s),condition=/残次|不良|次品/.test(item.condition)?'damaged':/新品|良品|正品/.test(item.condition)?'good':'';
  let warnings=item.warnings.filter(w=>!/托盘|0托|未匹配库位|未写件数|条形码与 FNSKU/.test(w));
  const line=item.draft.note.match(/\d+\s*箱\s*[xX×*]\s*\d+\s*(?:个|件|只|套|台)(?:\s*\+\s*\d+\s*(?:个|件|只|套|台))+/)?.[0];
  if(line){const pack=line.match(/(\d+)\s*箱\s*[xX×*]\s*(\d+)/)!,loose=[...line.matchAll(/\+\s*(\d+)\s*(?:个|件|只|套|台)/g)].reduce((sum,m)=>sum+Number(m[1]),0);if(Number(pack[1])*Number(pack[2])+loose===item.draft.totalQuantity)warnings=warnings.filter(w=>!/总件数.*不一致/.test(w));}
  if(sourceKinds.length>1)warnings.push('消息包含不同来源，请分别为每条货物核对来源');
  let code=item.draft.locationCode,layerCount=item.draft.layerCount;
  if(globalPosition.length===1&&lastPosition?.draft.locationCode&&!code){code=lastPosition.draft.locationCode;layerCount=lastPosition.draft.layerCount;}
  if(transfer&&destination){code=locations.find(c=>compact(c)===compact(destination))??'';layerCount=Number.isInteger(layer)&&layer>0?layer:1;}
  return {...(item.palletSpecified?{palletCount:String(item.messagePalletCount??item.draft.palletCount)}:{}),key:item.key,product:raw,customerName:explicit.items[index]?.draft.customerName??'',sku:item.messageIdentifiers?.sku??'',barcodes:[...new Set(codes)],quantity:item.draft.totalQuantity,boxes:item.draft.totalBoxes,locationCode:code,layerCount,productCondition:condition,productPrefix:item.card,inboundSource:source,inboundOrder:item.draft.inboundOrder,note:item.draft.note.replace(/\n消息未提供件数，按箱登记（件数记0）/g,''),warnings,choiceKey:'',referenceIds:item.references.flatMap(s=>s.id===undefined?[]:[s.id])};
 });
 return {rows,errors:result.errors,transfer,transferText,operationHint:transfer?'移库':mode==='outbound'?'出库':'入库',countDate:normalized.match(/\b(\d{1,2}[/-]\d{1,2})\s*清点/)?.[1]??''};
}
export function matchMessageProducts(row:Pick<MessageGoodsRow,'product'|'sku'|'barcodes'|'customerName'> & {referenceIds?:number[]},choices:readonly GoodsChoice[],customer:string,mode:GoodsMode){
 const eligible=operationChoices(choices,customer||row.customerName,mode),token=row.sku||row.barcodes[0];
 if(token)return exactOperationMatches(eligible,token);
 const exact=exactOperationMatches(eligible,row.product);if(exact.length)return exact;
 const key=compact(stockProductDetails({product:row.product}).name);if(!key)return [];
 return eligible.filter(c=>{const names=[c.product,...c.members.map(s=>stockProductDetails(s).name)].map(compact);return names.some(n=>n===key||(n.length>=4&&key.endsWith(n))||(key.length>=4&&n.endsWith(key)))||(row.referenceIds??[]).some(id=>c.members.some(s=>s.id===id));});
}
export function materializeMessageImport(data:MessageGoodsImport,choices:readonly GoodsChoice[],existing:readonly (GoodsLineInput&{choice:GoodsChoice})[],newKey:()=>string){
 const result=existing.map(l=>({...l,receipt:{...l.receipt},placements:l.placements.map(p=>({...p})),picks:Object.fromEntries(Object.entries(l.picks).map(([id,p])=>[id,{...p}]))}));
 for(const row of data.rows){const choice=choices.find(c=>c.key===row.choiceKey);if(!choice||choice.review)throw Error('消息对应产品资料已变化，请重新匹配');
  if(!Number.isSafeInteger(row.quantity)||!Number.isSafeInteger(row.boxes)||row.quantity<0||row.boxes<0||(!row.quantity&&!row.boxes))throw Error('请核对消息中的件数和箱数');
  let line=result.find(l=>l.choice.key===choice.key);
  if(!line){line={choice,inventoryUnit:row.quantity?'item':'box',quantity:'0',boxes:'0',receipt:{sku:choice.sku,fnsku:'',barcode:'',barcodes:[],inboundOrder:row.inboundOrder,note:row.note,inboundSource:row.inboundSource,productSpec:choice.productSpec??emptyGoodsProductSpec(),productPrefix:'',productCondition:''},placements:[],picks:{},autoPlacement:false,pickCondition:'all'};result.push(line);}
  else if(data.mode==='inbound'&&(line.receipt.inboundSource!==row.inboundSource||line.receipt.inboundOrder!==row.inboundOrder))throw Error('同一产品的来源或入库单号不同，请分别处理，已有草稿仍保留');
  if(data.mode==='inbound'&&row.note&&line.receipt.note!==row.note)line.receipt.note=[line.receipt.note,row.note].filter(Boolean).join('\n');
  const quantity=Number(line.quantity)+row.quantity,boxes=Number(line.boxes)+row.boxes;if(!Number.isSafeInteger(quantity)||!Number.isSafeInteger(boxes))throw Error('消息数量合计过大');
  if(data.mode==='outbound'&&(quantity>choice.quantity||boxes>choice.boxes))throw Error('消息出库合计超过可用库存');
  line.quantity=String(quantity);line.boxes=String(boxes);if(quantity)line.inventoryUnit='item';line.autoPlacement=false;
  if(data.mode==='inbound')line.placements.push({key:newKey(),locationCode:row.locationCode,layerCount:String(row.layerCount),palletCount:row.palletCount??'1',quantity:String(row.quantity),boxes:String(row.boxes),productCondition:row.productCondition,productPrefix:row.productPrefix,barcodes:[...row.barcodes]});
  else if(row.locationCode){let q=row.quantity,b=row.boxes;const candidates=choice.members.filter(s=>s.locationCode===row.locationCode&&s.layerCount===row.layerCount&&(!row.productCondition||matchesPickCondition(s,row.productCondition as 'good'|'damaged'))&&(!row.productPrefix||compact(stockProductDetails(s).prefix)===compact(row.productPrefix)));for(const s of candidates){const current=line.picks[s.id]??{quantity:'0',boxes:'0'},takeQ=Math.min(q,Math.max(0,s.totalQuantity-Number(current.quantity))),takeB=Math.min(b,Math.max(0,s.totalBoxes-Number(current.boxes)));q-=takeQ;b-=takeB;if(takeQ||takeB)line.picks[s.id]={...current,quantity:String(Number(current.quantity)+takeQ),boxes:String(Number(current.boxes)+takeB)};}}
 }
 if(result.length>25)throw Error('本单超过 25 项，请分次处理消息');return result;
}
