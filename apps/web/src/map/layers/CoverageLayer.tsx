import { GeoJSON } from 'react-leaflet';
import type { GeoJsonObject } from 'geojson';
import type { CoverageLayers } from '@aeris/shared';
import { COVERAGE_COLORS, resourceColor } from '../colors';
import {
  isCoverageVisible,
  sectorStyle,
  useMapVisionStore,
  type MapVisionMode,
} from '../visionStore';

export { isCoverageVisible, sectorStyle };

const geo = (g: unknown) => g as GeoJsonObject;

/**
 * Couverture d'une phase calculée par @aeris/geo :
 * - Mode « Dispositif » : masquée pour laisser la carte dégagée.
 * - Mode « Secteurs » : polygones propres par drone (sans bordures internes parasites).
 * - Mode « Trous & Alertes » : couverture globale, chevauchements critiques (ambre) et trous (rouge).
 */
export function CoverageLayer({
  layers,
  showSectors = true,
  mode: propMode,
}: {
  layers: CoverageLayers;
  showSectors?: boolean;
  mode?: MapVisionMode;
}) {
  const storeMode = useMapVisionStore((s) => s.mode);
  const mode = propMode ?? storeMode;

  // En mode Dispositif, la couverture est masquée pour préserver la lisibilité de la carte.
  if (!isCoverageVisible(mode)) {
    return null;
  }

  // La clé change avec les géométries : react-leaflet ne met pas à jour `data` en place.
  const key = (name: string, g: unknown) => `${name}-${layers.phase}-${JSON.stringify(g).length}`;
  const allResourceIds = (layers.byResource ?? []).map((r) => r.resourceId);

  // Mode « Secteurs » : aplat doux par drone, sans quadrillage parasite (stroke: false).
  if (mode === 'secteurs') {
    if (!showSectors || !layers.byResource?.length) return null;
    return (
      <>
        {layers.byResource.map((rc) => (
          <GeoJSON
            key={key(`res-${rc.resourceId}`, rc.geometry)}
            data={geo(rc.geometry)}
            interactive={false}
            style={sectorStyle(resourceColor(rc.resourceId, allResourceIds))}
          />
        ))}
      </>
    );
  }

  // Mode « Trous & Alertes » : zones couvertes, chevauchements et trous.
  return (
    <>
      <GeoJSON
        key={key('cov', layers.covered)}
        data={geo(layers.covered)}
        interactive={false}
        style={{ stroke: false, fillColor: COVERAGE_COLORS.covered, fillOpacity: 0.08 }}
      />
      <GeoJSON
        key={key('ovl', layers.overlap)}
        data={geo(layers.overlap)}
        interactive={false}
        style={{ stroke: false, fillColor: COVERAGE_COLORS.overlap, fillOpacity: 0.28 }}
      />
      <GeoJSON
        key={key('gap', layers.gaps)}
        data={geo(layers.gaps)}
        interactive={false}
        style={{
          color: COVERAGE_COLORS.gaps,
          weight: 2,
          dashArray: '4 4',
          fillColor: COVERAGE_COLORS.gaps,
          fillOpacity: 0.15,
        }}
      />
    </>
  );
}
