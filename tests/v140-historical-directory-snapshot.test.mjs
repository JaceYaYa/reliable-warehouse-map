import test from 'node:test';
import assert from 'node:assert/strict';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';

const existing=[
 ['CC',99,121,'5bf02184-cf8a-4eb4-9205-3a0f37a42b82'],
 ['QT-XZX',269,154,'1c04896e-1b0f-4d0e-a6db-8cb17166b4ba'],
 ['SX',127,94,'13bcfba0-31be-4332-9199-7b0e08e79050'],
 ['TH',9,256,'bcd1ad7c-f5dc-4eb3-a858-113c0ea2647a'],
 ['XRJ1668',128,93,'5d3fd874-d4ac-4607-8335-927e5dceaf11'],
 ['XRJ1688',129,91,'6e778d24-6bd4-4700-a74f-240200f7fccb'],
 ['ZY',68,330,'ee3ca804-f18a-4e4f-8da2-760784bf3eef'],
];
function setup(){const h=warehouseApiHarness({layerPricing:true});h.seedUser(1,null,'admin','boss');return h;}
function archived(h,[name,id,stockId,op],journal=true){
 h.sqlite.prepare("INSERT INTO storage_fee_settlements(id,stock_id,operation_id,location_code,product,customer_name,inbound_date,outbound_at,quantity,boxes,settlement_status,fee_usd,version,created_at,settled_at) VALUES(?,?,?,'A1','旧货',?,'2026-01-01','2026-02-01',10,2,'settled',99,1,'old','confirmed')").run(id,stockId,op,name);
 if(journal)outbound(h,name,stockId,op,id+10000);
}
function outbound(h,name,stockId,op,id){
 const before={id:stockId,customerName:name,locationCode:'A1',layerCount:1,product:'旧货',sku:'S',inboundDate:'2026-01-01',physicalOutboundDate:'2026-02-01',totalQuantity:10,totalBoxes:2};
 h.sqlite.prepare("INSERT INTO audit_logs(id,user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at) VALUES(?,1,'老板','出库','库存',?,?,'出货',?,?,'2026-02-01T12:00:00Z')").run(id,String(stockId),op,JSON.stringify(before),JSON.stringify({...before,totalQuantity:0,totalBoxes:0}));
}

test('only the selected existing legacy customers disappear; their raw history and fee calculations remain available',async()=>{
 const h=setup();try{
  for(const row of existing)archived(h,row);
  const before=JSON.stringify(h.sqlite.prepare('SELECT * FROM storage_fee_settlements').all());
  const d=await h.call('pricing/customers');assert.equal(d.status,200);for(const[name]of existing)assert.ok(!d.data.customers.includes(name),name);
  const r=await h.call('pricing/layers/report?customer=TH&fromDate=2026-01-01&toDate=2026-02-02&asOf=2026-03-01');
  assert.equal(r.status,200);assert.equal(r.data.outboundHistory.length,1);assert.equal(r.data.confirmedHistory.count,1);
  assert.equal(JSON.stringify(h.sqlite.prepare('SELECT * FROM storage_fee_settlements').all()),before);
 }finally{h.sqlite.close();}
});

test('a new shipment of each same customer makes it selectable again, even with the same stock and an old business date',async()=>{
 const h=setup();try{
  for(const row of existing)archived(h,row);
  for(const [name,,stock]of existing)outbound(h,name,stock,'future-operation:'+name,20000+stock);
  const d=await h.call('pricing/customers');assert.equal(d.status,200);for(const[name]of existing)assert.ok(d.data.customers.includes(name),name);
 }finally{h.sqlite.close();}
});

test('current inventory and new settlement-only shipments remain selectable under old customer names',async()=>{
 const h=setup();try{
  for(const row of existing)archived(h,row,false);
  const id=h.stock();h.sqlite.prepare("UPDATE stocks SET customer_name='QT-XZX' WHERE id=?").run(id);
  archived(h,['SX',5000,94,'new-settlement-operation'],false);
  const d=await h.call('pricing/customers');assert.ok(d.data.customers.includes('QT-XZX'));assert.ok(d.data.customers.includes('SX'));assert.ok(!d.data.customers.includes('TH'));const cc=h.stock();h.sqlite.prepare("UPDATE stocks SET customer_name='CC' WHERE id=?").run(cc);assert.ok((await h.call('pricing/customers')).data.customers.includes('CC'));
 }finally{h.sqlite.close();}
});

test('matching only an old settlement ID or customer name cannot hide a different operation',async()=>{
 const h=setup();try{
  archived(h,['TH',9,256,'different-operation']);
  const d=await h.call('pricing/customers');assert.ok(d.data.customers.includes('TH'));
 }finally{h.sqlite.close();}
});
