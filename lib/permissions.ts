import {isProtectedOwnerUsername} from "./roles.ts";
export const PERMISSIONS = [
  { key: 'stock.inbound', label: '入库', group: '库存操作' },
  { key: 'stock.outbound', label: '出库', group: '库存操作' },
  { key: 'stock.move', label: '移库、箱库存拆分合并与备货待出库', group: '库存操作' },
  { key: 'stock.edit', label: '库存资料、数量校正与人工关联', group: '库存操作' },
  { key: 'stock.convert', label: '产品与箱库存转换', group: '库存操作' },
  { key: 'product.manage', label: '产品资料、SKU、归属与尺寸管理', group: '产品管理' },
  { key: 'product.archive', label: '停用和恢复无库存产品', group: '产品管理' },
  { key: 'stock.delete', label: '删除货物', group: '库存操作' },
  { key: 'stock.restore', label: '撤销和恢复记录', group: '库存操作' },
  { key: 'map.edit', label: '库位与地图管理', group: '仓库管理' },
  { key: 'capacity.edit', label: '层数容量设置', group: '仓库管理' },
  { key: 'pricing.manage', label: '计价与账单管理', group: '仓库管理' },
  { key: 'records.view', label: '出入库记录', group: '记录与系统' },
  { key: 'audit.view', label: '管理记录', group: '记录与系统' },
  { key: 'backup.manage', label: '备份与恢复', group: '记录与系统' },
  { key: 'health.view', label: '数据健康', group: '记录与系统' },
  { key: 'workorders.view', label: '查看工单', group: '工单操作' },
  { key: 'workorders.manage', label: '创建与管理工单', group: '工单操作' },
  { key: 'workorders.execute', label: '执行工单', group: '工单操作' },
  { key: 'users.manage', label: '账号与权限管理', group: '记录与系统' },
] as const;
export type Permission = typeof PERMISSIONS[number]['key'];
export type PermissionUser = { role?: string; username?: string; permissions?: unknown };
export const ALL_PERMISSIONS: Permission[] = PERMISSIONS.map(p => p.key);
// Authenticated accounts use fixed business roles. Legacy saved arrays are retained
// for history only and never grant or remove current role capabilities.
export const EMPLOYEE_PERMISSIONS: Permission[] = ['records.view','workorders.view'];
export const ADMIN_PERMISSIONS: Permission[] = ALL_PERMISSIONS.filter(key => !(['pricing.manage','users.manage','backup.manage','health.view'] as Permission[]).includes(key));
export function parsePermissions(value: unknown): Permission[] | null {
  if (!Array.isArray(value) || value.some(key => !ALL_PERMISSIONS.includes(key as Permission))) return null;
  return ALL_PERMISSIONS.filter(key => value.includes(key));
}
export function effectivePermissions(user?: PermissionUser | null): Permission[] {
  if (!user) return [];
  if (isProtectedOwnerUsername(user.username)) return [...ALL_PERMISSIONS];
  return user.role === 'admin' ? [...ADMIN_PERMISSIONS] : user.role === 'employee' || user.role === 'warehouse' ? [...EMPLOYEE_PERMISSIONS] : [];
}
export const hasPermission = (user: PermissionUser | null | undefined, permission: Permission) => effectivePermissions(user).includes(permission);
export const canWriteLegacyStock = (user: PermissionUser | null | undefined) => (['stock.inbound','stock.outbound','stock.move','stock.edit','stock.delete'] as Permission[]).some(p => hasPermission(user,p));
export const canOperateStock = (user: PermissionUser | null | undefined) => canWriteLegacyStock(user)||(['stock.convert','product.manage','product.archive'] as Permission[]).some(p => hasPermission(user,p));

// Strip only private financial values. Operational identity, product specs and
// physical balances remain available to warehouse roles, without made-up zeros.
const PRIVATE_WAREHOUSE_PRICING_FIELDS = new Set([
  'storageRateUsd','rateUsdM3Day','ratePerM3Day','freeDays','feeUsd','previousStorageRateUsd','previousFreeDays',
  'defaultRatePerM3Day','defaultFreeDays',
  'storage_rate_usd','rate_usd_m3_day','free_days','fee_usd',
]);
export function redactWarehousePricing<T>(value:T,user:PermissionUser|null|undefined):T {
  if(hasPermission(user,'pricing.manage'))return value;
  const jsonSnapshots=new Set(['beforeSnapshot','afterSnapshot','result','beforeRows','afterRows','beforeCategory','afterCategory']);
  const redact=(item:unknown,key=''):unknown=>{
    if(typeof item==='string'&&jsonSnapshots.has(key)){try{return JSON.stringify(redact(JSON.parse(item)));}catch{return item;}}
    if(Array.isArray(item))return item.map(entry=>redact(entry));
    if(!item||typeof item!=='object')return item;
    return Object.fromEntries(Object.entries(item).filter(([key])=>!PRIVATE_WAREHOUSE_PRICING_FIELDS.has(key)).map(([key,entry])=>[key,redact(entry,key)]));
  };
  return redact(value) as T;
}
