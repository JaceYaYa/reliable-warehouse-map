"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./PricingWorkspace.module.css";
import {
  catalogSearchText,
  extractCatalogItems,
  PricingCatalogItem,
} from "./pricing-types";

type CatalogProductPickerProps = {
  catalogItems?: PricingCatalogItem[];
  endpoint?: string;
  label?: string;
  placeholder?: string;
  initialText?: string;
  disabled?: boolean;
  onSelect: (item: PricingCatalogItem) => boolean | void;
};

export function CatalogProductPicker({
  catalogItems,
  endpoint = "/api/pricing/catalog",
  label = "从合作商家目录选择",
  placeholder = "输入产品、SKU、条码或客户名称",
  initialText = "",
  disabled = false,
  onSelect,
}: CatalogProductPickerProps) {
  const [query, setQuery] = useState(initialText);
  const [remoteItems, setRemoteItems] = useState<PricingCatalogItem[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (catalogItems || !open || !query.trim() || disabled) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const separator = endpoint.includes("?") ? "&" : "?";
        const response = await fetch(
          `${endpoint}${separator}q=${encodeURIComponent(query.trim())}&limit=500`,
          { cache: "no-store", signal: controller.signal },
        );
        const raw = await response.text();
        let payload: Record<string, unknown> = {};
        if (raw.trim()) {
          try {
            payload = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            throw new Error("目录搜索服务回复异常，请稍后重试");
          }
        }
        if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "目录搜索失败");
        setRemoteItems(extractCatalogItems(payload));
      } catch (reason) {
        if (!controller.signal.aborted) {
          setRemoteItems([]);
          setError(reason instanceof Error ? reason.message : "目录搜索失败");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [catalogItems, disabled, endpoint, open, query]);

  const suggestions = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    const source = catalogItems ?? remoteItems;
    if (!q) return source.slice(0, 12);
    return source
      .filter((item) => catalogSearchText(item).includes(q))
      .sort((left, right) => {
        const exact = (item: PricingCatalogItem) =>
          [item.sku, item.barcode].some(
            (value) => value.trim().toLocaleLowerCase() === q,
          );
        return Number(exact(right)) - Number(exact(left));
      })
      .slice(0, 20);
  }, [catalogItems, query, remoteItems]);

  const choose = (item: PricingCatalogItem) => {
    if (onSelect(item) === false) return;
    setQuery(item.productName || item.sku || item.barcode);
    setOpen(false);
  };

  return (
    <div className={styles.picker}>
      <label className={styles.pickerLabel}>{label}</label>
      <div className={styles.pickerInputWrap}>
        <input
          className={styles.pickerInput}
          value={query}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete="off"
          onFocus={() => {
            if (closeTimer.current) clearTimeout(closeTimer.current);
            setOpen(true);
          }}
          onBlur={() => {
            closeTimer.current = setTimeout(() => setOpen(false), 120);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && suggestions[0]) {
              event.preventDefault();
              choose(suggestions[0]);
            }
            if (event.key === "Escape") setOpen(false);
          }}
        />
        {loading && <span className={styles.pickerSpinner}>…</span>}
      </div>
      {open && query.trim() && (
        <div className={styles.pickerResults} role="listbox">
          {suggestions.map((item, index) => (
            <button
              className={styles.pickerResult}
              key={String(item.id ?? `${item.sku}-${item.barcode}-${index}`)}
              type="button"
              role="option"
              aria-selected="false"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(item)}
            >
              <b>{item.productName || "未命名产品"}</b>
              <span>{[item.sku, item.barcode].filter(Boolean).join(" · ") || "无 SKU / 条码"}</span>
              <small>
                {[item.customerName, item.itemVolumeM3 ? `${item.itemVolumeM3} m³/件` : "", item.boxVolumeM3 ? `${item.boxVolumeM3} m³/箱` : ""]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
            </button>
          ))}
          {!loading && !suggestions.length && (
            <p className={styles.pickerEmpty}>{error || "目录中没有匹配货物，可继续手动填写"}</p>
          )}
        </div>
      )}
    </div>
  );
}

export default CatalogProductPicker;
