import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveLayerVolume,groupLayerOccupancy} from '../lib/layer-storage.ts';
const config=locations=>({schemaVersion:1,revision:4,locations});
test('V133 legacy whole-location one cubic metre stops at bounded exception floors',()=>{
 for(const [code,last] of [['C1',3],['C8',3],['D1',2],['D32',2],['E1',4],['E6',4]]){
  const c=config({[code]:{defaultVolumeM3:1,layers:{}}});
  for(let layer=1;layer<=last;layer++)assert.equal(resolveLayerVolume(c,code,layer,[]).volumeM3,1);
  assert.equal(resolveLayerVolume(c,code,last+1,[]).volumeM3,2,`${code} upper layer`);
  assert.equal(resolveLayerVolume(c,code,10000,[]).volumeM3,2);
 }
});
test('V133 explicit layer values, other manual location values and aliases remain authoritative',()=>{
 const c=config({Old:{defaultVolumeM3:1,layers:{4:{volumeM3:1}}},D1:{defaultVolumeM3:3,layers:{}},A1:{defaultVolumeM3:1,layers:{}}});
 assert.equal(resolveLayerVolume(c,'C1',4,[],{Old:'C1'}).volumeM3,1);
 assert.equal(resolveLayerVolume(c,'C1',5,[],{Old:'C1'}).volumeM3,2);
 for(const [code,expected] of [['D1',3],['A1',1]])assert.equal(resolveLayerVolume(c,code,9,[]).volumeM3,expected);
 for(const code of ['C9','D33','E7'])assert.equal(resolveLayerVolume(config({[code]:{defaultVolumeM3:1,layers:{}}}),code,9,[]).volumeM3,1);
 assert.equal(resolveLayerVolume(config({}),'A9',7,[]).volumeM3,2);
 assert.equal(resolveLayerVolume(config({}),'配送1',9,[{id:'Y',codes:['配送1']}]).volumeM3,.2);
 const [occupied]=groupLayerOccupancy([{id:'s',kind:'stock',locationCode:'C1',layer:5,customerName:'客户',inboundDate:'2026-10-01',productName:'货物',sku:'a'}],c,[],{Old:'C1'});
 assert.equal(occupied.volumeM3,2);
});

test('V134 one-piece warehouse initial volume is 0.2 on every layer while other zones and manual settings remain independent',()=>{const zones=[{id:'Y',title:'一件代发室',codes:['Y-1-1','Y-6-3','配送1']}];for(const code of zones[0].codes)for(const layer of [1,2,5,6,10000])assert.equal(resolveLayerVolume(config({}),code,layer,zones).volumeM3,.2);assert.equal(resolveLayerVolume(config({}),'A1',1,zones).volumeM3,2);assert.equal(resolveLayerVolume(config({}),'C1',4,zones).volumeM3,2);assert.equal(resolveLayerVolume(config({'Y-1-1':{layers:{2:{volumeM3:.3}}}}),'Y-1-1',2,zones).volumeM3,.3);});
