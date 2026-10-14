import { describe, expect, it } from 'vitest';
import { demoMission, drones, pilotRules } from '@aeris/data';
import { buildGrid } from '@aeris/geo';
import type { DroneModel, Mission } from '@aeris/shared';
import { chooseModels, genericFleet, needsSizing, sizeFleet, SIZING_PREFIX } from './sizing';

const planning = (patch: Partial<Mission> = {}): Mission => ({
  ...demoMission,
  id: 'plan',
  pilots: [],
  resources: [],
  ...patch,
});
const gridsOf = (m: Mission) => [...Array(m.phaseCount).keys()].map((p) => buildGrid(m, p));

const model = (id: string, caps: Partial<DroneModel> = {}): DroneModel => ({
  id,
  name: id,
  enduranceMin: 30,
  maxWindMs: 12,
  rainOk: false,
  minTempC: -10,
  maxTempC: 40,
  zoomX: 2,
  thermal: false,
  night: false,
  ...caps,
});

describe('dimensionnement de la flotte', () => {
  it('ne dimensionne que les missions sans moyens réels', () => {
    expect(needsSizing({ resources: [] })).toBe(true);
    const fleet = genericFleet(2, drones[0], []);
    expect(needsSizing(fleet)).toBe(true);
    expect(needsSizing(demoMission)).toBe(false);
  });

  it('flotte générique : un télépilote TP2 par drone, identifiants régénérables', () => {
    const { pilots, resources } = genericFleet(3, model('gen'), [model('spe')]);
    expect(pilots.map((p) => p.level)).toEqual(['TP2', 'TP2', 'TP2']);
    expect(resources.map((r) => r.droneModelId)).toEqual(['spe', 'gen', 'gen']);
    expect(resources.every((r) => r.id.startsWith(SIZING_PREFIX))).toBe(true);
    expect(new Set(resources.map((r) => r.pilotId)).size).toBe(3);
  });

  it('choisit le plus modeste, et un spécialiste par drone voulu là où il ne suffit pas', () => {
    const mini = model('mini', { zoomX: 4 });
    const thermique = model('thermique', { thermal: true, night: true, zoomX: 112 });
    const nuit = model('nuit', { night: true });
    // Phase 0 : deux zones thermiques ; phase 1 : une zone de nuit.
    const { generalist, specialists } = chooseModels(
      [thermique, nuit, mini],
      [[{ thermal: true }, { thermal: true }], [{ night: true }]],
    );
    expect(generalist?.id).toBe('mini');
    expect(specialists.map((m) => m.id)).toEqual(['thermique', 'thermique', 'nuit']);
  });

  it('sans exigence, aucun spécialiste', () => {
    const { generalist, specialists } = chooseModels(
      [model('gros', { thermal: true }), model('petit')],
      [[{}]],
    );
    expect(generalist?.id).toBe('petit');
    expect(specialists).toEqual([]);
  });

  it('sur la démo : du thermique seulement pour la zone qui l’exige', () => {
    const mission = planning({ maxDrones: 4, phaseCount: 1 });
    const res = sizeFleet({ mission, catalog: drones, rules: pilotRules, grids: gridsOf(mission) });
    const thermalZones = mission.priorityZones.filter((z) => z.requires?.thermal);
    const thermal = res.resources.filter(
      (r) => drones.find((d) => d.id === r.droneModelId)?.thermal,
    );
    expect(thermalZones.length).toBeGreaterThan(0);
    expect(thermal.length).toBe(Math.min(thermalZones.length, res.recommended));
    expect(new Set(res.resources.map((r) => r.droneModelId)).size).toBeGreaterThan(1);
  }, 60_000);

  it('sur la démo : la plus petite flotte proche de la meilleure couverture permise', () => {
    const mission = planning({ maxDrones: 4, phaseCount: 1 });
    const res = sizeFleet({ mission, catalog: drones, rules: pilotRules, grids: gridsOf(mission) });
    const best = res.trials.find((t) => t.drones === 4)!;
    const chosen = res.trials.find((t) => t.drones === res.recommended)!;
    expect(res.recommended).toBeGreaterThanOrEqual(1);
    expect(res.recommended).toBeLessThanOrEqual(4);
    expect(chosen.weightedCoverage).toBeGreaterThanOrEqual(best.weightedCoverage - 0.03);
    // Une flotte plus petite essayée fait nettement moins bien.
    for (const t of res.trials.filter((t) => t.drones < res.recommended))
      expect(t.weightedCoverage).toBeLessThan(best.weightedCoverage - 0.03);
    expect(res.resources).toHaveLength(res.recommended);
    expect(res.pilots).toHaveLength(res.recommended);
    expect(res.diagnostics[0]).toMatch(/^Dimensionnement : \d+ drone/);
  }, 60_000);

  it('écarte les modèles cloués au sol par la météo', () => {
    const mission = planning({ maxDrones: 1, phaseCount: 1, priorityZones: [] });
    const res = sizeFleet({
      mission,
      catalog: drones,
      rules: pilotRules,
      grids: gridsOf(mission),
      flyable: (m) => m.rainOk,
    });
    const models = new Set(res.resources.map((r) => r.droneModelId));
    for (const id of models) expect(drones.find((d) => d.id === id)?.rainOk).toBe(true);
  }, 60_000);

  it('explique quand aucun drone n’est possible', () => {
    const mission = planning({ maxDrones: 0 });
    const res = sizeFleet({ mission, catalog: drones, rules: pilotRules, grids: gridsOf(mission) });
    expect(res.recommended).toBe(0);
    expect(res.diagnostics[0]).toMatch(/arrêté/);
    const grounded = sizeFleet({
      mission: planning(),
      catalog: drones,
      rules: pilotRules,
      grids: gridsOf(planning()),
      flyable: () => false,
    });
    expect(grounded.diagnostics[0]).toMatch(/ne peut voler/);
  });
});
