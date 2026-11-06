import {GoodsFlowError} from './goods-flow';
import {hasPermission,type Permission,type PermissionUser} from './permissions';

type Operation={kind:string;result:string};
export function goodsOperationPermission(op:Operation):Permission {
 const result=JSON.parse(op.result) as Record<string,unknown>;
 if(op.kind==='staging')return 'stock.move';
 if(result.inventoryDeletion)return 'stock.delete';
 if(op.kind==='convert'||result.inventoryTypeConversion)return 'stock.convert';
 if(result.productManagement)return result.action==='archive'||result.action==='restore'?'product.archive':'product.manage';
 if(op.kind==='correction'||result.inventoryQuantityCorrection)return 'stock.edit';
 if(op.kind==='identity')return typeof result.customerName==='string'&&typeof result.count==='number'?'stock.edit':'product.manage';
 if(op.kind==='sku'||op.kind==='spec'||op.kind==='create')return 'product.manage';
 return op.kind==='inbound'?'stock.inbound':op.kind==='outbound'?'stock.outbound':'stock.edit';
}

export function assertGoodsRestorePermission(op:Operation,user:PermissionUser){
 const result=JSON.parse(op.result) as Record<string,unknown>;
 const permitted=op.kind==='create'?(hasPermission(user,'product.manage')||hasPermission(user,'stock.inbound')):hasPermission(user,goodsOperationPermission(op));
 if(!hasPermission(user,'stock.restore')||!permitted)throw new GoodsFlowError('没有撤销此操作的权限',403);
 if(result.inventoryTypeConversion&&result.scope==='warehouse'&&user.role!=='admin'&&user.username?.trim().toLowerCase()!=='boss')throw new GoodsFlowError('全仓分类转换的撤销由有转换和恢复权限的老板或管理员操作',403);
}
