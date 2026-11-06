import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { highlightWarehouseSearchText, normalizeWarehouseSearch, searchWarehouseRecords,isApproximateWarehouseSearchMatch } from "../lib/warehouse-search.ts";

const record = (id, patch = {}) => ({
  id,
  locationCode: "",
  product: "",
  barcode: "",
  inboundOrder: "",
  customerName: "",
  ...patch,
});

test("search normalization folds width, case, whitespace, punctuation, O and 0", () => {
  assert.equal(normalizeWarehouseSearch(" Ｍ4-o 38 "), "M4038");
  assert.equal(normalizeWarehouseSearch(" 客户， A。 "), "客户A");
  assert.equal(normalizeWarehouseSearch("　，-／ "), "");
});

test("search highlighting preserves the original text while marking direct normalized matches", () => {
  assert.deepEqual(highlightWarehouseSearchText("1层 IB557715254RS-C7", "IB557715254RS-C7"), [
    { text: "1层 ", matched: false },
    { text: "IB557715254RS-C7", matched: true },
  ]);
  assert.deepEqual(highlightWarehouseSearchText("Ｍ4-O 38", "m4038"), [
    { text: "Ｍ4-O 38", matched: true },
  ]);
  assert.deepEqual(highlightWarehouseSearchText("纸箱 30 x 40*50 cm", "30 × 40 × 50"), [
    { text: "纸箱 ", matched: false },
    { text: "30 x 40*50", matched: true },
    { text: " cm", matched: false },
  ]);
});

test("long fuzzy queries highlight each visible phrase without swallowing separators", () => {
  const query = "ZCY891-L-无刷电机高速吹风机-美规带漏保-枪色";
  assert.deepEqual(highlightWarehouseSearchText("[残次] 无刷电机高速吹风机", query), [
    { text: "[残次] ", matched: false },
    { text: "无刷电机高速吹风机", matched: true },
  ]);
  assert.deepEqual(highlightWarehouseSearchText("美规带漏保 / 高速吹风机", "高速吹风机 ZCY891 美规带漏保"), [
    { text: "美规带漏保", matched: true },
    { text: " / ", matched: false },
    { text: "高速吹风机", matched: true },
  ]);
});

test("approximate highlighting leaves wrong or transposed characters visibly unmarked", () => {
  assert.deepEqual(highlightWarehouseSearchText("IB557715254RS-C6", "IB557715254RS-C7"), [
    { text: "IB557715254RS-C", matched: true },
    { text: "1", matched: false },
  ]);
  assert.deepEqual(highlightWarehouseSearchText("M4038", "M4308"), [
    { text: "M4", matched: true },
    { text: "03", matched: false },
    { text: "8", matched: true },
  ]);
  assert.deepEqual(highlightWarehouseSearchText("ABX123", "AB123"), [
    { text: "AB", matched: true },
    { text: "X", matched: false },
    { text: "123", matched: true },
  ]);
});

test("highlighting is repeatable, token-aware, and keeps unsafe-looking text as plain segments", () => {
  assert.deepEqual(highlightWarehouseSearchText("C2 / C2", "C2"), [
    { text: "C2", matched: true },
    { text: " / ", matched: false },
    { text: "C2", matched: true },
  ]);
  assert.deepEqual(highlightWarehouseSearchText("C00L风扇 12寸", "COOL风扇 12寸"), [
    { text: "C00L", matched: false },
    { text: "风扇", matched: true },
    { text: " 12寸", matched: false },
  ]);
  assert.deepEqual(highlightWarehouseSearchText("<script>C2</script>", "C2"), [
    { text: "<script>", matched: false },
    { text: "C2", matched: true },
    { text: "</script>", matched: false },
  ]);
  assert.deepEqual(highlightWarehouseSearchText("产品📦IB123🧰", "IB123"), [
    { text: "产品📦", matched: false },
    { text: "IB123", matched: true },
    { text: "🧰", matched: false },
  ]);
  assert.deepEqual(highlightWarehouseSearchText("ABC · DEF", "ABCDEF"), [
    { text: "ABC · DEF", matched: true },
  ]);
  assert.deepEqual(highlightWarehouseSearchText("原文", ""), [{ text: "原文", matched: false }]);
});

test("search keeps the existing five-field scope", () => {
  const records = [
    record("location", { locationCode: "新-A 01" }),
    record("product", { product: "蓝色 真空机" }),
    record("barcode", { barcode: "BC-O038" }),
    record("order", { inboundOrder: "IB 2026-0811" }),
    record("customer", { customerName: "泉州，客户" }),
  ];

  assert.equal(searchWarehouseRecords(records, "新a01")[0]?.id, "location");
  assert.equal(searchWarehouseRecords(records, "蓝色真空机")[0]?.id, "product");
  assert.equal(searchWarehouseRecords(records, "bc0038")[0]?.id, "barcode");
  assert.equal(searchWarehouseRecords(records, "ib20260811")[0]?.id, "order");
  assert.equal(searchWarehouseRecords(records, "泉州客户")[0]?.id, "customer");
});

test("search treats letter O and digit 0 as the same identifier character", () => {
  const records = [record("wanted", { barcode: "m4O38" }), record("other", { barcode: "M4938" })];
  assert.deepEqual(searchWarehouseRecords(records, "m4038").map(item => item.id), ["wanted", "other"]);
});

test("a real NFKC exact match ranks before an O and 0 folded match", () => {
  const records = [
    record("folded", { locationCode: "m4O38" }),
    record("exact", { product: "M4038" }),
  ];

  assert.deepEqual(searchWarehouseRecords(records, "ｍ４０３８").map(item => item.id), ["exact", "folded"]);
  assert.deepEqual(searchWarehouseRecords(records, "m4o38").map(item => item.id), ["folded", "exact"]);
});

test("raw direct matches all rank before O and 0 folded direct matches, then fuzzy", () => {
  const records = [
    record("fuzzy", { product: "M4308" }),
    record("folded-substring", { product: "XX-M4O38-ZZ" }),
    record("folded-prefix", { product: "M4O38-TAIL" }),
    record("folded-exact", { product: "M4O38" }),
    record("raw-substring", { product: "XX-M4038-ZZ" }),
    record("raw-prefix", { product: "M4038-TAIL" }),
    record("raw-exact", { product: "M4038" }),
  ];

  assert.deepEqual(searchWarehouseRecords(records, "m4038").map(item => item.id), [
    "raw-exact", "raw-prefix", "raw-substring",
    "folded-exact", "folded-prefix", "folded-substring",
    "fuzzy",
  ]);
  assert.deepEqual(searchWarehouseRecords(records, "m4o38").map(item => item.id), [
    "folded-exact", "folded-prefix", "folded-substring",
    "raw-exact", "raw-prefix", "raw-substring",
    "fuzzy",
  ]);
});

test("fuzzy search accepts a nearby swap or one small edit", () => {
  const records = [
    record("swap", { product: "M4038" }),
    record("missing", { inboundOrder: "AB123" }),
  ];

  assert.equal(searchWarehouseRecords(records, "m4308")[0]?.id, "swap");
  assert.equal(searchWarehouseRecords(records, "ab1234")[0]?.id, "missing");
});

test("short queries do not enable broad fuzzy matching and direct matches keep the legacy unlimited default", () => {
  assert.deepEqual(searchWarehouseRecords([record("no", { product: "AC" })], "AB"), []);
  assert.deepEqual(searchWarehouseRecords([record("no", { product: "B" })], "A"), []);

  const manyDirectMatches = Array.from({ length: 100 }, (_, index) => record(index, { product: `A item ${index}` }));
  assert.equal(searchWarehouseRecords(manyDirectMatches, "A").length, 100);
  assert.equal(searchWarehouseRecords(manyDirectMatches, "A", { limit: 7 }).length, 7);
});

test("fuzzy-only results have an independent cap, including an explicit zero cap", () => {
  const fuzzyRecords = Array.from({ length: 30 }, (_, index) => record(index, { barcode: "M403A" }));
  assert.equal(searchWarehouseRecords(fuzzyRecords, "M4038").length, 12);
  assert.equal(searchWarehouseRecords(fuzzyRecords, "M4038", { fuzzyLimit: 3 }).length, 3);
  assert.equal(searchWarehouseRecords(fuzzyRecords, "M4038", { fuzzyLimit: 0 }).length, 0);
});

test('中文描述和短型号分开匹配，顺序改变仍找到完整产品并优先于Pro Max',()=>{
 const records=[record('max',{product:'钢化膜16promax 高清款'}),record('wrong-number',{product:'钢化膜17pro 高清款'}),record('wanted',{product:'钢化膜16pro 高清款'})];
 for(const query of ['钢化膜高清款16 pro','高清款16pro钢化膜','16 pro 高清款 钢化膜']){
  const found=searchWarehouseRecords(records,query);assert.equal(found[0]?.id,'wanted');assert.ok(found.some(r=>r.id==='max'));assert.equal(found.some(r=>r.id==='wrong-number'),false);
  assert.deepEqual(searchWarehouseRecords(records,query,{fuzzyLimit:0}).map(r=>r.id),['wanted']);
 }
});

test('只有几字匹配时返回有限相近候选，单个共同字不扩展无关产品',()=>{
 const records=Array.from({length:30},(_,i)=>record(i,{product:'钢化膜16pro 高清款'}));
 assert.equal(searchWarehouseRecords(records,'钢化新款',{fuzzyLimit:3}).length,3);
 assert.equal(searchWarehouseRecords(records,'钢化新款',{fuzzyLimit:0}).length,0);
 assert.deepEqual(searchWarehouseRecords([record('irrelevant',{product:'高清款耳机'})],'钢化膜'),[]);
});

test('乱序搜索高亮实际匹配的中文和16pro，保留原文字及空格',()=>{
 const text='钢化膜16pro 高清款',parts=highlightWarehouseSearchText(text,'钢化膜高清款16 pro');
 assert.equal(parts.map(p=>p.text).join(''),text);
 assert.equal(parts.filter(p=>p.matched).map(p=>p.text).join('').replace(/\s/g,''),'钢化膜16pro高清款');
});

test('缩短型号搜索仍优先Pro，ProMax是相近候选且不会占用完整匹配',()=>{
 const records=[record('max',{product:'钢化膜16promax 高清款'}),record('wanted',{product:'#1 钢化膜16pro 高清款'})];
 for(const query of ['钢化膜16 pro','16 pro','16pro']){
  assert.equal(searchWarehouseRecords(records,query)[0].id,'wanted');assert.equal(isApproximateWarehouseSearchMatch(records[0],query),true);assert.equal(isApproximateWarehouseSearchMatch(records[1],query),false);
  assert.deepEqual(searchWarehouseRecords(records,query,{fuzzyLimit:0}).map(r=>r.id),['wanted']);
 }
});
test('连续和带空格的型号搜索结果一致，弱编号候选不会挤掉中文相近产品',()=>{
 const records=[...Array.from({length:20},(_,i)=>record(i,{product:'16pro保护壳'})),record('max',{product:'钢化膜16promax 高清款'}),record('wanted',{product:'钢化膜16pro 高清款'})];
 for(const query of ['钢化膜高清款16pro','钢化膜高清款16 pro'])assert.deepEqual(searchWarehouseRecords(records,query).map(r=>r.id),['wanted','max']);
});

test("a long catalog name finds records that contain only its strongest product phrases", () => {
  const query = "ZCY891-L-无刷电机高速吹风机-美规带漏保-枪色";
  const records = [
    record("short-color-only", { product: "枪色收纳配件" }),
    record("short-core", { product: "#3 DQ-高速吹风机-丘辉鹏" }),
    record("core", { product: "[残次] 无刷电机高速吹风机" }),
    record("multi-field", { barcode: "ZCY891-L", product: "无刷电机高速吹风机" }),
    record("whole", { product: query }),
  ];

  assert.deepEqual(searchWarehouseRecords(records, query).map(item => item.id), [
    "whole",
    "multi-field",
    "core",
    "short-core",
  ]);
});

test("long-query segments match across fields and do not depend on segment order", () => {
  const records = [
    record("one-phrase", { product: "高速吹风机" }),
    record("combined", { barcode: "ZCY891", product: "美规带漏保高速吹风机" }),
  ];

  assert.deepEqual(
    searchWarehouseRecords(records, "美规带漏保 ZCY891 高速吹风机").map(item => item.id),
    ["combined", "one-phrase"],
  );
  assert.deepEqual(
    searchWarehouseRecords(records, "高速吹风机 ZCY891 美规带漏保").map(item => item.id),
    ["combined", "one-phrase"],
  );
});

test("a complete hyphenated identifier outranks a neighboring suffix and survives fuzzyLimit zero", () => {
  const query = "ZCY891-L-无刷电机高速吹风机-美规带漏保-枪色";
  const records = [
    record("wrong-suffix", { barcode: "ZCY891-M", product: "无刷电机高速吹风机" }),
    record("right-suffix", { barcode: "ZCY891-L", product: "无刷电机高速吹风机" }),
    record("shared-only", { product: "高速吹风机" }),
  ];

  assert.deepEqual(searchWarehouseRecords(records, query).map(item => item.id), ["right-suffix", "wrong-suffix", "shared-only"]);
  assert.deepEqual(searchWarehouseRecords(records, query, { fuzzyLimit: 0 }).map(item => item.id), ["right-suffix", "wrong-suffix"]);

  const crowded = [
    ...Array.from({ length: 20 }, (_, index) => record(`generic-${index}`, { product: "DQ-高速吹风机-客户" })),
    record("identifier-target", { barcode: "ZCY891-L", product: "其他产品" }),
  ];
  const crowdedResults = searchWarehouseRecords(crowded, query).map(item => item.id);
  assert.equal(crowdedResults[0], "identifier-target");
  assert.equal(crowdedResults.length, 13);
});

test("dimension separators normalize consistently and weak common fragments do not recall unrelated stock", () => {
  assert.equal(normalizeWarehouseSearch("30×40*50"), "30X40X50");
  assert.equal(searchWarehouseRecords([record("size", { product: "纸箱 30x40x50 cm" })], "30×40×50")[0]?.id, "size");
  assert.equal(searchWarehouseRecords([record("spaced-size", { product: "纸箱 30x40x50 cm" })], "30 × 40 × 50")[0]?.id, "spaced-size");
  assert.equal(searchWarehouseRecords([record("decimal-size", { product: "纸箱 30.5x40.5x50.5 cm" })], "30.5 × 40.5 × 50.5")[0]?.id, "decimal-size");
  assert.deepEqual(
    searchWarehouseRecords([record("color", { product: "枪色收纳配件" })], "ZCY891-L-无刷电机高速吹风机-美规带漏保-枪色"),
    [],
  );
  assert.deepEqual(
    searchWarehouseRecords([record("generic", { product: "中国制造收纳配件" })], "MODEL123-高速吹风机-中国制造"),
    [],
  );
  assert.deepEqual(searchWarehouseRecords([record("natural", { product: "C00L风扇 12寸" })], "COOL风扇 12寸"), []);
});

test("warehouse page connects the ranked search to both inventory search boxes", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/map-interaction-fix.css", import.meta.url), "utf8");
  assert.match(page, /import \{ highlightWarehouseSearchText,searchWarehouseRecords,cartonWarehouseSearchRecords \} from "\.\.\/lib\/warehouse-search";/);
  assert.match(page, /const results=useMemo\(\(\)=>searchWarehouseRecords\(inventorySearchRecords,query,\{limit:50\}\),\[query,inventorySearchRecords\]\);/);
  assert.match(page, /const stockSearchResults=useMemo\(\(\)=>searchWarehouseRecords\(inventorySearchRecords,stockSearch,\{limit:20\}\),\[stockSearch,inventorySearchRecords\]\);/);
  assert.match(page, /const inventorySearchRecords=useMemo\(\(\)=>\[.*kind:"stock" as const,stock,searchKey:.*cartonWarehouseSearchRecords\(cartons\)\],\[physicalStocks,cartons\]\)/);
  assert.equal((page.match(/s\.kind==='stock'\?<SearchSupplementDetails stock=\{s\.stock\}/g) ?? []).length, 2, "both sidebar searches discriminate physical product records before rendering stock fields");
  assert.match(page, /r\.kind==='stock'\?<SearchResultEvidence stock=\{r\.stock\}/);
  assert.match(page, /if\(entry\.kind==='carton'\)\{select\(entry\.locationCode\);setSelectedCarton\(\{id:entry\.receipt\.id,key:entry\.placementKey\}\)/);
  assert.match(page, /results\.length===50\?"（最多显示前 50 条）"/);
  assert.match(page, /<mark className="search-match"/);
  assert.match(page, /const SearchHighlightedText=.*highlightWarehouseSearchText\(value,query\)/s);
  assert.match(page, /const SearchSupplementDetails=.*\[stock\.sku,stock\.barcode,stock\.inboundOrder,stock\.customerName\]\.filter\(Boolean\)/s);
  assert.equal((page.match(/<SearchSupplementDetails stock=\{s\.stock\} query=\{stockSearch\}\/\>/g) ?? []).length, 2);
  assert.match(page, /<b><SearchHighlightedText value=\{r\.locationCode\} query=\{query\}\/><\/b><strong className="search-result-layer">/);
  assert.match(page, /<span className="search-result-product">.*<SearchResultEvidence stock=\{r\.stock\} query=\{query\}\/>/);
  assert.match(page, /<time className="search-result-inbound" dateTime=\{r\.inboundDate\}>入库 \{r\.inboundDate\|\|"未填写"\}<\/time>/);
  assert.match(page, /className="search-supplement-inbound">入库 \{stock\.inboundDate\|\|"未填写"\}/);
  assert.match(page, /\{label:"条码",value:stock\.barcode\},\{label:"单号",value:stock\.inboundOrder\}/);
  assert.ok((page.match(/query=\{stockSearch\}/g) ?? []).length >= 6, "both sidebar search variants should highlight visible fields");
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
  assert.match(page, /\{r\.layerCount\|\|1\}层/);
  assert.match(css, /\.search-match\s*\{[^}]*background:\s*#2d63c8;[^}]*color:\s*#fff;/s);
  assert.match(css, /\.search-result-inbound,[\s\S]*?\.search-supplement-inbound\s*\{[\s\S]*?display:\s*block;/);
  assert.match(css, /@media \(forced-colors: active\)/);
});
