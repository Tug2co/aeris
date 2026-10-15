import { beforeAll, describe, expect, it } from 'vitest';
import { drones, pilotRules, testMissions, type TestMission } from '@aeris/data';
import {
  Assignment,
  SolveStatus,
  ruleFor,
  type GridBuilder,
  type Mission,
  type SolveContext,
  type SolveResult,
  type Solver,
  type Strategy,
} from '@aeris/shared';
import { inArea, mentions } from './helpers';

/** Au-delà, l'API devient inutilisable en démo (3 stratégies × N phases). */
export const SOLVER_TIME_LIMIT_MS = 6000;

const STRATEGIES: Strategy[] = ['couverture_globale', 'priorite', 'economie_moyens'];

interface Case {
  label: string;
  tm: TestMission;
  phase: number;
  strategy: Strategy;
  excluded?: Record<string, string>;
}

function cases(): Case[] {
  const out: Case[] = [];
  for (const tm of testMissions) {
    // Toutes les stratégies sur la démo, une seule ailleurs (temps de CI).
    const strategies: Strategy[] = tm.name === 'demo' ? STRATEGIES : ['priorite'];
    const phases =
      tm.name === 'demo' || tm.name === 'trois-phases'
        ? [...Array(tm.mission.phaseCount).keys()]
        : [0];
    for (const strategy of strategies)
      for (const phase of phases)
        out.push({ label: `${tm.name} · phase ${phase} · ${strategy}`, tm, phase, strategy });
  }
  const demo = testMissions.find((t) => t.name === 'demo')!;
  out.push({
    label: 'demo · r1 et r4 exclus par la météo',
    tm: demo,
    phase: 0,
    strategy: 'priorite',
    excluded: { r1: 'météo (test)', r4: 'météo (test)' },
  });
  return out;
}

/** Plafond maximal autorisé pour le couple (urbain possible si la mission a des zones urbaines). */
function ceilingFor(mission: Mission, level: 'TP1' | 'TP2'): number {
  const rule = ruleFor(pilotRules, level);
  const hasUrban =
    mission.environment === 'urbain' || mission.constraintZones.some((c) => c.kind === 'urbaine');
  return hasUrban
    ? Math.max(rule.maxHeightM.rural, rule.maxHeightM.urbain)
    : rule.maxHeightM[mission.environment];
}

/**
 * Contrat de tout `Solver` (glouton, ILP…) : à appeler depuis un fichier *.test.ts.
 *   solverContract('greedy', greedySolve, { buildGrid });
 */
export function solverContract(name: string, solver: Solver, deps: { buildGrid: GridBuilder }) {
  describe(`Contrat Solver — ${name}`, () => {
    for (const c of cases()) {
      describe(c.label, () => {
        const { mission } = c.tm;
        let res: SolveResult;
        let elapsed = 0;
        const excluded = c.excluded ?? {};
        const pilotLevel = (resourceId: string) => {
          const r = mission.resources.find((x) => x.id === resourceId)!;
          return mission.pilots.find((p) => p.id === r.pilotId)!.level;
        };

        beforeAll(async () => {
          const ctx: SolveContext = {
            mission,
            catalog: drones,
            rules: pilotRules,
            grid: deps.buildGrid(mission, c.phase),
            phase: c.phase,
            strategy: c.strategy,
            excluded,
          };
          const t0 = Date.now();
          res = await solver(ctx);
          elapsed = Date.now() - t0;
        }, 60_000);

        it(`répond en moins de ${SOLVER_TIME_LIMIT_MS} ms`, () => {
          expect(elapsed).toBeLessThan(SOLVER_TIME_LIMIT_MS);
        });

        it('renvoie un résultat conforme aux schémas', () => {
          expect(() => SolveStatus.parse(res.status)).not.toThrow();
          for (const a of res.assignments) expect(() => Assignment.parse(a)).not.toThrow();
          expect(res.diagnostics.every((d) => typeof d === 'string')).toBe(true);
        });

        it('affecte la phase demandée, au plus une fois chaque couple', () => {
          for (const a of res.assignments) expect(a.phase).toBe(c.phase);
          const ids = res.assignments.map((a) => a.resourceId);
          expect(new Set(ids).size).toBe(ids.length);
        });

        it("respecte l'arrêté (maxDrones)", () => {
          expect(res.assignments.length).toBeLessThanOrEqual(mission.maxDrones);
        });

        it("n'emploie que des couples connus, disponibles et non exclus — et dit pourquoi les autres sont écartés", () => {
          for (const a of res.assignments) {
            const r = mission.resources.find((x) => x.id === a.resourceId);
            expect(r, `couple inconnu ${a.resourceId}`).toBeDefined();
            expect(r!.available, `${a.resourceId} indisponible`).toBe(true);
            expect(excluded[a.resourceId], `${a.resourceId} exclu`).toBeUndefined();
          }
          for (const r of mission.resources) {
            if (!r.available || excluded[r.id]) {
              expect(mentions(res.diagnostics, r.id), `diagnostic manquant pour ${r.id}`).toBe(
                true,
              );
            }
          }
        });

        it('respecte positions imposées, zones limites, zone de travail et zones interdites', () => {
          const forbidden = mission.constraintZones.filter((z) => z.kind === 'interdite');
          for (const a of res.assignments) {
            const r = mission.resources.find((x) => x.id === a.resourceId)!;
            const p = a.position.coordinates;
            if (r.fixedPosition) {
              expect(p, `${r.id} doit rester à sa position imposée`).toEqual(
                r.fixedPosition.coordinates,
              );
              continue;
            }
            if (r.allowedArea)
              expect(inArea(p, r.allowedArea), `${r.id} hors zone limite`).toBe(true);
            expect(inArea(p, mission.workArea), `${r.id} hors zone de travail`).toBe(true);
            for (const z of forbidden)
              expect(inArea(p, z.geometry), `${r.id} dans ${z.name}`).toBe(false);
          }
        });

        it('respecte portée et plafond du niveau de télépilote', () => {
          for (const a of res.assignments) {
            const level = pilotLevel(a.resourceId);
            expect(a.radiusM).toBeGreaterThan(0);
            expect(a.radiusM).toBeLessThanOrEqual(ruleFor(pilotRules, level).rangeM);
            expect(a.altitude.minM).toBeGreaterThanOrEqual(0);
            expect(a.altitude.minM).toBeLessThan(a.altitude.maxM);
            expect(a.altitude.maxM).toBeLessThanOrEqual(ceilingFor(mission, level));
          }
        });

        it('statut cohérent : infaisable ⇒ explication ; aucun moyen employable ⇒ infaisable', () => {
          if (res.status === 'infaisable') expect(res.diagnostics.length).toBeGreaterThan(0);
          const employable = mission.resources.filter((r) => r.available && !excluded[r.id]);
          if (employable.length === 0 || mission.maxDrones === 0) {
            expect(res.status).toBe('infaisable');
            expect(res.assignments).toHaveLength(0);
          }
        });
      });
    }
  });
}
