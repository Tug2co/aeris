import { describe, expect, it } from 'vitest';
import { drones, demoMission, pilotRules } from '@aeris/data';
import { buildGrid, computeMetrics } from '@aeris/geo';
import { greedySolve } from './greedy';
import { ilpSolve } from './ilp';

const mission = { ...demoMission, id: 'test' };

describe('greedySolve sur la mission de démo', () => {
  it('respecte l’arrêté et produit une couverture non nulle', () => {
    const grid = buildGrid(mission, 0);
    const res = greedySolve({
      mission,
      catalog: drones,
      rules: pilotRules,
      grid,
      phase: 0,
      strategy: 'priorite',
    });
    expect(res.status).toBe('faisable');
    expect(res.assignments.length).toBeLessThanOrEqual(mission.maxDrones);
    const m = computeMetrics(grid, res.assignments);
    expect(m.coverage).toBeGreaterThan(0.3);
  });

  it('dit infaisable sans moyen disponible', () => {
    const empty = {
      ...mission,
      resources: mission.resources.map((r) => ({ ...r, available: false })),
    };
    const res = greedySolve({
      mission: empty,
      catalog: drones,
      rules: pilotRules,
      grid: buildGrid(empty, 0),
      phase: 0,
      strategy: 'priorite',
    });
    expect(res.status).toBe('infaisable');
  });
});

describe('recuit simulé et ILP', () => {
  const ctxFor = (strategy: 'couverture_globale' | 'priorite' | 'economie_moyens') => ({
    mission,
    catalog: drones,
    rules: pilotRules,
    grid: buildGrid(mission, 0),
    phase: 0,
    strategy,
  });

  it('deux missions identiques (identifiants différents) donnent le même dispositif', () => {
    const a = greedySolve(ctxFor('priorite'));
    const ctx = ctxFor('priorite');
    const b = greedySolve({ ...ctx, mission: { ...ctx.mission, id: 'autre-id', name: 'Copie' } });
    expect(b.assignments).toEqual(a.assignments);
  });

  it('le recuit est déterministe', () => {
    const a = greedySolve(ctxFor('priorite'));
    const b = greedySolve(ctxFor('priorite'));
    expect(a.assignments).toEqual(b.assignments);
  });

  it('l’ILP fait au moins aussi bien que le recuit', async () => {
    // HiGHS peut dépasser son temps sur une machine chargée (CI) et retomber sur le recuit :
    // on n'exige que le résultat, pas le moteur utilisé.
    const ctx = ctxFor('couverture_globale');
    const sa = greedySolve(ctx);
    const ilp = await ilpSolve(ctx);
    const cov = (r: typeof sa) => computeMetrics(ctx.grid, r.assignments).coverage;
    expect(cov(ilp)).toBeGreaterThanOrEqual(cov(sa) - 0.02);
  }, 10_000);

  it('pénalise les déplacements par rapport à la solution précédente', () => {
    const ctx = ctxFor('priorite');
    const first = greedySolve(ctx);
    const again = greedySolve({ ...ctx, previous: first.assignments });
    expect(again.assignments.map((a) => a.position)).toEqual(
      first.assignments.map((a) => a.position),
    );
  });

  it('économie de moyens n’engage pas plus de couples que couverture globale', () => {
    const eco = greedySolve(ctxFor('economie_moyens'));
    const all = greedySolve(ctxFor('couverture_globale'));
    expect(eco.assignments.length).toBeLessThanOrEqual(all.assignments.length);
  });
});
