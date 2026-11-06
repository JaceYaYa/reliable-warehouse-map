import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
const h=warehouseApiHarness(),drafts=h.load(resolve('lib/goods-operation-draft.ts'));
const spec={billingMode:'item',itemLengthCm:10,itemWidthCm:0,itemHeightCm:0,boxLengthCm:0,boxWidthCm:0,boxHeightCm:0,itemVolumeM3:0,boxVolumeM3:0};
const base=()=>({version:1,mode:'outbound',customer:'客户A',query:'',lines:[{choiceKey:'group-a',product:'饭盒',inventoryUnit:'item',quantity:'',boxes:'0',receipt:{inboundSource:'domestic',productSpec:spec,sku:'SKU1',fnsku:'',barcode:'',productPrefix:'#1',productCondition:'good'},placements:[],picks:{174:{quantity:'7',boxes:'0'}},autoPlacement:false,pickCondition:'all'}],inboundDate:'2026-10-03',inboundOrder:'',note:'待继续',receiptSource:'inherit',creating:false,newCustomer:'',newProduct:'',newSku:'',newBarcode:'',newSpec:spec,pending:null});
test('multi-customer drafts retain per-line ownership and empty references while accepting legacy fields',()=>{
 const value=base();value.lines[0].customerName='客户A';value.lines[0].receipt.inboundOrder='客户A单号';value.lines[0].receipt.note='A备注';
 value.lines.push({...value.lines[0],choiceKey:'group-b',customerName:'客户B',receipt:{...value.lines[0].receipt,inboundOrder:'',note:''}});
 const restored=drafts.parseGoodsOperationDraft(JSON.stringify(value),'outbound');assert.deepEqual(JSON.parse(JSON.stringify(restored)),value);
 for(const invalid of [{customerName:3},{receipt:{...value.lines[0].receipt,note:3}}])assert.equal(drafts.parseGoodsOperationDraft(JSON.stringify({...base(),lines:[{...value.lines[0],...invalid}]}),'outbound'),null);
 assert(drafts.parseGoodsOperationDraft(JSON.stringify(base()),'outbound'));
});
test('combined barcode rows and the selected outgoing date survive unfinished draft storage',()=>{
 const value=base();value.outboundDate='2026-10-02';value.newBarcodes=['A',''];value.lines[0].receipt.barcodes=['LEGACY-FNSKU','LEGACY-CODE',''];
 assert.deepEqual(JSON.parse(JSON.stringify(drafts.parseGoodsOperationDraft(JSON.stringify(value),'outbound'))),value);
 for(const codes of [null,[3],Array(21).fill('X')])assert.equal(drafts.parseGoodsOperationDraft(JSON.stringify({...value,newBarcodes:codes}),'outbound'),null);
 assert.equal(drafts.parseGoodsOperationDraft(JSON.stringify({...value,outboundDate:3}),'outbound'),null);
});
test('unfinished inputs and per-location allocations survive storage; modes/accounts have separate keys',()=>{
 const value=base(),restored=drafts.parseGoodsOperationDraft(JSON.stringify(value),'outbound');assert.deepEqual(JSON.parse(JSON.stringify(restored)),value);assert.equal(restored.lines[0].quantity,'');assert.equal(restored.newSpec.itemWidthCm,0);assert.equal(drafts.parseGoodsOperationDraft(JSON.stringify(value),'inbound'),null);assert.notEqual(drafts.goodsDraftKey(1,'inbound'),drafts.goodsDraftKey(1,'outbound'));assert.notEqual(drafts.goodsDraftKey(1,'inbound'),drafts.goodsDraftKey(2,'inbound'));assert.equal('members' in restored.lines[0],false);
});
test('pending operation retains exact original identity and payload; mismatched mode/path never replays',()=>{
 const value=base();value.pending={kind:'document',path:'/api/goods/document',body:{mode:'outbound',requestId:'same-original-request',expectedRevision:4,lines:[{selected:[{id:174,version:8,quantity:'7',boxes:'0'}]}]}};
 const restored=drafts.parseGoodsOperationDraft(JSON.stringify(value),'outbound');assert.deepEqual(JSON.parse(JSON.stringify(restored.pending)),value.pending);
 for(const patch of [{path:'/api/stocks'},{kind:'create'},{body:{mode:'inbound',requestId:'x'}},{body:{mode:'outbound',requestId:''}}]){assert.equal(drafts.parseGoodsOperationDraft(JSON.stringify({...value,pending:{...value.pending,...patch}}),'outbound'),null);}
});
test('malformed saved data fails safely instead of reaching the editor',()=>{
 for(const value of [null,[],{}, {...base(),lines:[null]}, {...base(),lines:[{...base().lines[0],picks:{x:{quantity:'1',boxes:'0'}}}]}, {...base(),lines:[{...base().lines[0],receipt:null}]}, {...base(),newSpec:{...spec,itemLengthCm:'bad'}}, {...base(),lines:Array(26).fill(base().lines[0])}])assert.equal(drafts.parseGoodsOperationDraft(JSON.stringify(value),'outbound'),null);
 assert.equal(drafts.parseGoodsOperationDraft('{bad','outbound'),null);
});
test('warehouse labels display location layer date and customer reference instead of internal IDs',()=>{
 assert.equal(drafts.goodsStockLabel({id:174,locationCode:'B2',layerCount:2,inboundDate:'2026-02-19',inboundOrder:'ASN-3'}),'B2 · 第 2 层 · 入库 2026-02-19 · 入库单号 ASN-3');
});

test('legacy inherited placement details become explicit once, so clearing a marker survives reopening',()=>{
 const line=base().lines[0];line.placements=[{key:'a',locationCode:'A1',layerCount:'1',quantity:'7',boxes:'0',productPrefix:'',productCondition:''},{key:'b',locationCode:'A2',layerCount:'1',quantity:'3',boxes:'0',productPrefix:'右侧',productCondition:'damaged'}];
 const migrated=drafts.explicitGoodsPlacements(line);
 assert.deepEqual(migrated.placements.map(p=>[p.productPrefix,p.productCondition]),[['#1','good'],['右侧','damaged']]);
 assert.equal(migrated.receipt.productPrefix,'');assert.equal(migrated.receipt.productCondition,'');
 migrated.placements[0].productPrefix='';assert.equal(drafts.explicitGoodsPlacements(migrated).placements[0].productPrefix,'');assert.equal(line.receipt.productPrefix,'#1');
});
test('another placement copies condition and marker but requires a separate location and quantity',()=>{
 const first=drafts.nextGoodsPlacement(undefined,'first');assert.equal(first.productCondition,'');assert.equal(first.productPrefix,'');
 const next=drafts.nextGoodsPlacement({...first,locationCode:'A4',quantity:'8',boxes:'2',productCondition:'damaged',productPrefix:'#1 左边'},'second');
 assert.deepEqual(JSON.parse(JSON.stringify(next)),{key:'second',locationCode:'',layerCount:'1',quantity:'0',boxes:'0',palletCount:'1',productPrefix:'#1 左边',productCondition:'damaged',barcodes:[]});
});

test('location barcode edits remain local; legacy receipt aliases migrate once and empty edits stay empty',()=>{
 const line=base().lines[0];line.receipt.fnsku='OLD-FN';line.receipt.barcode='OLD-CODE';line.placements=[{key:'a',locationCode:'A1',layerCount:'1',quantity:'7',boxes:'0',productPrefix:'',productCondition:''},{key:'b',locationCode:'A2',layerCount:'1',quantity:'3',boxes:'0',productPrefix:'',productCondition:'good',barcodes:['LOCAL-B']}];
 const migrated=drafts.explicitGoodsPlacements(line);assert.deepEqual([...migrated.placements[0].barcodes],['OLD-FN','OLD-CODE']);assert.deepEqual([...migrated.placements[1].barcodes],['LOCAL-B']);migrated.placements[0].barcodes=[];
 assert.deepEqual([...drafts.explicitGoodsPlacements(migrated).placements[0].barcodes],[]);assert.deepEqual([...drafts.nextGoodsPlacement(migrated.placements[1],'c').barcodes],[]);
 const value={...base(),mode:'inbound',lines:[migrated]};assert(drafts.parseGoodsOperationDraft(JSON.stringify(value),'inbound'));value.lines[0].placements[0].barcodes=[3];assert.equal(drafts.parseGoodsOperationDraft(JSON.stringify(value),'inbound'),null);
});
test('receiving needs an explicit source and condition for each location, while choosing none is valid',()=>{
 const line=base().lines[0];line.receipt.inboundSource='';line.placements=[drafts.nextGoodsPlacement(undefined,'a')];
 assert.match(drafts.goodsInboundDetailsProblem(line),/来源/);line.receipt.inboundSource='unspecified';assert.match(drafts.goodsInboundDetailsProblem(line),/正品.*残次品/);
 line.placements[0].productCondition='good';assert.equal(drafts.goodsInboundDetailsProblem(line),'');line.placements.push(drafts.nextGoodsPlacement(line.placements[0],'b'));assert.equal(drafts.goodsInboundDetailsProblem(line),'');line.placements[1].productCondition='';assert.match(drafts.goodsInboundDetailsProblem(line),/正品.*残次品/);
});

test('product SKU changes remap other-mode drafts without losing allocations or altering pending requests',()=>{
 const value=base(),changed=drafts.remapGoodsDraftSku(value,'group-a','category:new','CORE');
 assert.equal(changed.lines[0].choiceKey,'category:new');assert.equal(changed.lines[0].receipt.sku,'CORE');assert.deepEqual(changed.lines[0].picks,value.lines[0].picks);assert.equal(changed.lines[0].quantity,'');assert.equal(value.lines[0].choiceKey,'group-a');
 value.pending={path:'/api/goods/document',kind:'document',body:{requestId:'original',mode:'outbound',lines:[]}};assert.equal(drafts.remapGoodsDraftSku(value,'group-a','category:new','CORE'),value);
});

test('待出库限制和未知移库原请求随草稿保存，仅出库允许重试移库',()=>{
 const value=base();Object.assign(value.lines[0],{stagingTaskId:'stage-1',allowedStockIds:[174]});value.pending={kind:'staging',path:'/api/goods/staging',body:{requestId:'original-stage',expectedRevision:4,targetLocation:'A1',targetLayerCount:2,lines:[{lineId:'a'}]}};
 assert.deepEqual(JSON.parse(JSON.stringify(drafts.parseGoodsOperationDraft(JSON.stringify(value),'outbound'))),value);
 assert.equal(drafts.parseGoodsOperationDraft(JSON.stringify({...value,mode:'inbound'}),'inbound'),null);
 for(const allowedStockIds of [[174,174],[-1],['174']])assert.equal(drafts.parseGoodsOperationDraft(JSON.stringify({...value,lines:[{...value.lines[0],allowedStockIds}]}),'outbound'),null);
});
