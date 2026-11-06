"use client";

import { ChangeEvent, useEffect, useState } from "react";
import { importPricingWorkbook } from "../lib/pricing-workbook-client";
import { extractCatalogItems, PricingCatalogItem } from "./pricing-types";
import styles from "./PricingCatalogWorkspace.module.css";

const PAGE_SIZE = 100;

async function jsonPayload(response: Response, fallback: string) {
  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(response.ok ? "服务器返回的数据格式不正确" : fallback);
    }
  }
  if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : fallback);
  return payload;
}

const dimensions = (length: number, width: number, height: number) =>
  [length, width, height].some((value) => value > 0)
    ? `${length || "—"} × ${width || "—"} × ${height || "—"} cm`
    : "—";

export function PricingCatalogWorkspace() {
  const [items, setItems] = useState<PricingCatalogItem[]>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [refreshToken, setRefreshToken] = useState(0);
  const [defaultRate, setDefaultRate] = useState(0.7);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/pricing/settings", { cache: "no-store", signal: controller.signal })
      .then((response) => jsonPayload(response, "默认计价设置读取失败"))
      .then((payload) => {
        const source = payload.settings && typeof payload.settings === "object"
          ? payload.settings as Record<string, unknown>
          : payload;
        const rate = Number(source.defaultRatePerM3Day);
        if (Number.isFinite(rate) && rate >= 0) setDefaultRate(rate);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "默认计价设置读取失败");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          page: String(page),
        });
        if (query.trim()) params.set("q", query.trim());
        const response = await fetch(`/api/pricing/catalog?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await jsonPayload(response, "产品目录读取失败");
        if (!controller.signal.aborted) setItems(extractCatalogItems(payload));
      } catch (reason) {
        if (!controller.signal.aborted) {
          setItems([]);
          setError(reason instanceof Error ? reason.message : "产品目录读取失败");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, query.trim() ? 220 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [page, query, refreshToken]);

  const uploadWorkbook = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy("upload");
    setError("");
    setMessage("");
    try {
      await importPricingWorkbook(file, defaultRate);
      setQuery("");
      setPage(1);
      setRefreshToken((value) => value + 1);
      setMessage(`“${file.name}”已上传；库存管理中的产品搜索会立即使用这份目录。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Excel 上传失败");
    } finally {
      setBusy("");
    }
  };

  const clearCatalog = async () => {
    if (!window.confirm("确认删除当前有效产品目录？现有库存和历史结算不会删除；如需替换目录，请清空后再上传修改好的完整 Excel。")) return;
    setBusy("clear");
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/pricing/catalog/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "CLEAR_ACTIVE_CATALOG" }),
      });
      const payload = await jsonPayload(response, "产品目录删除失败");
      const cleared = Number(payload.cleared || 0);
      setItems([]);
      setQuery("");
      setPage(1);
      setRefreshToken((value) => value + 1);
      setMessage(`当前目录已删除（停用 ${cleared} 条）；库存数据和历史费用仍完整保留。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "产品目录删除失败");
    } finally {
      setBusy("");
    }
  };

  return (
    <main className={styles.page}>
      <section className={styles.shell}>
        <header className={styles.hero}>
          <div>
            <p>EXCEL PRODUCT CATALOG</p>
            <h1>合作商家产品目录</h1>
            <span>在独立页面维护，不再挤占仓储计价界面。</span>
          </div>
          {/* Vinext 当前的 next/link 客户端 shim 会加载第二份 React，使用原生站内链接更稳定。 */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/">← 返回电子库位图</a>
        </header>

        <section className={styles.workflow}>
          <article><b>1. 下载</b><span>下载当前有效目录 Excel。</span></article>
          <article><b>2. 在 Excel 修改</b><span>相同货物会更新；单条停用可把“启用”改为“否”。</span></article>
          <article><b>3. 重新上传</b><span>上传后，库存搜索直接读取新目录。</span></article>
        </section>

        {error && <p className={styles.error}>{error}</p>}
        {message && <p className={styles.success}>{message}</p>}

        <section className={styles.panel}>
          <header className={styles.toolbar}>
            <div>
              <h2>Excel 目录文件</h2>
              <p>如需整份替换，请先下载备份，再删除当前目录并上传修改后的完整 Excel。</p>
            </div>
            <div className={styles.actions}>
              <label className={styles.primaryButton}>
                {busy === "upload" ? "上传中…" : "上传 / 更新 Excel"}
                <input type="file" accept=".xlsx,.xls,.csv" disabled={!!busy} onChange={uploadWorkbook} />
              </label>
              <a className={styles.secondaryButton} href="/api/pricing/catalog/export">下载当前 Excel</a>
              <button className={styles.dangerButton} type="button" disabled={!!busy} onClick={clearCatalog}>
                {busy === "clear" ? "删除中…" : "删除当前目录"}
              </button>
            </div>
          </header>
        </section>

        <section className={styles.panel}>
          <header className={styles.searchHead}>
            <div>
              <h2>从已上传 Excel 搜索</h2>
              <p>按产品、SKU、条码或客户搜索；结果来自上传后保存的有效目录。</p>
            </div>
            <div className={styles.searchBox}>
              <input
                value={query}
                placeholder="搜索产品、SKU、条码或客户…"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
              />
              {query && <button type="button" onClick={() => { setQuery(""); setPage(1); }}>清除</button>}
            </div>
          </header>

          <div className={styles.resultMeta}>{loading ? "正在读取目录…" : `当前页 ${items.length} 条`}</div>
          <div className={styles.resultList}>
            {items.map((item, index) => (
              <article className={styles.resultRow} key={String(item.id ?? `${item.sku}-${item.barcode}-${index}`)}>
                <div>
                  <b>{item.productName || "未命名产品"}</b>
                  <span>{item.customerName || "未填写客户"}</span>
                </div>
                <div>
                  <b>{[item.sku, item.barcode].filter(Boolean).join(" · ") || "无 SKU / 条码"}</b>
                  <span>{item.billingMode === "box" ? "默认按箱" : "默认按件"}</span>
                </div>
                <div>
                  <b>件：{dimensions(item.itemLengthCm, item.itemWidthCm, item.itemHeightCm)}</b>
                  <span>{item.itemVolumeM3 ? `${item.itemVolumeM3} m³/件` : "未填写每件体积"}</span>
                </div>
                <div>
                  <b>箱：{dimensions(item.boxLengthCm, item.boxWidthCm, item.boxHeightCm)}</b>
                  <span>{item.boxVolumeM3 ? `${item.boxVolumeM3} m³/箱` : "未填写每箱体积"}</span>
                </div>
                <div>
                  <b>${item.ratePerM3Day} / m³ / 天</b>
                  <span>免租 {item.freeDays} 天</span>
                </div>
              </article>
            ))}
            {!loading && !items.length && <p className={styles.empty}>没有匹配货物。请上传 Excel，或更换搜索内容。</p>}
          </div>

          <footer className={styles.pagination}>
            <button type="button" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
            <span>第 {page} 页</span>
            <button type="button" disabled={items.length < PAGE_SIZE || loading} onClick={() => setPage((value) => value + 1)}>下一页</button>
          </footer>
        </section>
      </section>
    </main>
  );
}

export default PricingCatalogWorkspace;
