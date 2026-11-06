import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("build produces the electronic warehouse application", async () => {
  await access(new URL("../dist/server/index.js", import.meta.url));

  const [page, layout, hosting] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /电子库位图/);
  assert.match(page, /仓库总览/);
  assert.match(page, /库位列表/);
  assert.match(page, /仓储计价/);
  assert.ok(page.includes("<ReleaseHistory />"));
  assert.doesNotMatch(page, /action:"auto"/);
  assert.match(layout, /title:\s*"海外仓电子库位图"/);
  assert.match(layout, /lang="zh-CN"/);
  assert.match(hosting, /"d1":\s*"DB"/);
  assert.match(hosting, /"r2":\s*"BACKUPS"/);
});

test("pricing uses separate catalog and manual settlement workspaces", async () => {
  const [pricing, catalog, catalogPage, returnPricingFields] = await Promise.all([
    readFile(new URL("../components/PricingWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/PricingCatalogWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/pricing/catalog/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/ReturnPricingFields.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(pricing, /href="\/pricing\/catalog" target="_blank"/);
  assert.match(pricing, /选择账单月份/);
  assert.match(pricing, /仓储费明细/);
  assert.match(pricing, /生成本期\{exportScopeLabel\}账单Excel/);
  assert.match(pricing, /待处理出库计价/);
  assert.match(pricing, /计价操作记录/);
  assert.match(pricing, /待处理/);
  assert.match(pricing, /已确认/);
  assert.match(pricing, /已取消/);
  assert.match(pricing, /撤销取消/);
  assert.doesNotMatch(pricing, /已结算 · 客户账单/);
  assert.doesNotMatch(pricing, /catalogTable|＋ 新增货物/);
  assert.match(catalog, /上传 \/ 更新 Excel/);
  assert.match(catalog, /删除当前目录/);
  assert.match(catalog, /下载当前 Excel/);
  assert.match(catalog, /从已上传 Excel 搜索/);
  assert.match(catalogPage, /hasPermission\(payload.user,"pricing.manage"\)/);
  assert.match(catalogPage, /state === "admin".*<PricingCatalogWorkspace/s);
  assert.match(returnPricingFields, /合作商家目录（选填）/);
  assert.match(returnPricingFields, /按件计费/);
  assert.doesNotMatch(returnPricingFields, /按箱计费/);
  assert.match(returnPricingFields, /<span><b>无<\/b><\/span>/);
  assert.match(returnPricingFields, /aria-label="尺寸与体积"/);
  assert.match(returnPricingFields, /尺寸单位/);
  assert.match(returnPricingFields, /\["长", "宽", "高"\]/);
  assert.match(returnPricingFields, /unit === "cm"/);
  assert.match(returnPricingFields, /unit === "inch"/);
  assert.match(returnPricingFields, /体积（m³）/);
  assert.doesNotMatch(returnPricingFields, /目录搜不到时|自动计算，也可直接修改|长 × 宽 × 高|选择目录货物后/);
  assert.doesNotMatch(returnPricingFields, /<span>单价（\$\/m³\/天）<\/span>/);
  assert.doesNotMatch(returnPricingFields, /<span>免租天数<\/span>/);
  assert.match(pricing, /默认单价（\$\/m³\/天）/);
  assert.match(pricing, /默认免租天数/);
});

test("starter preview artifacts are not part of the production app", async () => {
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));

  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);
  assert.doesNotMatch(layout, /Starter Project|codex-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
