import test from 'node:test';
import {runDateStorageTrialA} from './helpers/date-storage-trial-a.mjs';
test('独立试算A：真实多批次入库、择位出库、FIFO账务、所选日期、免租边界、跨月回算',async()=>{await runDateStorageTrialA();});

