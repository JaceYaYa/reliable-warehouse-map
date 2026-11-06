import {env} from 'cloudflare:workers';
import {eq} from 'drizzle-orm';
import {getDb} from '../db';
import {settings} from '../db/schema';
import {GoodsFlowError,type GoodsStock} from './goods-flow';
import {customerPricingKey,customerPricingProfiles,effectiveCustomerPricing} from './customer-pricing';

/** Freeze the current customer's overrides into new settlements, leaving original lots untouched. */
export async function outboundCustomerPricing(customerName:string){
 const key=customerPricingKey(customerName),[stored]=await getDb().select().from(settings).where(eq(settings.key,key));
 try{if(stored)JSON.parse(stored.value);}catch{throw new GoodsFlowError('客户仓储计价设置异常，请到仓储计价检查；本次不会扣货',500);}
 const profiles=customerPricingProfiles(stored?[stored]:[]);
 return {
  forLot:(row:GoodsStock)=>effectiveCustomerPricing({customerName,inboundDate:row.inboundDate,recordRatePerM3Day:row.storageRateUsd,recordFreeDays:row.freeDays,profiles}),
  guard:(id:string)=>env.DB.prepare("INSERT INTO goods_transaction_guards(id,valid) VALUES (?,CASE WHEN COALESCE((SELECT value FROM settings WHERE key=?),'')=? THEN 1 ELSE 0 END)").bind(id,key,stored?.value??''),
 };
}
