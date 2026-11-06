"use client";

import { useRef, useState } from "react";
import CatalogProductPicker from "./CatalogProductPicker";
import PricingNumberInput from "./PricingNumberInput";
import styles from "./PricingWorkspace.module.css";
import {
  dimensionFromCentimeters,
  dimensionToCentimeters,
  dimensionsToVolume,
  DimensionUnit,
  PricingCatalogItem,
  StockPricingDraft,
} from "./pricing-types";

type ReturnPricingFieldsProps = {
  value: StockPricingDraft;
  onChange: (patch: Partial<StockPricingDraft>) => void;
  onCatalogSelect?: (item: PricingCatalogItem) => boolean | void;
  catalogItems?: PricingCatalogItem[];
  catalogEndpoint?: string;
  catalogSelectionText?: string;
  catalogPickerKey?: string | number;
  actionLabel?: "入库" | "出库";
  disabled?: boolean;
};

type DimensionField = "length" | "width" | "height";
type DimensionValues = Record<DimensionField, number>;
type DimensionDraft = Record<DimensionField, string>;

const EMPTY_DIMENSIONS: DimensionValues = { length: 0, width: 0, height: 0 };
const EMPTY_DIMENSION_DRAFT: DimensionDraft = { length: "", width: "", height: "" };

const formatDimension = (value: number) => value > 0
  ? String(Number(value.toFixed(6)))
  : "";

function ManualDimensionCalculator({
  billingMode,
  currentVolumeM3,
  disabled,
  onVolume,
}: {
  billingMode: StockPricingDraft["billingMode"];
  currentVolumeM3: number;
  disabled: boolean;
  onVolume: (volumeM3: number) => void;
}) {
  const [unit, setUnit] = useState<DimensionUnit>("cm");
  const [draft, setDraft] = useState<DimensionDraft>(EMPTY_DIMENSION_DRAFT);
  const dimensionsCm = useRef<DimensionValues>(EMPTY_DIMENSIONS);
  const legacyBoxRecord = billingMode === "box";

  const changeUnit = (nextUnit: DimensionUnit) => {
    if (nextUnit === unit) return;
    const nextDraft = (Object.keys(dimensionsCm.current) as DimensionField[]).reduce<DimensionDraft>(
      (result, field) => ({
        ...result,
        [field]: formatDimension(dimensionFromCentimeters(dimensionsCm.current[field], nextUnit)),
      }),
      { ...EMPTY_DIMENSION_DRAFT },
    );
    setUnit(nextUnit);
    setDraft(nextDraft);
  };

  const changeDimension = (field: DimensionField, raw: string) => {
    const nextText = raw.trim();
    if (!/^\d*(?:[.,]\d*)?$/.test(nextText)) return;
    const parsed = Number(nextText.replace(",", "."));
    const nextDimensionsCm = {
      ...dimensionsCm.current,
      [field]: Number.isFinite(parsed) && parsed > 0 ? dimensionToCentimeters(parsed, unit) : 0,
    };
    dimensionsCm.current = nextDimensionsCm;
    setDraft((current) => ({ ...current, [field]: nextText }));
    const volumeM3 = dimensionsToVolume(
      nextDimensionsCm.length,
      nextDimensionsCm.width,
      nextDimensionsCm.height,
    );
    onVolume(volumeM3);
  };

  const volumeLabel = legacyBoxRecord ? "箱体积（m³）" : "体积（m³）";

  return (
    <section className={styles.dimensionCalculator} aria-label="尺寸与体积">
      <div className={styles.dimensionUnitToggle} role="group" aria-label="尺寸单位">
        <button
          type="button"
          disabled={disabled}
          className={unit === "cm" ? styles.dimensionUnitSelected : ""}
          aria-pressed={unit === "cm"}
          onClick={() => changeUnit("cm")}
        >
          cm
        </button>
        <button
          type="button"
          disabled={disabled}
          className={unit === "inch" ? styles.dimensionUnitSelected : ""}
          aria-pressed={unit === "inch"}
          onClick={() => changeUnit("inch")}
        >
          inch
        </button>
      </div>

      <div className={styles.manualDimensionGrid}>
        {(["length", "width", "height"] as DimensionField[]).map((field, index) => (
          <label key={field}>
            <span>{["长", "宽", "高"][index]}</span>
            <input
              type="text"
              inputMode="decimal"
              disabled={disabled}
              placeholder="0"
              value={draft[field]}
              onChange={(event) => changeDimension(field, event.target.value)}
            />
          </label>
        ))}
        <label className={styles.calculatedVolume}>
          <span>{volumeLabel}</span>
          <PricingNumberInput
            disabled={disabled}
            value={currentVolumeM3}
            placeholder="0"
            onValue={onVolume}
          />
        </label>
      </div>
    </section>
  );
}

export function ReturnPricingFields({
  value,
  onChange,
  onCatalogSelect,
  catalogItems,
  catalogEndpoint = "/api/pricing/catalog?warehouseLookup=1",
  catalogSelectionText = "",
  catalogPickerKey = "default",
  actionLabel = "入库",
  disabled = false,
}: ReturnPricingFieldsProps) {
  const [catalogRevision, setCatalogRevision] = useState(0);
  const isReturn = value.sourceType === "return";
  const isDomestic = value.sourceType === "domestic";
  const isUnspecified = value.sourceType === "unspecified";

  const applyCatalogItem = (item: PricingCatalogItem) => {
    if (onCatalogSelect?.(item) === false) return false;
    const legacyBoxRecord = value.billingMode === "box";
    setCatalogRevision((current) => current + 1);
    onChange({
      pricingCatalogId: item.id ?? null,
      billingMode: legacyBoxRecord ? "box" : "item",
      itemVolumeM3: legacyBoxRecord ? value.itemVolumeM3 : item.itemVolumeM3,
      boxVolumeM3: legacyBoxRecord ? item.boxVolumeM3 || value.boxVolumeM3 : value.boxVolumeM3,
      ratePerM3Day: item.ratePerM3Day,
      freeDays: item.freeDays,
    });
    return true;
  };

  return (
    <section className={styles.pricingFields}>
      <div className={styles.sourceToggle} role="group" aria-label={`${actionLabel}来源`}>
        <label className={styles.returnCheck}>
          <span><b>退货</b></span>
          <input
            type="checkbox"
            disabled={disabled}
            checked={isReturn}
            aria-label="选择退货"
            onChange={(event) => onChange({ sourceType: event.target.checked ? "return" : "unspecified" })}
          />
        </label>
        <label className={styles.returnCheck}>
          <span><b>国内</b></span>
          <input
            type="checkbox"
            disabled={disabled}
            checked={isDomestic}
            aria-label="选择国内"
            onChange={(event) => onChange({ sourceType: event.target.checked ? "domestic" : "unspecified" })}
          />
        </label>
        <label className={styles.returnCheck}>
          <span><b>无</b></span>
          <input
            type="checkbox"
            disabled={disabled}
            checked={isUnspecified}
            aria-label="选择无"
            onChange={() => onChange({ sourceType: "unspecified" })}
          />
        </label>
      </div>

      {isReturn && (
        <>
          <div className={styles.returnPricingGrid}>
            <div className={styles.catalogPickerPane}>
              <CatalogProductPicker
                key={`${catalogPickerKey}:${value.pricingCatalogId ?? "none"}:${catalogSelectionText}`}
                catalogItems={catalogItems}
                endpoint={catalogEndpoint}
                initialText={catalogSelectionText}
                disabled={disabled}
                label="合作商家目录（选填）"
                placeholder="可搜索并选择，也可以不选"
                onSelect={applyCatalogItem}
              />
              <span className={styles.itemBillingBadge}>
                {value.billingMode === "box" ? "旧记录沿用箱数计价" : "按件计费"}
              </span>
            </div>

            <ManualDimensionCalculator
              key={`${String(catalogPickerKey)}:${value.pricingCatalogId ?? "none"}:${catalogRevision}`}
              billingMode={value.billingMode}
              currentVolumeM3={value.billingMode === "box" ? value.boxVolumeM3 : value.itemVolumeM3}
              disabled={disabled}
              onVolume={(next) => onChange(value.billingMode === "box"
                ? { boxVolumeM3: next }
                : { billingMode: "item", itemVolumeM3: next })}
            />
          </div>
        </>
      )}
    </section>
  );
}

export default ReturnPricingFields;
