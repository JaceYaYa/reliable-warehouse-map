"use client";
import {Fragment,type ReactNode} from 'react';
import type {CartonReceipt} from '../lib/carton-flow';
import {locationGoodsByLayer} from '../lib/location-goods-order';
import {CartonLocationCards} from './CartonLocationCards';

export function LocationStockCards<T extends {id?:number;layerCount?:number}>({stocks,renderStock,...cartonProps}:{stocks:readonly T[];renderStock:(stock:T)=>ReactNode;receipts:readonly CartonReceipt[];location:string;storageDays:(date:string)=>number;onOpen:(receipt:CartonReceipt,placementKey:string)=>void;selectedId?:string;selectedKey?:string;canDelete?:boolean;onDeleted?:()=>void|Promise<void>}){
 return locationGoodsByLayer(stocks,cartonProps.receipts,cartonProps.location).map(entry=>entry.kind==='stock'
  ?<Fragment key={'stock:'+entry.stock.id}>{renderStock(entry.stock)}</Fragment>
  :<CartonLocationCards key={'carton:'+entry.receipt.id+':'+entry.placement.key} {...cartonProps} receipts={[{...entry.receipt,placements:[entry.placement]}]}/>);
}
