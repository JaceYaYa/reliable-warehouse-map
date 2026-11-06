import {getDb} from '../db';
import {goodsOperations,cartonOperations,auditLogs,storageFeeSettlements,settings} from '../db/schema';
import {eq,sql} from 'drizzle-orm';
import {buildOutboundHistory,DIRECT_OUTBOUND_AUDIT_PREDICATE} from './outbound-history';
import {applyOutboundCorrections} from './outbound-history-corrections';
import {applyOutboundBillingDetails} from './outbound-billing-details';
import {migratedLegacyBillIds} from './legacy-bill-migrations';
import {merchantAliases} from './merchant-identity';
import {historicalDirectorySnapshotKeys} from './historical-directory-snapshot';

export function outboundHistoryQueries(){const db=getDb();return [
 db.select({id:goodsOperations.id,result:goodsOperations.result,beforeRows:goodsOperations.beforeRows,afterRows:goodsOperations.afterRows,restoredAt:goodsOperations.restoredAt}).from(goodsOperations).where(eq(goodsOperations.kind,'outbound')),
 db.select({id:cartonOperations.id,receiptId:cartonOperations.receiptId,result:cartonOperations.result,fingerprint:cartonOperations.fingerprint,beforeSnapshot:cartonOperations.beforeSnapshot,afterSnapshot:cartonOperations.afterSnapshot,restoredAt:cartonOperations.restoredAt}).from(cartonOperations).where(eq(cartonOperations.kind,'outbound')),
 db.select({id:auditLogs.id,operationId:auditLogs.operationId,beforeSnapshot:auditLogs.beforeSnapshot,afterSnapshot:auditLogs.afterSnapshot,createdAt:auditLogs.createdAt}).from(auditLogs).where(sql.raw(DIRECT_OUTBOUND_AUDIT_PREDICATE)),
 ] as const;}
export async function readCorrectedOutboundHistory(){const db=getDb();const [goods,cartons,direct,settlements,rows]=await db.batch([...outboundHistoryQueries(),db.select().from(storageFeeSettlements),db.select().from(settings)]);const raw=buildOutboundHistory({goods,cartons,direct,settlements}),records=applyOutboundBillingDetails(applyOutboundCorrections(raw,rows),rows);return {records,settlements,settingsRows:rows,hiddenDirectoryKeys:historicalDirectorySnapshotKeys(raw,settlements,direct),migratedSettlementIds:migratedLegacyBillIds(settlements,raw,records,direct,merchantAliases(rows))};}

// Revision data only: never read large undo category snapshots. Used only when
// explicitly previewing/saving a financial ownership correction, not every report.
export const OUTBOUND_PREVIEW_GUARD_SQL=`SELECT json_object(
 'settings',(SELECT json_group_array(json_array(key,value,updated_at)) FROM (SELECT key,value,updated_at FROM settings ORDER BY key)),
 'stocks',(SELECT json_group_array(json_array(id,version,updated_at,total_quantity,total_boxes,customer_name,location_code,layer_count,inbound_date)) FROM (SELECT * FROM stocks ORDER BY id)),
 'cartons',(SELECT json_group_array(json_array(id,version,updated_at)) FROM (SELECT id,version,updated_at FROM carton_receipts ORDER BY id)),
 'goods',(SELECT json_group_array(json_array(id,restored_at)) FROM (SELECT id,restored_at FROM goods_operations ORDER BY id)),
 'cartonOps',(SELECT json_group_array(json_array(id,restored_at)) FROM (SELECT id,restored_at FROM carton_operations ORDER BY id)),
 'bills',(SELECT json_group_array(json_array(id,version,settlement_status,customer_name,fee_usd)) FROM (SELECT id,version,settlement_status,customer_name,fee_usd FROM storage_fee_settlements ORDER BY id)),
 'audits',(SELECT max(id) FROM audit_logs),
 'checkpoint',(SELECT value FROM layer_storage_checkpoints WHERE id=1)
) AS value`;
export async function outboundPreviewGuard(){return (await getDb().$client.prepare(OUTBOUND_PREVIEW_GUARD_SQL).first<{value:string}>())?.value??'';}
