import assert from 'node:assert/strict';
import test from 'node:test';
import { locationRouteHarness, editableZones } from './helpers/location-route-harness.mjs';
import { createLocationEditor, planLocationEdits } from '../lib/location-editor.ts';
import { upgradeBackupLocationNames, resolveLocationAlias } from '../lib/location-aliases.ts';

test('stable row identity handles rename, addition, deletion and reorder in one edit', () => {
  const original=editableZones(), draft=createLocationEditor(original);
  draft[0].rows=[draft[0].rows[2], {...draft[0].rows[0],code:'新B1'}, {id:'new',code:'B4'}];
  const plan=planLocationEdits(draft);
  assert.deepEqual(plan.renames,{B1:'新B1'});
  assert.deepEqual(plan.zones[0].codes,['B3','新B1','B4']);
  assert.deepEqual(plan.zones[0].layout.新B1,original[0].layout.B1);
  assert.deepEqual(plan.zones[0].layout.B3,original[0].layout.B3);
  assert.equal(plan.zones[0].layout.B4,undefined);
  assert.deepEqual(original,editableZones());
});
test('editor rejects same-zone duplicates, case/fullwidth duplicates and blank entries', () => {
  for(const code of ['B2','b2','Ｂ２','   ']) {
    const draft=createLocationEditor(editableZones());draft[0].rows[0].code=code;
    assert.throws(()=>planLocationEdits(draft),/重复|不能为空/);
  }
  assert.throws(()=>planLocationEdits([]),/至少保留/);
});
function setup() {
  const h=locationRouteHarness();h.setting('warehouse_zones',editableZones());h.setting('warehouse_location_aliases',{新B1:'B1',新B2:'B2',新B3:'B3'});
  return h;
}
async function edit(h, mutate) {
  const snapshot=await h.get(),draft=createLocationEditor(snapshot.zones);mutate(draft);
  return h.post({...planLocationEdits(draft),canvas:snapshot.canvas,expectedRevision:snapshot.revision});
}
test('real route saves B1 → 新B1 → B1 repeatedly with stock, billing, geometry and history intact',async()=>{
  const h=setup();try {
    h.stock('B1');
    const cols=h.sqlite.prepare('PRAGMA table_info(storage_fee_settlements)').all().filter(c=>c.notnull&&c.dflt_value===null&&!c.pk);
    h.sqlite.prepare(`INSERT INTO storage_fee_settlements(${cols.map(c=>c.name)}) VALUES (${cols.map(()=>'?')})`).run(...cols.map(c=>c.name==='location_code'?'B1':c.type==='integer'?1:'test'));
    const before=h.sqlite.prepare('SELECT * FROM stocks').get(),fee=h.sqlite.prepare('SELECT * FROM storage_fee_settlements').get();
    for(const code of ['新B1','B1','新B1','B1']) {
      const result=await edit(h,d=>{d[0].rows[0].code=code});assert.equal(result.status,200,JSON.stringify(result.data));
      assert.deepEqual({...h.sqlite.prepare('SELECT * FROM stocks').get()},{...before,location_code:code});
      assert.deepEqual({...h.sqlite.prepare('SELECT * FROM storage_fee_settlements').get()},{...fee,location_code:code});
      assert.deepEqual(result.data.zones[0].layout[code],editableZones()[0].layout.B1);
      assert.equal(h.sqlite.prepare('SELECT count(*) n FROM audit_logs').get().n,0);
      assert.deepEqual((await h.get()).zones[0].codes,[code,'B2','B3']);
    }
  }finally{h.sqlite.close()}
});
test('real route persists mixed edits and deletion of an entire empty region without regenerating bins',async()=>{
  const h=setup();try {
    h.stock('B1');
    const result=await edit(h,d=>{d[0].rows[0].code='新B1';d[0].rows.splice(1,1);d[0].rows.push({id:'new',code:'B4'})});
    assert.equal(result.status,200,JSON.stringify(result.data));
    assert.deepEqual((await h.get()).zones[0].codes,['新B1','B3','B4']);
    const added=await edit(h,d=>d.push({id:'CUSTOM',title:'临时区',codes:[],rows:[{id:'new',code:'Z1'}],locationCodesVersion:1}));assert.equal(added.status,200);
    assert.equal((await edit(h,d=>d.pop())).status,200);
    assert.equal((await h.get()).zones.length,1);
  }finally{h.sqlite.close()}
});
test('occupied deletion, collisions and unrelated historical-name reuse leave the database unchanged',async()=>{
  const h=setup();try {
    h.stock('B1');const before=h.sqlite.prepare('SELECT * FROM stocks').all();
    assert.equal((await edit(h,d=>d[0].rows.shift())).status,409);
    assert.equal((await edit(h,d=>{d[0].rows[1].code='新B1'})).status,409);
    const snapshot=await h.get();const invalid=structuredClone(snapshot.zones);invalid[0].codes[1]='b1';
    assert.equal((await h.post({zones:invalid,expectedRevision:snapshot.revision})).status,400);
    assert.equal((await h.post({zones:snapshot.zones,renames:{B1:123},expectedRevision:snapshot.revision})).status,400);
    assert.deepEqual(h.sqlite.prepare('SELECT * FROM stocks').all(),before);
    assert.deepEqual((await h.get()).zones[0].codes,['B1','B2','B3']);
  }finally{h.sqlite.close()}
});
test('stale editors cannot overwrite a newer layout or capacity',async()=>{
  const h=setup();try{
    const old=await h.get();assert.equal((await edit(h,d=>{d[0].title='新的区域名'})).status,200);
    const result=await h.post({zones:old.zones,expectedRevision:old.revision});assert.equal(result.status,409);assert.match(result.data.error,/地图已更新/);
    assert.equal((await h.get()).zones[0].title,'新的区域名');
  }finally{h.sqlite.close()}
});
test('concurrent receiving or map change between validation and commit rolls back the whole batch',async()=>{
  for(const kind of ['receive','layout','rename']) {
    const h=setup();try{
      h.state.beforeBatch=db=>kind==='receive'?h.stock('B2'):kind==='rename'?h.stock('B1'):db.prepare("UPDATE settings SET value=? WHERE key='warehouse_zones'").run(JSON.stringify([{...editableZones()[0],title:'别人已保存'}]));
      const result=await edit(h,d=>{if(kind==='rename')d[0].rows[0].code='新B1';else d[0].rows.splice(1,1)});
      assert.equal(result.status,409,JSON.stringify(result.data));
      assert.deepEqual(h.readSetting('warehouse_zones')[0].codes,['B1','B2','B3']);
      assert.deepEqual(h.readSetting('warehouse_location_aliases'),{新B1:'B1',新B2:'B2',新B3:'B3'});
    }finally{h.sqlite.close()}
  }
});
test('employee and logged-out sessions cannot save location definitions',async()=>{
  const h=setup();try{for(const role of ['employee','none']){h.state.role=role;assert.equal((await h.post({zones:editableZones()})).status,403)}}finally{h.sqlite.close()}
});
test('a backup made before renaming back resolves to the current name without alias cycles',()=>{
  const old={stocks:[{locationCode:'B1',totalQuantity:11}],settings:[{key:'warehouse_zones',value:JSON.stringify(editableZones())},{key:'warehouse_location_aliases',value:JSON.stringify({新B1:'B1'})}]};
  const upgraded=upgradeBackupLocationNames(old,{B1:'新B1'});
  assert.equal(upgraded.stocks[0].locationCode,'新B1');
  const aliases=JSON.parse(upgraded.settings.find(row=>row.key==='warehouse_location_aliases').value);
  assert.equal(resolveLocationAlias('B1',aliases),'新B1');
  assert.equal(resolveLocationAlias('新B1',aliases),'新B1');
});
