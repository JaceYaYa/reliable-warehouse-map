import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
// Optimistic fence for read-only backups. Updated only when business data changes.
export const warehouseBackupRevision = sqliteTable("warehouse_backup_revision", {
 id: integer("id").primaryKey(), revision: integer("revision").notNull().default(0),
});
export const layerStorageCheckpoints = sqliteTable("layer_storage_checkpoints", {
  id: integer("id").primaryKey(), capturedAt: text("captured_at").notNull(),
  value: text("value").notNull(), auditHighId: integer("audit_high_id").notNull(),
});
export const warehouseSyncVersions = sqliteTable("warehouse_sync_versions", {
  resource: text("resource").primaryKey(), revision: text("revision").notNull(),
});
export const stocks = sqliteTable("stocks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  locationCode: text("location_code").notNull(), inboundDate: text("inbound_date").notNull(),
  product: text("product").notNull(), productPrefix: text("product_prefix").notNull().default(""), productCondition: text("product_condition").notNull().default(""), sku: text("sku").notNull().default(""), fnsku: text("fnsku").notNull().default(""), barcode: text("barcode").notNull().default(""),
  inboundOrder: text("inbound_order").notNull().default(""), totalQuantity: integer("total_quantity").notNull().default(0),
  inventoryUnit: text("inventory_unit").notNull().default("item"), inventoryReviewDecision: text("inventory_review_decision").notNull().default(""),
  totalBoxes: integer("total_boxes").notNull().default(0), customerName: text("customer_name").notNull().default(""),
  palletCount: real("pallet_count").notNull().default(1), palletLabel: text("pallet_label").notNull().default(""), layerCount: integer("layer_count").notNull().default(1),
  inboundSource: text("inbound_source").notNull().default("domestic"), billingMode: text("billing_mode").notNull().default("item"),
  itemVolumeM3: real("item_volume_m3").notNull().default(0), boxVolumeM3: real("box_volume_m3").notNull().default(0),
  storageRateUsd: real("storage_rate_usd").notNull().default(0.7), freeDays: integer("free_days").notNull().default(0),
  catalogItemId: integer("catalog_item_id"),
  note: text("note").notNull().default(""), updatedBy: text("updated_by").notNull().default(""),
  updatedAt: text("updated_at").notNull(), version: integer("version").notNull().default(0),
}, (table) => [index("stocks_location_code_idx").on(table.locationCode), index("stocks_updated_at_idx").on(table.updatedAt)]);
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(), value: text("value").notNull(), updatedAt: text("updated_at").notNull(),
});
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }), username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(), role: text("role").notNull().default("employee"),
  permissions: text("permissions"), permissionVersion: integer("permission_version").notNull().default(0),
  passwordHash: text("password_hash").notNull(), passwordSalt: text("password_salt").notNull(),
  active: integer("active").notNull().default(1), mustChange: integer("must_change").notNull().default(1),
  createdAt: text("created_at").notNull(),
});
export const sessions = sqliteTable("sessions", {
  tokenHash: text("token_hash").primaryKey(), userId: integer("user_id").notNull(),
  expiresAt: text("expires_at").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [index("sessions_expires_at_idx").on(table.expiresAt)]);
export const auditLogs = sqliteTable("audit_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }), userId: integer("user_id").notNull(),
  userName: text("user_name").notNull(), action: text("action").notNull(), entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull().default(""), operationId: text("operation_id"), summary: text("summary").notNull().default(""),
  beforeSnapshot: text("before_snapshot"), afterSnapshot: text("after_snapshot"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("audit_logs_action_id_idx").on(table.action, table.id), index("audit_logs_entity_id_idx").on(table.entityId, table.id), index("audit_logs_created_at_idx").on(table.createdAt), uniqueIndex("audit_logs_operation_id_idx").on(table.operationId), index("audit_logs_recent_sync_idx").on(table.id).where(sql`${table.action} IN ('入库','出库','移库','库存修改','删除','恢复','箱件收货','箱件出库','箱件认领改单','箱件删除','撤销箱件操作')`)]);

export const pricingCatalogItems = sqliteTable("pricing_catalog_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  identityKey: text("identity_key").notNull(),
  partnerName: text("partner_name").notNull().default(""), customerName: text("customer_name").notNull().default(""),
  product: text("product").notNull(), sku: text("sku").notNull().default(""), fnsku: text("fnsku").notNull().default(""), barcode: text("barcode").notNull().default(""),
  defaultBillingMode: text("default_billing_mode").notNull().default("item"),
  itemLengthCm: real("item_length_cm").notNull().default(0), itemWidthCm: real("item_width_cm").notNull().default(0), itemHeightCm: real("item_height_cm").notNull().default(0),
  itemVolumeM3: real("item_volume_m3").notNull().default(0),
  boxLengthCm: real("box_length_cm").notNull().default(0), boxWidthCm: real("box_width_cm").notNull().default(0), boxHeightCm: real("box_height_cm").notNull().default(0),
  boxVolumeM3: real("box_volume_m3").notNull().default(0),
  rateUsdM3Day: real("rate_usd_m3_day").notNull().default(0.7), freeDays: integer("free_days").notNull().default(0),
  active: integer("active").notNull().default(1), updatedBy: text("updated_by").notNull().default(""),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("pricing_catalog_identity_key_idx").on(table.identityKey),
  index("pricing_catalog_product_idx").on(table.product), index("pricing_catalog_sku_idx").on(table.sku),
  index("pricing_catalog_barcode_idx").on(table.barcode), index("pricing_catalog_updated_at_idx").on(table.updatedAt),
]);

export const storageFeeSettlements = sqliteTable("storage_fee_settlements", {
  id: integer("id").primaryKey({ autoIncrement: true }), stockId: integer("stock_id").notNull(),
  operationId: text("operation_id"), catalogItemId: integer("catalog_item_id"), locationCode: text("location_code").notNull(),
  inboundSource: text("inbound_source").notNull().default("return"), billingMode: text("billing_mode").notNull().default("item"),
  product: text("product").notNull(), sku: text("sku").notNull().default(""), fnsku: text("fnsku").notNull().default(""), barcode: text("barcode").notNull().default(""), inboundOrder: text("inbound_order").notNull().default(""),
  customerName: text("customer_name").notNull().default(""), inboundDate: text("inbound_date").notNull(), outboundAt: text("outbound_at").notNull(),
  quantity: integer("quantity").notNull().default(0), boxes: integer("boxes").notNull().default(0),
  itemVolumeM3: real("item_volume_m3").notNull().default(0), boxVolumeM3: real("box_volume_m3").notNull().default(0),
  rateUsdM3Day: real("rate_usd_m3_day").notNull().default(0.7), freeDays: integer("free_days").notNull().default(0),
  storageDays: integer("storage_days").notNull().default(0), billableDays: integer("billable_days").notNull().default(0),
  totalVolumeM3: real("total_volume_m3").notNull().default(0), feeUsd: real("fee_usd").notNull().default(0),
  settlementStatus: text("settlement_status").notNull().default("settled"),
  settledAt: text("settled_at"), settledBy: text("settled_by"), version: integer("version").notNull().default(0),
  previousInboundSource: text("previous_inbound_source"), previousBillingMode: text("previous_billing_mode"),
  previousItemVolumeM3: real("previous_item_volume_m3"), previousBoxVolumeM3: real("previous_box_volume_m3"),
  previousStorageRateUsd: real("previous_storage_rate_usd"), previousFreeDays: integer("previous_free_days"),
  previousCatalogItemId: integer("previous_catalog_item_id"), stockUpdatedAtBefore: text("stock_updated_at_before"),
  stockUpdatedAtAfter: text("stock_updated_at_after"),
  operatedBy: text("operated_by").notNull().default(""), createdAt: text("created_at").notNull(),
}, (table) => [
  index("storage_fee_stock_idx").on(table.stockId), index("storage_fee_outbound_at_idx").on(table.outboundAt),
  index("storage_fee_customer_idx").on(table.customerName), index("storage_fee_product_idx").on(table.product),
  index("storage_fee_status_customer_idx").on(table.settlementStatus, table.customerName),
  uniqueIndex("storage_fee_operation_id_idx").on(table.operationId),
]);

export const goodsFlowState = sqliteTable("goods_flow_state", {
  id: integer("id").primaryKey(), revision: integer("revision").notNull().default(0), value: text("value").notNull(),
});
export const goodsOperations = sqliteTable("goods_operations", {
  id: text("id").primaryKey(), kind: text("kind").notNull(), categoryId: text("category_id").notNull(), fingerprint: text("fingerprint").notNull(),
  beforeCategory: text("before_category"), afterCategory: text("after_category").notNull(), beforeRows: text("before_rows").notNull(), afterRows: text("after_rows").notNull(),
  settlementIds: text("settlement_ids").notNull().default("[]"), result: text("result").notNull(), createdAt: text("created_at").notNull(), restoredAt: text("restored_at"),
});
export const goodsTransactionGuards = sqliteTable("goods_transaction_guards", { id: text("id").primaryKey(), valid: integer("valid").notNull() });

export const cartonReceipts = sqliteTable("carton_receipts", {
 id:text("id").primaryKey(),inboundOrder:text("inbound_order").notNull(),originalOrder:text("original_order").notNull(),orderHistory:text("order_history").notNull(),
 customerName:text("customer_name").notNull().default(""),inboundDate:text("inbound_date").notNull(),placements:text("placements").notNull(),note:text("note").notNull().default(""),version:integer("version").notNull().default(0),
 createdBy:integer("created_by").notNull(),createdAt:text("created_at").notNull(),updatedBy:integer("updated_by").notNull(),updatedAt:text("updated_at").notNull(),
},table=>[index("carton_receipts_customer_idx").on(table.customerName,table.inboundDate)]);
export const cartonOperations = sqliteTable("carton_operations", {
 id:text("id").primaryKey(),receiptId:text("receipt_id").notNull(),kind:text("kind").notNull(),fingerprint:text("fingerprint").notNull(),beforeSnapshot:text("before_snapshot"),afterSnapshot:text("after_snapshot"),result:text("result").notNull(),
 userId:integer("user_id").notNull(),createdAt:text("created_at").notNull(),restoredAt:text("restored_at"),
},table=>[index("carton_operations_receipt_idx").on(table.receiptId,table.createdAt)]);
export const cartonTransactionGuards=sqliteTable("carton_transaction_guards",{id:text("id").primaryKey(),valid:integer("valid").notNull()});

export const workOrders = sqliteTable("work_orders", {
  id:text("id").primaryKey(),number:text("number").notNull().unique(),kind:text("kind").notNull(),title:text("title").notNull(),
  customerName:text("customer_name").notNull().default(""),employeeBody:text("employee_body").notNull().default(""),payload:text("payload").notNull().default("{}"),fileIds:text("file_ids").notNull().default("[]"),
  status:text("status").notNull().default("draft"),assignedTo:text("assigned_to").notNull().default(""),version:integer("version").notNull().default(0),
  createdBy:integer("created_by").notNull(),createdAt:text("created_at").notNull(),updatedBy:integer("updated_by").notNull(),updatedAt:text("updated_at").notNull(),
},table=>[index("work_orders_status_updated_idx").on(table.status,table.updatedAt),index("work_orders_assigned_idx").on(table.assignedTo,table.status)]);
export const workOrderEvents = sqliteTable("work_order_events", {
  id:text("id").primaryKey(),orderId:text("order_id").notNull(),action:text("action").notNull(),userId:integer("user_id").notNull(),userName:text("user_name").notNull(),summary:text("summary").notNull().default(""),
  mutationId:text("mutation_id").notNull().unique(),requestHash:text("request_hash").notNull(),result:text("result").notNull(),createdAt:text("created_at").notNull(),
},table=>[index("work_order_events_order_idx").on(table.orderId,table.createdAt)]);
export const workOrderFiles = sqliteTable("work_order_files", {
  id:text("id").primaryKey(),orderId:text("order_id").notNull().default(""),objectKey:text("object_key").notNull(),name:text("name").notNull(),mime:text("mime").notNull(),size:integer("size").notNull(),hash:text("hash").notNull(),
  visibility:text("visibility").notNull().default("source"),createdBy:integer("created_by").notNull(),createdAt:text("created_at").notNull(),
},table=>[index("work_order_files_order_idx").on(table.orderId)]);
