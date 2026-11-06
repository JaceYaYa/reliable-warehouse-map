"use client";
import { createContext, useContext, useEffect, useId, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { type InventoryStock } from "../lib/inventory-groups";
import { stockProductDetails } from "../lib/stock-product";
import {boxInventoryLabel,pendingBoxRecord} from "../lib/box-inventory-review";
import { ProductAnnotations } from "./ProductAnnotations";
import { IdentityEditDialog } from "./IdentityEditDialog";
import { CustomerNameInput } from "./CustomerNameInput";
import { recordDraft, recordPatch, type InventoryRecordDraft, type InventoryRecordSave } from "../lib/inventory-record-edit";
import styles from "./InventoryWorkspace.module.css";

type InlineField=keyof InventoryRecordDraft|"annotations";
type EditSession={instance:string;base:InventoryStock;draft:InventoryRecordDraft;fields:InlineField[];focus:InlineField;busy:boolean};
const EditContext=createContext<{session:EditSession|null;setSession:Dispatch<SetStateAction<EditSession|null>>;customerNames:readonly string[];onIdentitySaved:()=>Promise<void>}|null>(null);
export function useInventoryEditSession(){return useContext(EditContext)?.session||null}
export function useInventoryIdentityRefresh(){return useContext(EditContext)?.onIdentitySaved||(async()=>{})}
export function useInventoryCustomerNames(){return useContext(EditContext)?.customerNames||[]}
export function InventoryRecordEditing({children,customerNames=[],onIdentitySaved=async()=>{}}:{children:ReactNode;customerNames?:readonly string[];onIdentitySaved?:()=>Promise<void>}){
  const [session,setSession]=useState<EditSession|null>(null);
  return <EditContext.Provider value={{session,setSession,customerNames,onIdentitySaved}}>{session&&<div className={styles.editSession} role="status"><span>正在修改：{session.base.locationCode} · {session.base.product}。切换筛选时填写仍保留。</span><button type="button" disabled={session.busy} onClick={()=>setSession(null)}>取消当前修改</button></div>}{children}</EditContext.Provider>;
}
export function InventoryRecordCard<T extends InventoryStock>({stock,productView,canEdit=false,canManageProduct=false,canConvert=false,onSave,onOpenStock}:{stock:T;productView?:{product:string;productPrefix:string};canEdit?:boolean;canManageProduct?:boolean;canConvert?:boolean;onSave:InventoryRecordSave;onOpenStock:(stock:T)=>void}) {
  const formId=useId(),context=useContext(EditContext),[feedback,setFeedback]=useState(""),[identityOpen,setIdentityOpen]=useState(false);
  const session=context?.session,active=Boolean(session&&session.instance===formId&&session.base.id===stock.id),draft=active?session!.draft:null,base=active?session!.base:null,busy=active?session!.busy:false;
  useEffect(()=>{
    if(!active||!session)return;
    const target=document.getElementById(`${formId}-${session.focus}`);
    const input=session.focus==="annotations"?target?.querySelector<HTMLInputElement>('input[type="text"],input:not([type])'):target;
    input?.focus({preventScroll:true});
    if(input instanceof HTMLInputElement&&input.type==="text")input.select();
  },[active,session?.focus,formId]);
  if(!context)throw new Error("库存编辑必须位于库存界面内");
  const {setSession}=context,fmt=(n:number)=>n.toLocaleString("zh-CN");
  const details=stockProductDetails(draft&&session?.fields.some(f=>f==="product"||f==="annotations")?{product:draft.product,productPrefix:draft.productPrefix,productCondition:draft.productCondition}:{...stock,...productView,productCondition:stockProductDetails(stock).condition});
  const stale=Boolean(draft&&base&&(stock.version??0)!==(base.version??0));
  const keepPosition=()=>{
    const anchor=Array.from(document.querySelectorAll<HTMLElement>(`[data-inventory-stock-id="${stock.id}"]`)).find(el=>el.getClientRects().length),top=anchor?.getBoundingClientRect().top;
    return ()=>requestAnimationFrame(()=>{if(anchor?.isConnected&&top!==undefined)window.scrollBy({top:anchor.getBoundingClientRect().top-top,behavior:"instant"})});
  };
  const begin=(field:InlineField)=>{
    if(!canEdit||session?.busy)return;
    if(session&&session.base.id!==stock.id){setFeedback("请先保存或取消正在修改的另一条记录");return}
    const restore=keepPosition();setSession(current=>{const editingName=field==="product"||field==="annotations",same=current&&current.base.id===stock.id;const draft=same?current.draft:recordDraft(stock);const display=editingName&&productView&&!current?.fields.some(f=>f==="product"||f==="annotations")?{product:productView.product,productPrefix:productView.productPrefix}:{};return same?{...current,instance:formId,draft:{...draft,...display},fields:[...new Set([...current.fields,field])],focus:field}:{instance:formId,base:{...stock},draft:{...draft,...display},fields:[field],focus:field,busy:false}});setFeedback("");restore();
  };
  const cancel=()=>{if(busy)return;const restore=keepPosition(),field=session?.focus;setSession(null);setFeedback("");restore();requestAnimationFrame(()=>document.getElementById(`${formId}-${field}-trigger`)?.focus({preventScroll:true}))};
  const change=(key:keyof InventoryRecordDraft,value:string)=>setSession(current=>current&&current.instance===formId?{...current,draft:{...current.draft,[key]:value}}:current);
  const setBusy=(value:boolean)=>setSession(current=>current&&current.instance===formId?{...current,busy:value}:current);
  const save=async()=>{
    if(!draft||!base||busy||!canEdit||stale)return;
    const result=recordPatch(base,draft);if(!result.patch){if(result.error==="没有修改内容"){cancel();return}setFeedback(result.error||"请检查填写内容");return}
    const anchor=Array.from(document.querySelectorAll<HTMLElement>(`[data-inventory-stock-id="${stock.id}"]`)).find(el=>el.getClientRects().length);
    const top=anchor?.getBoundingClientRect().top,y=window.scrollY;
    setBusy(true);setFeedback("");
    try{
      const saved=await onSave(result.patch);if(!saved.ok){setFeedback(saved.error||"保存失败，填写内容仍保留");return}
      setSession(null);setFeedback("已保存并同步到库位记录");
      requestAnimationFrame(()=>requestAnimationFrame(()=>{
        const current=Array.from(document.querySelectorAll<HTMLElement>(`[data-inventory-stock-id="${stock.id}"]`)).find(el=>el.getClientRects().length);
        window.scrollTo({top:current&&top!==undefined?window.scrollY+current.getBoundingClientRect().top-top:y,behavior:"instant"});
        current?.querySelector<HTMLButtonElement>(`button[data-record-edit="${session?.focus}"]`)?.focus({preventScroll:true});
      }));
    }catch{setFeedback("保存失败，请检查网络后重试，填写内容仍保留")}
    finally{setBusy(false)}
  };
  const editable=(field:InlineField,label:string,content:ReactNode,extraClass="")=>canEdit?<button id={`${formId}-${field}-trigger`} type="button" className={`${styles.inlineValue} ${extraClass}`} aria-label={`编辑${label}`} title="双击修改；手机点一下修改" data-record-edit={field} disabled={Boolean(session?.busy)} onDoubleClick={()=>begin(field)} onClick={event=>{event.stopPropagation();if(event.detail===0||window.matchMedia("(pointer: coarse)").matches)begin(field)}}>{content}<span className={styles.inlinePencil} aria-hidden="true">✎</span></button>:content;
  const field=(key:keyof InventoryRecordDraft,label:string,content:ReactNode,type="text",compact=false)=>{
    if(["product","sku","customerName"].includes(key))return content;
    if(!draft||!session?.fields.includes(key))return editable(key,label,content);
    const props={id:`${formId}-${key}`,"aria-label":label,value:draft[key],disabled:busy||!canEdit,className:compact?styles.inlineNumber:styles.inlineInput,onChange:(event:{target:{value:string}})=>change(key,event.target.value)};
    if(key==="customerName")return <CustomerNameInput id={props.id} label={label} value={draft[key]} onChange={name=>change(key,name)} customerNames={context.customerNames} disabled={props.disabled} className={styles.inlineInput}/>;
    if(key==="note")return <textarea {...props} className={styles.inlineNote} maxLength={20000} rows={Math.min(14,Math.max(3,draft.note.split("\n").length+1))}/>;
    if(key==="inboundSource")return <select {...props}><option value="return">退货</option><option value="domestic">国内</option><option value="unspecified">无</option></select>;
    return <input {...props} type={type} min={type==="number"?key==="layerCount"?1:0:undefined} step={type==="number"?1:undefined} maxLength={type==="text"?key==="product"?2000:500:undefined} onWheel={event=>{if(type==="number"&&document.activeElement===event.currentTarget)event.currentTarget.blur()}}/>;
  };
  const value=(key:keyof InventoryRecordDraft,fallback:ReactNode)=>draft?draft[key]||fallback:fallback;
  const content=<>
    <div className={styles.memberHead}><strong>{stock.locationCode} · 第 {field("layerCount","存放层数",value("layerCount",stock.layerCount||1),"number",true)} 层</strong><span>{stock.inventoryUnit!=="box"&&<>{field("totalQuantity","件数",draft?draft.totalQuantity:fmt(stock.totalQuantity),"number",true)} 件 / </>}{field("totalBoxes","箱数",draft?draft.totalBoxes:fmt(stock.totalBoxes),"number",true)} 箱</span></div>
    <div className={styles.recordProduct}>{(details.label||canEdit)&&editable("annotations","品相和附加标记",details.label?<span className="product-attention">（{details.label}）</span>:<span className={styles.emptyAnnotations}>＋ 品相 / 标记</span>)}{field("product","产品名称",details.name||"未命名货物")}</div>
    {draft&&session?.fields.includes("annotations")&&<div id={`${formId}-annotations`} className={styles.inlineAnnotationEditor}><ProductAnnotations prefix={draft.productPrefix} condition={draft.productCondition} disabled={busy||!canEdit} onChange={patch=>setSession(current=>current&&current.instance===formId?{...current,draft:{...current.draft,...patch}}:current)}/></div>}
    <div className={styles.recordCustomer}><span>客户：</span>{field("customerName","客户名称",value("customerName",stock.customerName||(stock.inventoryUnit==='box'?'待认领':'未填写')))}<small>{boxInventoryLabel([stock])}{pendingBoxRecord(stock)?' · 箱库存待核对':stock.inventoryReviewDecision==='retain'?' · 已决定保留件库存':''}</small></div>
    <dl className={styles.recordDetails}><div><dt>入库日期</dt><dd>{field("inboundDate","入库日期",value("inboundDate",stock.inboundDate||"未填写"),"date")}</dd></div><div><dt>来源</dt><dd>{field("inboundSource","来源",(draft?.inboundSource??stock.inboundSource)==="return"?"退货":(draft?.inboundSource??stock.inboundSource)==="domestic"?"国内":"无")}</dd></div><div><dt>SKU / 条码</dt><dd className={styles.inlineCodes}>{field("sku","SKU",value("sku",stock.sku||"—"))}<span> / </span>{field("barcode","产品条形码",value("barcode",stock.barcode||"—"))}</dd></div><div><dt>入库单号</dt><dd>{field("inboundOrder","入库单号",value("inboundOrder",stock.inboundOrder||"—"))}</dd></div><div className={styles.wide}><dt>备注</dt><dd>{field("note","备注",value("note",stock.note||"—"))}</dd></div></dl>
    {stale&&<p role="alert" className={styles.feedback}>这条记录已有新修改，你的填写仍保留。<button type="button" disabled={busy} onClick={()=>{setSession(current=>current?{...current,base:{...stock},draft:recordDraft(stock)}:current);setFeedback("")}}>放弃填写并载入最新记录</button></p>}
    {feedback&&<p role="status" className={styles.feedback}>{feedback}</p>}
    <div className={styles.recordActions}>{canManageProduct&&<button type="button" disabled={Boolean(session)} onClick={()=>setIdentityOpen(true)}>修改名称 / SKU / 商家</button>}{draft?<><button type="submit" className={styles.primary} disabled={busy||!canEdit||stale}>{busy?"保存中…":"保存修改"}</button><button type="button" disabled={busy} onClick={cancel}>取消修改</button><small>Enter 保存 · Esc 取消；备注用 Ctrl＋Enter 保存</small></>:canEdit&&<small className={styles.inlineEditHint}>{session?.base.id===stock.id?<button type="button" onClick={()=>begin(session?.focus??"note")}>继续修改</button>:<><span className={styles.desktopEditHint}>双击其他内容修改</span><span className={styles.touchEditHint}>点其他内容修改</span></>}</small>}<button type="button" disabled={busy} onClick={()=>onOpenStock(stock)}>查看库位记录</button></div>
  </>;
  return <article className={styles.recordCard} data-inventory-stock-id={stock.id}>{identityOpen&&canManageProduct&&<IdentityEditDialog canConvert={canConvert} stock={stock} customerNames={context.customerNames} onClose={()=>setIdentityOpen(false)} onSaved={context.onIdentitySaved}/>}{draft?<form className={styles.inlineForm} aria-label={`编辑库存记录 ${stock.id}`} onSubmit={event=>{event.preventDefault();void save()}} onKeyDown={event=>{
    if(event.key==="Escape"){event.preventDefault();event.stopPropagation();cancel()}
    if(event.key==="Enter"){
      if(event.nativeEvent.isComposing||event.nativeEvent.keyCode===229){event.preventDefault();return}
      if(event.target instanceof HTMLTextAreaElement&&!event.ctrlKey&&!event.metaKey)return;
      if(event.target instanceof HTMLInputElement||event.target instanceof HTMLSelectElement||event.target instanceof HTMLTextAreaElement){event.preventDefault();void save()}
    }
  }}>{content}</form>:content}</article>;
}
