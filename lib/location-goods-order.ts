import type {CartonReceipt,CartonPlacement} from './carton-flow';

/** One visual sequence for all goods in a location; ties retain their source order. */
export function locationGoodsByLayer<T extends {layerCount?:number}>(stocks:readonly T[],receipts:readonly CartonReceipt[],location:string){
 const entries:Array<{kind:'stock';stock:T;layer:number}|{kind:'carton';receipt:CartonReceipt;placement:CartonPlacement;layer:number}>=stocks.map(stock=>({kind:'stock',stock,layer:stock.layerCount||1}));
 for(const receipt of receipts)for(const placement of receipt.placements)if(placement.locationCode===location&&placement.boxes>0)entries.push({kind:'carton',receipt,placement,layer:placement.layerCount||1});
 return entries.sort((a,b)=>b.layer-a.layer);
}
