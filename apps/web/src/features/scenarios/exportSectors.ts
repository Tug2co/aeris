import type { Assignment, Catalog, CoverageLayers, Mission } from '@aeris/shared';
import { resourceLabel } from '../resourceLabel';

export interface SectorFeatureProperties {
  resourceId: string;
  label: string;
  pilotName?: string;
  pilotLevel?: string;
  droneModel?: string;
  phase: number;
  altitudeMinM: number;
  altitudeMaxM: number;
  areaHa: number;
  slot?: string;
}

export interface SectorFeature {
  type: 'Feature';
  id: string;
  properties: SectorFeatureProperties;
  geometry: CoverageLayers['covered'];
}

export interface SectorsFeatureCollection {
  type: 'FeatureCollection';
  name: string;
  features: SectorFeature[];
}

/**
 * Construit un FeatureCollection GeoJSON normalisé contenant les secteurs géométriques
 * d'intervention propres à chaque drone engagé sur la phase.
 */
export function buildSectorsGeoJSON(
  mission: Mission,
  phase: number,
  assignments: Assignment[],
  coverage?: CoverageLayers,
  catalog?: Catalog,
  filterResourceId?: string,
): SectorsFeatureCollection {
  const inPhase = assignments.filter((a) => a.phase === phase);
  const byResourceMap = new Map((coverage?.byResource ?? []).map((r) => [r.resourceId, r]));

  const features: SectorFeature[] = [];

  for (const a of inPhase) {
    if (filterResourceId && a.resourceId !== filterResourceId) continue;
    const res = mission.resources.find((r) => r.id === a.resourceId);
    const pilot = mission.pilots.find((p) => p.id === res?.pilotId);
    const model = catalog?.drones.find((d) => d.id === res?.droneModelId);
    const cov = byResourceMap.get(a.resourceId);
    const geometry = (cov?.geometry ?? a.sector) as CoverageLayers['covered'] | undefined;
    if (!geometry) continue;

    features.push({
      type: 'Feature',
      id: a.resourceId,
      properties: {
        resourceId: a.resourceId,
        label: resourceLabel(mission, a.resourceId, catalog),
        pilotName: pilot?.name,
        pilotLevel: pilot?.level,
        droneModel: model?.name,
        phase: phase + 1,
        altitudeMinM: a.altitude.minM,
        altitudeMaxM: a.altitude.maxM,
        areaHa: cov ? Math.round(cov.areaM2 / 10000) : 0,
        slot: a.slot ? `${a.slot.start} – ${a.slot.end}` : undefined,
      },
      geometry,
    });
  }

  const safeMissionName = mission.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    type: 'FeatureCollection',
    name: `aeris-${safeMissionName}-phase-${phase + 1}`,
    features,
  };
}

/**
 * Déclenche le téléchargement direct d'un objet au format GeoJSON dans le navigateur.
 */
export function downloadGeoJson(filename: string, data: object): void {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.geojson') ? filename : `${filename}.geojson`;
  a.click();
  URL.revokeObjectURL(url);
}
