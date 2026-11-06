import { layerUsage, layerCapacity } from "./layer-capacity.ts";
import type { WarehouseZoneRecord } from "./warehouse-layout.ts";

type CapacityZone = Pick<WarehouseZoneRecord, "id" | "codes" | "layout">;
type CapacityStock = { locationCode: string; palletCount: number; totalBoxes: number };

const summaryZones = [
  { id: "NEW_A", label: "A区" },
  { id: "NEW_B", label: "B区" },
  { id: "NEW_C", label: "C区" },
  { id: "NEW_D", label: "D区" },
] as const;

export function summarizeNewZonePalletAvailability(zones: readonly CapacityZone[], stocks: readonly CapacityStock[]) {
  const occupied = new Map<string, { pallets: number; boxes: number }>();
  for (const stock of stocks) {
    const current = occupied.get(stock.locationCode) ?? { pallets: 0, boxes: 0 };
    current.pallets += stock.palletCount;
    current.boxes += stock.totalBoxes;
    occupied.set(stock.locationCode, current);
  }

  return summaryZones.map(summary => {
    const zone = zones.find(zone => zone.id === summary.id);
    let remainingPallets = 0;
    let unconfiguredLocations = 0;
    const codes = [...new Set(zone?.codes ?? [])];
    for (const code of codes) {
      const box = zone?.layout?.[code];
      const usage = occupied.get(code) ?? { pallets: 0, boxes: 0 };
      const boxCapacity = box?.capacityBoxes ?? 0;
      // Match the existing full-location rule: either capacity limit can fill a slot.
      if (boxCapacity > 0 && usage.boxes >= boxCapacity) continue;
      const capacity = box?.capacityPallets;
      if (capacity === undefined || !Number.isFinite(capacity) || capacity <= 0) {
        unconfiguredLocations++;
        continue;
      }
      // Overflow at one location must not consume free space at another location.
      remainingPallets += Math.max(0, capacity - usage.pallets);
    }
    return { ...summary, remainingPallets: Number(remainingPallets.toFixed(8)), locationCount: codes.length, unconfiguredLocations };
  });
}

export function summarizeZoneLayerAvailability(zones:readonly CapacityZone[],stocks:readonly {locationCode:string;layerCount:number}[]) {
 const byCode=new Map<string,{layerCount:number}[]>();
 for(const stock of stocks)byCode.set(stock.locationCode,[...(byCode.get(stock.locationCode)??[]),stock]);
 return summaryZones.map(summary=>{const zone=zones.find(z=>z.id===summary.id),codes=[...new Set(zone?.codes??[])];let remainingLayers=0,unconfiguredLocations=0;
 for(const code of codes){const capacity=layerCapacity(zone?.layout?.[code],code);if(!capacity){unconfiguredLocations++;continue}remainingLayers+=layerUsage(byCode.get(code)??[],capacity).remaining??0}
 return {...summary,remainingLayers,locationCount:codes.length,unconfiguredLocations};});
}
