import { mergeSources as legacyMerge } from "./legacy/source-merge.mjs";
import { draftBody as legacyBody, draftIssues as legacyDraftIssues, missingFields as legacyMissing } from "./legacy/task-draft.mjs";
import { deliveryBody as legacyDeliveryBody, deliveryIssues as legacyDeliveryIssues, deliveryOnHold as legacyHold } from "./legacy/delivery-data.mjs";
import { quantityIssues as legacyQuantityIssues, quantitySignature as legacySignature } from "./legacy/quantity-confirmation.mjs";

export const WORKORDER_KINDS = { inbound: "入库 / 退货清点", outbound: "出库 / 备货中转", parcel: "一件代发", general: "通用工单" };
export const WORKORDER_STATUSES = { draft: "草稿", ready: "待执行", in_progress: "执行中", completed: "已完成", cancelled: "已取消", held: "暂不放行" };
export type WorkorderKind = keyof typeof WORKORDER_KINDS;
export type WorkorderStatus = keyof typeof WORKORDER_STATUSES;
export type InventoryRef = { stockId: number; version: number; updatedAt: string; locationCode: string; product: string; sku: string; customerName: string; totalQuantity: number; totalBoxes: number; inboundOrder: string; layerCount: number };
export type WorkRow = { id: string; inboundNo: string; orderNo?: string; sku: string; product: string; boxes: string | number; perCarton: string; shipUnits: string; remainderAction: string; locations: InventoryRef[]; locationAllocations?: { stockId:number;boxes:string;units:string }[]; quantityConfirmation?: { actualBoxes: string; actualUnits: string; confirmed: boolean; signature: string }; [key: string]: unknown };
export type WorkDocument = { mode?: string; orderNo: string; customer: string; product: string; sku: string; requirements: string; extraRequirements?: string; hold?: boolean; rows: WorkRow[]; warnings: string[]; [key: string]: unknown };
export type WorkPayload = { sourceText: string; ocrText: string; ocrSources?: string[];screenshotRows?:Record<string,unknown>[]; sourceDocument: WorkDocument | null; document: WorkDocument | null; resolutions: Record<string, string | number>; reviewed: boolean;draftOverrides?:WorkDraftFields;externalMaterialsConfirmed?:boolean; sourceFingerprint?: string; [key: string]: unknown };
export type Workorder = { id: string; number: string; kind: WorkorderKind; title: string; customerName?: string; employeeBody: string; payload?: WorkPayload; fileIds: string[]; status: WorkorderStatus; assignedTo: string; version: number; createdAt: string; updatedAt: string; files?: { id: string; name: string; mime: string; size: number; visibility: string }[] };
export const emptyWorkPayload = (): WorkPayload => ({ sourceText: "", ocrText: "", sourceDocument: null, document: null, resolutions: {}, reviewed: false });
type Draft = Record<string, string> & { type: string; hold?: boolean; warnings?: string[] };
type Merge = { draft: Draft; doc: WorkDocument | null; conflicts: { id: string; label: string; resolved: boolean; options: { value: string; label: string }[] }[]; warnings: string[] };
export const WORK_DRAFT_FIELDS = ['orderNo','inboundNo','product','sku','fnsku','quantity','location','returnAddress','newBarcode','transparentBarcode','labelGap','requirements'] as const;
export type WorkDraftFields = Partial<Record<typeof WORK_DRAFT_FIELDS[number],string>>;
export function mergeWorkSources(payload: WorkPayload, kind: WorkorderKind): Merge {
 const merged=(legacyMerge as unknown as (input: unknown) => Merge)({ pdf: payload.sourceDocument, text: payload.sourceText, ocr: payload.ocrText,ocrSources:payload.ocrSources,screenshotRows:payload.screenshotRows||[], resolutions: payload.resolutions, type: kind === "outbound" ? "transfer" : kind === "inbound" ? "returns" : "general" });
 // Checked fields never erase source conflicts or original hold conditions.
 if(!merged.doc&&payload.draftOverrides)for(const field of WORK_DRAFT_FIELDS){const value=payload.draftOverrides[field];if(typeof value==='string')merged.draft[field]=value;}
 return merged;
}
export function previousWorkRow(previous:WorkDocument|null|undefined,row:WorkRow,next:WorkDocument):WorkRow|undefined {
 if(!previous)return;
 const identity=(doc:WorkDocument,line:WorkRow)=>{const order=(line.orderNo||doc.orderNo||'').trim().toUpperCase(),sku=(line.sku||doc.sku||'').trim(),carton=(line.inboundNo||'').trim().toUpperCase();return order&&(sku||carton)?JSON.stringify([order,sku,carton]):null;};
 const key=identity(next,row);return key?previous.rows.find(candidate=>identity(previous,candidate)===key):undefined;
}
export function employeeBodyReplacement(current:string,generated:string,confirm:()=>boolean):string|null {
 return current.trim()&&current!==generated&&!confirm()?null:generated;
}
export const workQuantitySignature = (doc: WorkDocument, row: WorkRow) => (legacySignature as unknown as (doc: WorkDocument, row: WorkRow) => string)(doc, row);
export function generatedEmployeeBody(payload: WorkPayload, kind: WorkorderKind,employeeFileCount=0) {
  const merged = mergeWorkSources(payload, kind);
  const doc = payload.document ?? merged.doc;
  const uniqueInstructions=(text:string)=>[...new Set(text.split('\n').map(line=>line.trim().replace(/^\d+\s*[.．、]\s*/,'' )).filter(Boolean))].join('\n');
  const renderingDoc=doc?{...doc,requirements:uniqueInstructions([doc.requirements,doc.extraRequirements||''].join('\n')),extraRequirements:'',rows:doc.rows.map(row=>row.locations.length>1&&row.locationAllocations?.length===row.locations.length?{...row,locations:[{...row.locations[0],locationCode:row.locations.map(stock=>{const allocation=row.locationAllocations!.find(a=>a.stockId===stock.stockId);return `${stock.locationCode}（取${allocation?.boxes??'待确认'}箱 / ${allocation?.units??'待确认'}件）`;}).join(' + ')}]}:row)}:null;
  const missing=(legacyMissing as unknown as (draft:Draft,hasFiles:boolean)=>string[])(merged.draft,true),needsMaterial=requiresEmployeeMaterials(payload)&&employeeFileCount===0&&!payload.externalMaterialsConfirmed;
  if(needsMaterial)missing.push('员工可下载的标签/面单附件（或确认已通过其他渠道提供）');
  let text = renderingDoc ? (legacyDeliveryBody as unknown as (doc: WorkDocument) => string)(renderingDoc) : (legacyBody as unknown as (draft: Draft,missing:string[]) => string)({ ...merged.draft, customer: "",requirements:uniqueInstructions(merged.draft.requirements||'') } as Draft,missing);
  if(renderingDoc&&needsMaterial)text+='\n\n待补充：员工可下载的标签/面单附件（或确认已通过其他渠道提供）。';
  return text.split("\n").filter(line => !/^\s*(?:客户|货主)\s*[：:]/.test(line)&&!/^\s*单号\s*[：:]\s*待补充\s*$/.test(line)).join("\n");
}
export function requiresEmployeeMaterials(payload:WorkPayload,employeeBody=''){
  return [payload.sourceText,payload.ocrText,payload.draftOverrides?.requirements,payload.document?.requirements,payload.document?.extraRequirements,employeeBody].filter(Boolean).join('\n').split(/[；;。，,\n]|(?:但是|但|然后)/).some(clause=>!/^\s*(?:待补充|⚠️)/.test(clause)&&!/(?:无需|不用|不需要|不必|不换|不贴|不更换|不打印)/.test(clause)&&/(?:所附|附件|随附|提供的).{0,8}(?:标签|面单|箱唛)|换(?:产品)?标|贴.{0,5}(?:标签|箱唛|面单)|(?:打印|更换|替换).{0,8}(?:标签|箱唛|面单)|(?:标签|面单|箱唛|条形码).{0,8}(?:更换为|替换为|改为|换成)/.test(clause));
}
export function workorderRisks(payload: WorkPayload, kind: WorkorderKind,employeeFileCount?:number) {
  const merged = mergeWorkSources(payload, kind), doc = payload.document ?? merged.doc;
  const unresolved = merged.conflicts.filter(c => !c.resolved).map(c => c.label);
  const structuralDoc=doc?{...doc,rows:doc.rows.map(row=>row.locations.length>1?{...row,locations:[row.locations[0]]}:row)}:null;
  const issues = doc ? [...(legacyDeliveryIssues as unknown as (doc: WorkDocument) => string[])(structuralDoc!), ...(legacyQuantityIssues as unknown as (doc: WorkDocument) => string[])({...doc,rows:doc.rows.filter(row=>row.locations.length<=1)}),...multipleLocationIssues(doc)] : [...(legacyDraftIssues as unknown as (draft: Draft) => string[])(merged.draft), ...(legacyMissing as unknown as (draft: Draft, hasFiles: boolean) => string[])(merged.draft, true).map(field => `${field}待补充`)];
  if(kind==='outbound'&&doc&&!doc.rows.length)issues.push('出库工单至少需要一行明确的取货数量和库位');
  const warnings = [...merged.warnings, ...(doc?.warnings || [])];
  if(employeeFileCount===0&&requiresEmployeeMaterials(payload)){if(!payload.externalMaterialsConfirmed)issues.push('操作涉及标签/面单，但员工没有可下载附件；请添加员工操作附件或明确确认已通过其他渠道提供');else warnings.push('标签/面单由管理人员确认通过其他渠道提供给员工，本工单未附下载文件');}
  if(doc)for(const row of doc.rows)for(const stock of row.locations){
    const key=(v:string)=>v.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s/g,'');
    if(doc.customer&&stock.customerName&&key(doc.customer)!==key(stock.customerName))warnings.push(`${stock.locationCode} 客户名称不同：来源 ${doc.customer} / 库存 ${stock.customerName}，请核对历史别名`);
    if((row.sku||doc.sku)&&stock.sku&&key(row.sku||doc.sku)!==key(stock.sku))warnings.push(`${stock.locationCode} SKU不同：工单 ${row.sku||doc.sku} / 库存 ${stock.sku}，请核对是否选错货物`);
    if((row.product||doc.product)&&stock.product&&key(row.product||doc.product)!==key(stock.product))warnings.push(`${stock.locationCode} 产品名称不同：工单 ${row.product||doc.product} / 库存 ${stock.product}，请核对型号与标记`);
  }
  if (/[√✓✔]/.test(`${payload.sourceText}\n${payload.ocrText}\n${doc?.text ?? ""}`)) warnings.push("原资料含√标记，仅保留来源痕迹，不代表已执行或已确认数量");
  const held=(legacyHold as unknown as (doc: unknown) => boolean)({requirements:`${payload.sourceText}\n${payload.ocrText}`})||(legacyHold as unknown as (doc:unknown)=>boolean)({requirements:merged.draft.requirements})||!!merged.draft.hold||!!payload.sourceDocument?.hold||(doc?(legacyHold as unknown as (doc:WorkDocument)=>boolean)(doc):false);
  return { merged, unresolved, issues: [...new Set(issues)], warnings: [...new Set(warnings)], held };
}
function multipleLocationIssues(doc:WorkDocument){
  const issues:string[]=[],totals=new Map<number,{boxes:number;units:number;stock:InventoryRef;multi:boolean}>();
  const count=(value:unknown)=>String(value).trim()!==''&&Number.isSafeInteger(Number(value))&&Number(value)>=0?Number(value):null;
  for(const row of doc.rows){
    const unique=[...new Map(row.locations.map(ref=>[ref.stockId,ref])).values()],multi=unique.length>1,label=row.orderNo||row.inboundNo||row.id;
    if(!multi){if(unique.length){const boxes=count(row.boxes),units=count(row.shipUnits);if(boxes!==null&&units!==null){const ref=unique[0],sum=totals.get(ref.stockId)||{boxes:0,units:0,stock:ref,multi:false};sum.boxes+=boxes;sum.units+=units;totals.set(ref.stockId,sum);}}continue;}
    const allocations=row.locationAllocations||[];
    if(allocations.length!==unique.length||new Set(allocations.map(a=>a.stockId)).size!==allocations.length||allocations.some(a=>!unique.some(ref=>ref.stockId===a.stockId))){issues.push(`${label}：请选择每个库位的取货箱数和件数`);continue;}
    let boxes=0,units=0,valid=true;
    for(const allocation of allocations){const b=count(allocation.boxes),u=count(allocation.units);if(b===null||u===null||b+u===0){issues.push(`${label}：各库位分配必须为有效整数，且不能同时为0`);valid=false;continue;}boxes+=b;units+=u;const ref=unique.find(ref=>ref.stockId===allocation.stockId)!,sum=totals.get(ref.stockId)||{boxes:0,units:0,stock:ref,multi:false};sum.boxes+=b;sum.units+=u;sum.multi=true;totals.set(ref.stockId,sum);}
    if(valid&&(boxes!==count(row.boxes)||units!==count(row.shipUnits)))issues.push(`${label}：各库位分配合计应等于本行 ${row.boxes} 箱 / ${row.shipUnits} 件`);
  }
  for(const [id,sum]of totals)if(sum.multi&&(sum.stock.totalBoxes<=0||sum.stock.totalQuantity<=0||sum.boxes>sum.stock.totalBoxes||sum.units>sum.stock.totalQuantity))issues.push(`${sum.stock.locationCode} 库存#${id}：多库位分配合计需 ${sum.boxes} 箱 / ${sum.units} 件，库存未确认或不足；请先核实库存并按库位拆行确认`);
  return issues;
}
export class WorkorderError extends Error { constructor(message: string, public status = 409) { super(message); } }
export function boundedText(value: unknown, name: string, max: number, required = false) { if (typeof value !== "string" || value.length > max || (required && !value.trim())) throw new WorkorderError(`${name}未填写或内容过长`, 400); return value.trim(); }
export function workorderUuid(value: unknown, name = "请求编号") { if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new WorkorderError(`${name}无效`, 400); return value; }
export function validateWorkPayload(raw: unknown): WorkPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || JSON.stringify(raw).length > 750000) throw new WorkorderError("资料格式无效或过大", 400);
  const value = JSON.parse(JSON.stringify(raw)) as WorkPayload;
  boundedText(value.sourceText, "原文字资料", 12000); boundedText(value.ocrText, "截图识字", 18000);
  if(value.ocrSources!==undefined&&(!Array.isArray(value.ocrSources)||value.ocrSources.length>10||value.ocrSources.some(text=>typeof text!=='string'||text.length>18000)||value.ocrSources.join('\n').length>18000))throw new WorkorderError('多张截图识字结果过大或格式无效',400);
  if(value.screenshotRows!==undefined&&(!Array.isArray(value.screenshotRows)||value.screenshotRows.length>100||value.screenshotRows.some(row=>!row||typeof row!=='object'||Array.isArray(row))))throw new WorkorderError('截图表格结果格式无效',400);
  if (typeof value.reviewed !== "boolean" || !value.resolutions || typeof value.resolutions !== "object" || Array.isArray(value.resolutions)) throw new WorkorderError("缺少核对状态", 400);
  if(value.externalMaterialsConfirmed!==undefined&&typeof value.externalMaterialsConfirmed!=='boolean')throw new WorkorderError('外部操作资料核对状态无效',400);
  if(value.draftOverrides!==undefined){
   if(!value.draftOverrides||typeof value.draftOverrides!=='object'||Array.isArray(value.draftOverrides)||Object.keys(value.draftOverrides).some(key=>!WORK_DRAFT_FIELDS.includes(key as typeof WORK_DRAFT_FIELDS[number])))throw new WorkorderError('核对字段格式无效',400);
   for(const field of WORK_DRAFT_FIELDS)if(value.draftOverrides[field]!==undefined)boundedText(value.draftOverrides[field],'核对字段',field==='requirements'?12000:500);
  }
  for (const doc of [value.document, value.sourceDocument]) if (doc !== null) {
    if (!doc || !Array.isArray(doc.rows) || doc.rows.length > 100 || !Array.isArray(doc.warnings) || doc.warnings.some(w=>typeof w!=='string') || ['orderNo','requirements','customer','product','sku'].some(key=>typeof doc[key]!=='string')||(doc.extraRequirements!==undefined&&typeof doc.extraRequirements!=='string')) throw new WorkorderError("工单明细格式不正确", 400);
    for (const row of doc.rows){
      if (!row || !Array.isArray(row.locations) || row.locations.length > 20 || typeof row.id!=='string'||typeof row.inboundNo !== "string" || typeof row.sku !== "string" || typeof row.product !== "string" || typeof row.perCarton!=="string"||typeof row.shipUnits!=="string"||typeof row.remainderAction!=="string"||!(typeof row.boxes==='string'||typeof row.boxes==='number')||!row.locations.every(s => s&&Number.isSafeInteger(s.stockId) && s.stockId > 0 && Number.isSafeInteger(s.version)&&s.version>=0&&['updatedAt','locationCode','product','sku','customerName','inboundOrder'].every(key=>typeof s[key as keyof InventoryRef]==='string')&&['totalQuantity','totalBoxes','layerCount'].every(key=>Number.isSafeInteger(s[key as keyof InventoryRef])&&Number(s[key as keyof InventoryRef])>=0))) throw new WorkorderError("工单库位引用无效", 400);
      if(row.locationAllocations!==undefined&&(!Array.isArray(row.locationAllocations)||row.locationAllocations.length>20||row.locationAllocations.some(a=>!a||!Number.isSafeInteger(a.stockId)||typeof a.boxes!=='string'||typeof a.units!=='string')))throw new WorkorderError('库位取货分配格式无效',400);
      if(row.quantityConfirmation!==undefined&&(!row.quantityConfirmation||typeof row.quantityConfirmation.actualBoxes!=='string'||typeof row.quantityConfirmation.actualUnits!=='string'||typeof row.quantityConfirmation.confirmed!=='boolean'||typeof row.quantityConfirmation.signature!=='string'))throw new WorkorderError('数量核对格式无效',400);
    }
  }
  return value;
}
