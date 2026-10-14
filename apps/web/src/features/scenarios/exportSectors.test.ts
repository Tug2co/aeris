import { describe, expect, it } from 'vitest';
import type { Assignment, Catalog, CoverageLayers, Mission } from '@aeris/shared';
import { buildSectorsGeoJSON } from './exportSectors';

const mission: Mission = {
  id: 'm1',
  name: 'Recherche Forêt de Bouconne',
  environment: 'rural',
  maxDrones: 3,
  phaseCount: 1,
  gridCellM: 100,
  workArea: {
    type: 'Polygon',
    coordinates: [
      [
        [1.2, 43.6],
        [1.3, 43.6],
        [1.3, 43.7],
        [1.2, 43.7],
        [1.2, 43.6],
      ],
    ],
  },
  pilots: [
    { id: 'p1', name: 'ADJ Martin', level: 'TP2' },
    { id: 'p2', name: 'GND Dupont', level: 'TP1' },
  ],
  resources: [
    { id: 'r1', pilotId: 'p1', droneModelId: 'm4t', available: true },
    { id: 'r2', pilotId: 'p2', droneModelId: 'm3e', available: true },
  ],
  priorityZones: [],
  constraintZones: [],
};

const catalog: Catalog = {
  drones: [
    {
      id: 'm4t',
      name: 'DJI Matrice 4T',
      enduranceMin: 45,
      maxWindMs: 12,
      rainOk: true,
      minTempC: -20,
      maxTempC: 50,
      zoomX: 56,
      thermal: true,
      night: true,
    },
    {
      id: 'm3e',
      name: 'DJI Mavic 3E',
      enduranceMin: 42,
      maxWindMs: 12,
      rainOk: false,
      minTempC: -10,
      maxTempC: 40,
      zoomX: 56,
      thermal: false,
      night: false,
    },
  ],
  rules: [],
};

const assignments: Assignment[] = [
  {
    resourceId: 'r1',
    phase: 0,
    position: { type: 'Point', coordinates: [1.22, 43.62] },
    radiusM: 2000,
    altitude: { minM: 95, maxM: 120 },
  },
  {
    resourceId: 'r2',
    phase: 0,
    position: { type: 'Point', coordinates: [1.26, 43.64] },
    radiusM: 1000,
    altitude: { minM: 65, maxM: 95 },
  },
];

const mockCoverage: CoverageLayers = {
  phase: 0,
  covered: { type: 'MultiPolygon', coordinates: [] },
  overlap: { type: 'MultiPolygon', coordinates: [] },
  gaps: { type: 'MultiPolygon', coordinates: [] },
  byResource: [
    {
      resourceId: 'r1',
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [1.2, 43.6],
              [1.25, 43.6],
              [1.25, 43.65],
              [1.2, 43.65],
              [1.2, 43.6],
            ],
          ],
        ],
      },
      areaM2: 5000000,
    },
    {
      resourceId: 'r2',
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [1.25, 43.6],
              [1.3, 43.6],
              [1.3, 43.65],
              [1.25, 43.65],
              [1.25, 43.6],
            ],
          ],
        ],
      },
      areaM2: 2500000,
    },
  ],
};

describe('buildSectorsGeoJSON', () => {
  it('construit un FeatureCollection complet avec les secteurs par drone', () => {
    const fc = buildSectorsGeoJSON(mission, 0, assignments, mockCoverage, catalog);
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.name).toBe('aeris-recherche-for-t-de-bouconne-phase-1');
    expect(fc.features).toHaveLength(2);

    const f1 = fc.features[0];
    expect(f1.id).toBe('r1');
    expect(f1.properties.resourceId).toBe('r1');
    expect(f1.properties.pilotName).toBe('ADJ Martin');
    expect(f1.properties.droneModel).toBe('DJI Matrice 4T');
    expect(f1.properties.altitudeMinM).toBe(95);
    expect(f1.properties.altitudeMaxM).toBe(120);
    expect(f1.properties.areaHa).toBe(500); // 5 000 000 m² = 500 ha
    expect(f1.geometry.type).toBe('MultiPolygon');

    const f2 = fc.features[1];
    expect(f2.id).toBe('r2');
    expect(f2.properties.pilotName).toBe('GND Dupont');
    expect(f2.properties.areaHa).toBe(250);
  });

  it('permet de filtrer sur un seul drone', () => {
    const fc = buildSectorsGeoJSON(mission, 0, assignments, mockCoverage, catalog, 'r2');
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].id).toBe('r2');
  });

  it('ignore les drones d’une autre phase', () => {
    const fc = buildSectorsGeoJSON(mission, 1, assignments, mockCoverage, catalog);
    expect(fc.features).toHaveLength(0);
  });
});
