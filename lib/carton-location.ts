import {remapSnapshotLocations,type LocationAliases} from './location-aliases';
/** Snapshots contain serialized placement JSON in the database row, unlike API views. */
export function remapCartonRowSnapshot(raw:string|null,aliases:LocationAliases){if(!raw)return raw;const row=JSON.parse(raw);if(typeof row.palletRawPlacements==='string')row.palletRawPlacements=remapSnapshotLocations(row.palletRawPlacements,aliases);if(typeof row.placements==='string')row.placements=remapSnapshotLocations(row.placements,aliases);return JSON.stringify(row);}
