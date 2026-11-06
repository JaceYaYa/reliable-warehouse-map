import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';

async function domain() {
  const result = await import('../lib/layer-storage.ts').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw error;
  });
  assert.ok(result, 'layer storage domain module must exist');
  return result;
}
const zones = [
  {id:'Y',title:'一件代发室',codes:['配送1','Y-1','D1']},
  {id:'MY_OTHER',title:'其他区',codes:['MY1','Y-OTHER']},
];
const config = (locations = {}) => ({schemaVersion:1,revision:0,locations});
const occupant = (overrides = {}) => ({id:'stock:1',kind:'stock',locationCode:'A1',layer:1,
  customerName:'甲',inboundDate:'2026-10-02',productName:'苹果',sku:'SKU1',...overrides});

test('empty config is independent, JSON supported, and missing legacy state never becomes a free default', async () => {
  const d = await domain(), a = d.emptyLayerPricingConfig(), b = d.emptyLayerPricingConfig();
  a.locations.A1 = {layers:{}};
  assert.deepEqual(b, config());
  assert.deepEqual(d.parseLayerPricingConfig(JSON.stringify(config())), config());
  for (const raw of [undefined,null,'',false,[],{},'not JSON',{schemaVersion:0,revision:0,locations:{}},
    {...config(),legacyRate:1},{schemaVersion:1,revision:-1,locations:{}},{...config(),revision:1.5}]) {
    assert.throws(() => d.parseLayerPricingConfig(raw));
  }
});

test('exact builtin layer boundaries and formal zone identity give one volume with the declared priority', async () => {
  const d = await domain();
  const cases = [['A1',1,2],['D1',1,1],['D32',2,1],['D32',3,2],['D33',1,2],['D0',1,2],
    ['D01',1,2],['XD1',1,2],['C1',3,1],['C8',3,1],['C9',1,2],['C8',4,2],
    ['E1',4,1],['E6',4,1],['E7',1,2],['E6',5,2],['配送1',10000,.2],['Y-1',2,.2],
    ['MY1',1,2],['Y-OTHER',1,2],['D1',2,1],['D1',3,.2]];
  for (const [code,layer,expected] of cases) assert.equal(d.resolveLayerVolume(config(),code,layer,zones).volumeM3,expected,`${code}/${layer}`);
  assert.equal(d.resolveLayerVolume(config(),'Y-1',1,[{id:'OTHER',title:'其他',codes:['Y-1']}]).volumeM3,2);
  const c = config({D1:{defaultVolumeM3:3,layers:{'2':{volumeM3:.75}}}});
  assert.deepEqual(d.resolveLayerVolume(c,'D1',2,zones),{volumeM3:.75,volumeSource:'layer'});
  assert.deepEqual(d.resolveLayerVolume(c,'D1',1,zones),{volumeM3:3,volumeSource:'location'});
  assert.equal(d.resolveLayerVolume(config(),'A1',1,[]).volumeSource,'default');
});

test('normalized aliases preserve old rules and collapse both origins and multiple SKUs into a single occupied layer', async () => {
  const d = await domain(), aliases = {'旧A1':'A1','A1':'A-01'};
  const c = config({'旧A1':{defaultVolumeM3:3,layers:{'2':{volumeM3:.8}}}});
  const rows = [occupant({locationCode:'旧A1',layer:2}),occupant({id:'carton:1',kind:'carton',locationCode:'A1',layer:2,productName:'梨',sku:'SKU2',inboundDate:'2026-09-01'}),
    occupant({id:'stock:2',locationCode:' Ａ-０１ ',layer:2,productName:'苹果',palletCount:999})];
  const before = structuredClone({c,rows,aliases});
  const [group] = d.groupLayerOccupancy(rows,c,[],aliases);
  assert.equal(group.locationCode,'A-01'); assert.equal(group.key,'["A-01",2]');
  assert.equal(group.volumeM3,.8); assert.equal(group.occupants.length,3);
  assert.deepEqual(group.customers,[{customerName:'甲',oldestInboundDate:'2026-09-01',products:['苹果','梨'],recordIds:['stock:1','carton:1','stock:2']}]);
  assert.deepEqual(group.shares,[{customerName:'甲',percent:100}]); assert.deepEqual(group.reviewReasons,[]);
  assert.deepEqual({c,rows,aliases},before);
  assert.equal(d.groupLayerOccupancy([],c,[],aliases).length,0);
});

test('occupancy sorting is natural by location and descending by layer without generating absent layers', async () => {
  const d = await domain();
  const rows = [occupant({locationCode:'A10'}),occupant({id:'2',locationCode:'A2',layer:1}),occupant({id:'3',locationCode:'A2',layer:10000})];
  assert.deepEqual(d.groupLayerOccupancy(rows,config(),[]).map(g=>[g.locationCode,g.layer]),[['A2',10000],['A2',1],['A10',1]]);
});

test('every actual mixed customer receives the full layer while legacy shares remain untouched metadata', async () => {
  const d = await domain(), rows = [occupant(),occupant({id:'carton:1',kind:'carton',customerName:'乙'})];
  const project = shares => d.groupLayerOccupancy(rows,config({A1:{layers:{'1':{shares}}}}),[])[0];
  const full = [{customerName:'甲',percent:100},{customerName:'乙',percent:100}];
  assert.deepEqual(d.groupLayerOccupancy(rows,config(),[])[0].shares,full);
  assert.deepEqual(d.groupLayerOccupancy(rows,config(),[])[0].reviewReasons,[]);
  const shares = [{customerName:'甲',percent:0},{customerName:'乙',percent:100}];
  assert.deepEqual(project(shares).shares,full);
  assert.deepEqual(shares,[{customerName:'甲',percent:0},{customerName:'乙',percent:100}]);
  const stale = project([{customerName:'甲',percent:50},{customerName:'丙',percent:50}]);
  assert.deepEqual(stale.shares,full); assert.deepEqual(stale.reviewReasons,[]);
  const three = [...rows,occupant({id:'stock:3',customerName:'丙'})];
  const thirds = [{customerName:'甲',percent:33.33},{customerName:'乙',percent:33.33},{customerName:'丙',percent:33.34}];
  assert.deepEqual(d.groupLayerOccupancy(three,config({A1:{layers:{'1':{shares:thirds}}}}),[])[0].shares,thirds.map(s=>({...s,percent:100})));
  assert.equal(d.groupLayerOccupancy(three,config({A1:{layers:{'1':{shares}}}}),[])[0].shares.length,3);
});

test('unclaimed occupants remain occupied and pending even beside a named customer', async () => {
  const d = await domain();
  for (const rows of [[occupant({customerName:''})],[occupant(),occupant({id:'2',customerName:'  '})]]) {
    const [group] = d.groupLayerOccupancy(rows,config(),[]);
    assert.equal(group.volumeM3,2); assert.ok(group.shares.every(s=>s.percent===100));
    assert.ok(group.reviewReasons.includes('unclaimed-customer'));
    assert.equal(group.occupants.length,rows.length);
  }
});

test('conflicting legacy shares on aliased config names cannot block full-layer billing',async()=>{
  const d=await domain(),c=config({OLD:{layers:{'1':{volumeM3:3,shares:[{customerName:'甲',percent:100}]}}},A1:{layers:{'1':{volumeM3:3,shares:[{customerName:'乙',percent:100}]}}}}),before=structuredClone(c);
  const [group]=d.groupLayerOccupancy([occupant({locationCode:'OLD'}),occupant({id:'stock:2',customerName:'乙'})],c,[],{OLD:'A1'});
  assert.equal(group.volumeM3,3);assert.deepEqual(group.shares,[{customerName:'甲',percent:100},{customerName:'乙',percent:100}]);assert.deepEqual(c,before);
});

test('palletCount never influences occupancy volume or customer attribution', async () => {
  const d = await domain();
  for (const palletCount of [0,.25,100,undefined,null,NaN]) {
    const [group] = d.groupLayerOccupancy([occupant({palletCount}),occupant({id:'2',sku:'OTHER',palletCount})],config(),[]);
    assert.equal(group.volumeM3,2); assert.equal(group.occupants.length,2);
    assert.deepEqual(group.shares,[{customerName:'甲',percent:100}]);
  }
});

test('strict numeric rules reject invalid volumes layers shares and revisions without coercion', async () => {
  const d = await domain();
  for (const volume of [0,-1,NaN,Infinity,-Infinity,1e6+1,'2',null,true]) {
    assert.throws(()=>d.parseLayerPricingConfig(config({A1:{defaultVolumeM3:volume,layers:{}}})));
    assert.throws(()=>d.parseLayerPricingConfig(config({A1:{layers:{'1':{volumeM3:volume}}}})));
  }
  for (const layer of ['0','-1','1.2','01','1e2','10001','NaN','']) assert.throws(()=>d.parseLayerPricingConfig(config({A1:{layers:{[layer]:{volumeM3:1}}}})));
  for (const layer of [0,-1,1.5,NaN,Infinity,10001,'1']) assert.throws(()=>d.groupLayerOccupancy([occupant({layer})],config(),[]));
  for (const percent of [-1,NaN,Infinity,101,'100',null]) assert.throws(()=>d.parseLayerPricingConfig(config({A1:{layers:{'1':{shares:[{customerName:'甲',percent}]}}}})));
  for (const shares of [[],[{customerName:'甲',percent:99.99}],[{customerName:'甲',percent:50},{customerName:'甲',percent:50}],[{customerName:'',percent:100}],[{customerName:'  ',percent:100}]]) assert.throws(()=>d.parseLayerPricingConfig(config({A1:{layers:{'1':{shares}}}})));
  assert.doesNotThrow(()=>d.parseLayerPricingConfig(config({A1:{defaultVolumeM3:1e6,layers:{'10000':{volumeM3:.000001,shares:[{customerName:'甲',percent:99.9999995}]}}}})));
  assert.throws(()=>d.parseLayerPricingConfig(config({A1:{layers:{'1':{shares:[{customerName:'甲',percent:99.999998}]}}}})));
});

test('prototype keys, inherited records, unknown properties and canonical key collisions fail safely', async () => {
  const d = await domain();
  for (const raw of [JSON.parse('{"schemaVersion":1,"revision":0,"locations":{"__proto__":{"layers":{}}}}'),
    config({constructor:{layers:{}}}),config(Object.create({A1:{layers:{}}})),config({A1:{layers:{},unknown:1}}),
    config({A1:{layers:{'1':{volumeM3:1,extra:1}}}}),config({A1:{layers:{'1':{shares:[{customerName:'甲',percent:100,extra:1}]}}}}),
    config({A1:{layers:{}},' Ａ１ ':{layers:{}}})]) assert.throws(()=>d.parseLayerPricingConfig(raw));
  assert.equal({}.polluted,undefined);
  assert.throws(()=>d.resolveLayerVolume(config(),'A1',1,[],{'a1':'B1',' Ａ１ ':'C1'}));
  assert.throws(()=>d.resolveLayerVolume(config(),'A1',1,[],{A1:'A2',A2:'A1'}));
  assert.throws(()=>d.resolveLayerVolume(config({OLD:{layers:{'1':{volumeM3:1}}},A1:{layers:{'1':{volumeM3:2}}}}),'A1',1,[],{OLD:'A1'}));
  assert.equal(d.resolveLayerVolume(config({OLD:{layers:{'1':{volumeM3:1}}},A1:{layers:{'2':{volumeM3:3}}}}),'A1',1,[],{OLD:'A1'}).volumeM3,1);
});

test('share arrays reject sparse/accessor/inherited payloads before reading customer entries', async () => {
  const d = await domain();
  const valid = {customerName:'甲',percent:100};
  const sparse = [valid]; sparse.length = 2;
  const accessor = [valid]; Object.defineProperty(accessor,'0',{get(){throw new Error('getter executed');},enumerable:true});
  const inherited = [valid]; Object.setPrototypeOf(inherited,{...Array.prototype});
  const extra = [valid]; extra.metadata = 'unexpected';
  for (const shares of [sparse,accessor,inherited,extra]) {
    assert.throws(()=>d.parseLayerPricingConfig(config({A1:{layers:{'1':{shares}}}})),error=>error instanceof Error && !error.message.includes('getter executed'));
  }
});

test('plain config aliases and shares from sibling module realms are accepted without accepting inherited data', async () => {
  const d = await domain();
  const c = runInNewContext('({schemaVersion:1,revision:0,locations:{OLD:{layers:{1:{volumeM3:3,shares:[{customerName:"甲",percent:100}]}}}}})');
  const aliases = runInNewContext('({OLD:"A1"})');
  assert.equal(d.resolveLayerVolume(c,'OLD',1,[],aliases).volumeM3,3);
  assert.equal(d.groupLayerOccupancy([occupant()],c,[],aliases)[0].shares[0].percent,100);
  assert.throws(()=>d.parseLayerPricingConfig(runInNewContext('Object.assign(Object.create({schemaVersion:1}),{revision:0,locations:{}})')));
});
