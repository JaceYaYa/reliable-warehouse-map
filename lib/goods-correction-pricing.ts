import {env} from 'cloudflare:workers';
import {eq} from 'drizzle-orm';
import {getDb} from '../db';
import {settings} from '../db/schema';
import {GoodsFlowError,type GoodsChoice,type GoodsStock} from './goods-flow';
import {goodsProductSpec} from './goods-product-spec';
import {DEFAULT_PRICING_SETTINGS,normalizePricingSettings,PRICING_DEFAULTS_KEY} from './pricing';
import {customerPricingKey,customerPricingProfiles,effectiveCustomerPricing} from './customer-pricing';

export type CorrectionPricing=Pick<GoodsStock,'billingMode'|'itemVolumeM3'|'boxVolumeM3'|'storageRateUsd'|'freeDays'>;

/** New quantity uses product measurements and warehouse rules, never a caller-chosen old lot. */
export async function correctionProductPricing(choice:GoodsChoice,stock:GoodsStock){
 const keys=[PRICING_DEFAULTS_KEY,customerPricingKey(choice.customerName)];
 const results=await getDb().batch(keys.map(key=>getDb().select().from(settings).where(eq(settings.key,key))));
 const rows=results.map(result=>(result as {key:string;value:string}[])[0]);
 const expected=keys.map((key,index)=>({key,value:rows[index]?.value??null}));
 let defaults={...DEFAULT_PRICING_SETTINGS};
 try{if(rows[0])defaults=normalizePricingSettings(JSON.parse(rows[0].value));if(rows[1])JSON.parse(rows[1].value);}catch{throw new GoodsFlowError('仓储计价设置异常，请到仓储计价检查',500);}
 const customer=effectiveCustomerPricing({customerName:choice.customerName,inboundDate:stock.inboundDate,recordRatePerM3Day:defaults.defaultRatePerM3Day,recordFreeDays:defaults.defaultFreeDays,profiles:customerPricingProfiles(rows.filter((row):row is {key:string;value:string}=>!!row))});
 const spec=goodsProductSpec(choice.members,choice.productSpec);
 const pricing:CorrectionPricing={billingMode:stock.billingMode,itemVolumeM3:spec.itemVolumeM3,boxVolumeM3:spec.boxVolumeM3,storageRateUsd:customer.ratePerM3Day,freeDays:customer.freeDays};
 return {pricing,guard:(id:string)=>env.DB.prepare(`INSERT INTO goods_transaction_guards(id,valid) VALUES (?,CASE WHEN ${expected.map(()=>"COALESCE((SELECT value FROM settings WHERE key=?),'')=?").join(' AND ')} THEN 1 ELSE 0 END)`).bind(id,...expected.flatMap(row=>[row.key,row.value??'']))};
}
