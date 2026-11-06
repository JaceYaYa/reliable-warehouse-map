import assert from 'node:assert/strict';
import test from 'node:test';
import {runItemTrialB,runBoxTrialB,runBoundaryTrialB,runAtomicDateTrialB,runHistoricalProjectionReviewB,TRIAL_B_TODAY} from './helpers/date-storage-trial-b.mjs';

test('独立试算B：按件双批次的自选出库日、FIFO、月度免租和导出一致',async()=>{
  const r=await runItemTrialB();
  assert.equal(r.today,TRIAL_B_TODAY);
  assert.equal(r.scenarios[0].actual.summary.totalFeeUsd,3.44);
  assert.equal(r.scenarios[0].actual.monthly.september+r.scenarios[0].actual.monthly.october,3.44);
  assert.deepEqual(r.warnings,[],'Historical asOf and monthly cutoff must match independent expectations');
});

test('独立试算B：按箱部分出库不推算件数，月度合计与生命周期一致',async()=>{
  const r=await runBoxTrialB();
  assert.equal(r.scenarios[0].actual.summary.totalFeeUsd,9.2);
  assert.ok(r.scenarios[0].actual.rows.every(row=>row.quantity===0));
});

test('独立试算B：免租结束日不收费，次日收费，待结算修改日期重新计费',async()=>{
  const r=await runBoundaryTrialB();
  assert.deepEqual(r.scenarios[0].actual.fees.map(row=>row.fee_usd),[0,.08]);
  assert.equal(r.scenarios[0].actual.revised.fee_usd,.16);
});

test('独立试算B：出库日早于剩余计价批次时拒绝且不扣库存',async()=>{
  const r=await runAtomicDateTrialB();
  assert.equal(r.scenarios[0].actual.status,400);
  assert.equal(r.scenarios[0].passed,true);
});

test('独立复查B：历史计价投影、取消和恢复不重复收费且不改原单据',async()=>{
  const result=await runHistoricalProjectionReviewB();
  assert.equal(result.passed,true);
});
