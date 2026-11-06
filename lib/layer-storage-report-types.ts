import type {OutboundHistoryRecord} from './outbound-history';
import type {layerPricingSettingsFromRows} from './layer-storage-store';
import type {LayerHistoryIssue} from './layer-storage-history';
import type {CustomerPricingProfile} from './customer-pricing';
export type LayerSettingsDTO=ReturnType<typeof layerPricingSettingsFromRows>;
export type LayerStorageReportRow={
 section?:'in_stock'|'shipped';recordIds?:string[];palletCount?:number;estimatedPallets?:boolean;displayFeeUsd?:number|null;
 key:string;locationCode:string;layer:number;customerName:string;percent:number|null;volumeM3:number;sharedVolumeM3:number|null;products:string[];skus:string[];inboundDate:string|null;
 physicalLocations?:Array<{locationCode:string;layer:number;staged:boolean}>;
 startDate:string;endDateExclusive:string;storageDays:number;billableDays:number;freeDays:number|null;chargeStartDate:string|null;ratePerM3Day:number|null;feeUsd:number|null;status:'verified'|'review';reviewReasons:string[];evidenceIds:string[];calculationBasis:'history'|'current-occupancy';overlappingBillIds?:Array<string|number>;
};
export type UncalculableStorageRecord={key:string;kind:'current'|'outbound'|'history';customerName:string;product:string;sku:string;locationCode:string;layer:number|null;inboundDate:string|null;outboundDate:string|null;recordId?:string;historyKey?:string;reasons:string[];startDate:string;endDateExclusive:string};
export type StorageReportSections={inStock:{rows:LayerStorageReportRow[];feeUsd:number};shipped:{rows:LayerStorageReportRow[];feeUsd:number};uncalculable:UncalculableStorageRecord[]};
export type LayerStorageReport={
 sections?:StorageReportSections;
 outboundHistory?:OutboundHistoryRecord[];
 basis:'layer';asOf:string;period:{fromDate?:string;toDate?:string;fromMonth:string;toMonth:string;periodStart:string;periodEndExclusive:string};settings:LayerSettingsDTO;customerProfiles:CustomerPricingProfile[];
 current:{layerCount:number;volumeM3:number;dailyFeeUsd:number;pendingCount:number;rows:LayerStorageReportRow[]};rows:LayerStorageReportRow[];pending:LayerHistoryIssue[];
 totals:{verifiedFeeUsd:number;complete:boolean;pendingSegments:number;customerTotals:Array<{customerName:string;feeUsd:number;pendingCount:number}>};
 coverage:{checkpointAt:string|null;fromDate:string|null;currentOccupancyPeriods:Array<{startDate:string;endDateExclusive:string}>};confirmedHistory:{count:number;feeUsd:number;records:Record<string,unknown>[]};
};
