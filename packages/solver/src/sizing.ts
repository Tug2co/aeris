import {
  meetsRequirement,
  type Cell,
  type DroneModel,
  type Grid,
  type Mission,
  type Pilot,
  type PilotLevel,
  type PilotRule,
  type Requirement,
  type Resource,
} from '@aeris/shared';
import { computeMetrics } from '@aeris/geo';
import { anneal, seedOf } from './greedy';
import { buildProblem, isProblem, toResult } from './problem';

/**
 * Dimensionnement d'une opération en planification : combien de drones (et donc de
 * télépilotes, un par drone) faut-il, et lesquels, pour couvrir la mission ?
 *
 * On ne connaît pas encore les moyens réels : on compose une flotte générique à partir de la
 * bibliothèque de drones, on la fait placer par le recuit (greedySolve) pour plusieurs
 * tailles, et on retient la plus petite dont la couverture pondérée approche celle du
 * plafond de l'arrêté. Le placement final reste fait par le solveur habituel.
 */

/** Préfixe des télépilotes et couples générés : on les régénère tant qu'ils restent génériques. */
export const SIZING_PREFIX = 'auto-';

/** Écart toléré avec la meilleure couverture atteignable (points de couverture pondérée). */
export const SIZING_TOLERANCE = 0.03;

/** Au-delà, l'essai devient long et l'opération irréaliste : on plafonne la recherche. */
export const SIZING_MAX_DRONES = 16;

/**
 * Recuit raccourci pour les essais : on compare des tailles de flotte, pas des placements.
 * Le placement final de la flotte retenue est fait par le solveur complet.
 */
export const SIZING_ITERATIONS = 6000;

/** Niveau des télépilotes proposés : portée de 2 km et hauteurs plus élevées. */
export const SIZING_LEVEL: PilotLevel = 'TP2';

export interface SizingInput {
  mission: Mission;
  catalog: DroneModel[];
  rules: PilotRule[];
  /** Grille de chaque phase (elles ne dépendent pas des moyens). */
  grids: Grid[];
  /** Modèles qui peuvent voler avec la météo du moment (absent = tous). */
  flyable?: (model: DroneModel) => boolean;
}

export interface SizingTrial {
  drones: number;
  /** Couverture pondérée moyenne sur les phases, 0..1. */
  weightedCoverage: number;
  /** Toutes les zones prioritaires actives ont un drone. */
  feasible: boolean;
}

export interface SizingResult {
  /** Nombre de drones recommandé (= nombre de télépilotes). */
  recommended: number;
  pilots: Pilot[];
  resources: Resource[];
  /** Composition : modèle et nombre. */
  fleet: { model: DroneModel; count: number }[];
  /** Essais réalisés, du plus petit au plus grand. */
  trials: SizingTrial[];
  diagnostics: string[];
}

/** La mission n'a que des moyens générés (ou aucun) : il faut la dimensionner. */
export function needsSizing(mission: Pick<Mission, 'resources'>): boolean {
  return mission.resources.every((r) => r.id.startsWith(SIZING_PREFIX));
}

const capabilityScore = (m: DroneModel) =>
  (m.thermal ? 4 : 0) + (m.night ? 2 : 0) + (m.rainOk ? 1 : 0) + m.zoomX / 1000;

/** Le plus modeste d'abord ; à capacités égales, la plus grande autonomie. */
const modest = (a: DroneModel, b: DroneModel) =>
  capabilityScore(a) - capabilityScore(b) || b.enduranceMin - a.enduranceMin;

const hasRequirement = (r: Requirement) => !!(r.thermal || r.night || r.minZoomX !== undefined);

/**
 * Modèles de la flotte : un « généraliste », le plus modeste de la bibliothèque (les cellules
 * sans exigence n'ont besoin que d'un drone en l'air : la portée dépend du télépilote, pas du
 * modèle), et des spécialistes pour les zones dont il ne tient pas l'exigence. Chaque
 * spécialiste est le modèle le plus modeste qui la tient, autant que de drones voulus dans ces
 * zones (redondance comprise), au maximum sur les phases.
 *
 * `needsByPhase` : pour chaque phase, l'exigence de chaque drone voulu dans les zones
 * prioritaires actives (une entrée par drone).
 */
export function chooseModels(
  models: DroneModel[],
  needsByPhase: Requirement[][],
): { generalist?: DroneModel; specialists: DroneModel[] } {
  if (!models.length) return { specialists: [] };
  const byModesty = [...models].sort(modest);
  const generalist = byModesty[0]!;
  const needed = new Map<DroneModel, number>();
  for (const needs of needsByPhase) {
    const inPhase = new Map<DroneModel, number>();
    for (const req of needs) {
      if (meetsRequirement(generalist, req)) continue;
      const m = byModesty.find((x) => meetsRequirement(x, req));
      if (m) inPhase.set(m, (inPhase.get(m) ?? 0) + 1);
    }
    for (const [m, n] of inPhase) needed.set(m, Math.max(needed.get(m) ?? 0, n));
  }
  const specialists = [...needed]
    .sort(([a], [b]) => modest(b, a))
    .flatMap(([m, n]) => Array<DroneModel>(n).fill(m));
  return { generalist, specialists };
}

/** Flotte générique de n drones : spécialistes d'abord, puis le généraliste. */
export function genericFleet(
  n: number,
  generalist: DroneModel,
  specialists: DroneModel[],
): { pilots: Pilot[]; resources: Resource[] } {
  const pilots: Pilot[] = [];
  const resources: Resource[] = [];
  for (let i = 0; i < n; i++) {
    const model = specialists[i] ?? generalist;
    const pilotId = `${SIZING_PREFIX}p${i + 1}`;
    pilots.push({ id: pilotId, name: `Télépilote ${i + 1}`, level: SIZING_LEVEL });
    resources.push({
      id: `${SIZING_PREFIX}r${i + 1}`,
      pilotId,
      droneModelId: model.id,
      available: true,
    });
  }
  return { pilots, resources };
}

/** Le solveur pose un drone dans chaque zone prioritaire active : il en faut au moins autant. */
function activeZonesMax(grids: Grid[], mission: Mission): number {
  return Math.max(
    0,
    ...grids.map(
      (_, phase) =>
        mission.priorityZones.filter((z) => !z.phases?.length || z.phases.includes(phase)).length,
    ),
  );
}

export function sizeFleet(input: SizingInput): SizingResult {
  const { mission, catalog, rules, grids } = input;
  const models = catalog.filter((m) => input.flyable?.(m) ?? true);
  const empty = (diagnostic: string): SizingResult => ({
    recommended: 0,
    pilots: [],
    resources: [],
    fleet: [],
    trials: [],
    diagnostics: [diagnostic],
  });
  if (mission.maxDrones <= 0)
    return empty('Dimensionnement impossible : l’arrêté n’autorise aucun drone');
  if (!models.length)
    return empty('Dimensionnement impossible : aucun drone de la bibliothèque ne peut voler');

  const needsByPhase = grids.map((_, phase) =>
    mission.priorityZones
      .filter((z) => !z.phases?.length || z.phases.includes(phase))
      .filter((z) => hasRequirement(z.requires ?? {}))
      .flatMap((z) => Array<Requirement>(Math.max(1, z.redundancy ?? 1)).fill(z.requires)),
  );
  const { generalist, specialists } = chooseModels(models, needsByPhase);
  if (!generalist) return empty('Dimensionnement impossible : bibliothèque vide');

  const nMax = Math.min(mission.maxDrones, SIZING_MAX_DRONES);
  const trials = new Map<number, SizingTrial>();
  const trial = (n: number): SizingTrial => {
    const cached = trials.get(n);
    if (cached) return cached;
    const fleet = genericFleet(n, generalist, specialists);
    const sized: Mission = { ...mission, ...fleet };
    const modelOf = new Map(
      fleet.resources.map((r) => [r.id, catalog.find((m) => m.id === r.droneModelId)]),
    );
    const canServe = (resourceId: string, cell: Cell) => {
      const m = modelOf.get(resourceId);
      return !!m && meetsRequirement(m, cell.requires);
    };
    let total = 0;
    let feasible = true;
    grids.forEach((grid, phase) => {
      const ctx = {
        mission: sized,
        catalog,
        rules,
        grid,
        phase,
        strategy: 'couverture_globale' as const,
      };
      const problem = buildProblem(ctx);
      const res = isProblem(problem)
        ? toResult(problem, anneal(problem, { seed: seedOf(ctx), iterations: SIZING_ITERATIONS }))
        : problem;
      if (res.status === 'infaisable') feasible = false;
      total += computeMetrics(grid, res.assignments, { canServe }).weightedCoverage;
    });
    const t = { drones: n, weightedCoverage: total / Math.max(grids.length, 1), feasible };
    trials.set(n, t);
    return t;
  };

  // Meilleure couverture atteignable avec le plafond, puis recherche dichotomique de la plus
  // petite flotte qui s'en approche (la couverture croît avec le nombre de drones).
  const best = trial(nMax);
  const good = (t: SizingTrial) =>
    (t.feasible || !best.feasible) &&
    t.weightedCoverage >= best.weightedCoverage - SIZING_TOLERANCE;
  let lo = Math.min(Math.max(1, activeZonesMax(grids, mission), specialists.length), nMax);
  let hi = nMax;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (good(trial(mid))) hi = mid;
    else lo = mid + 1;
  }
  const recommended = lo;
  const chosen = trial(recommended);
  const fleetResources = genericFleet(recommended, generalist, specialists);

  const counts = new Map<DroneModel, number>();
  for (const r of fleetResources.resources) {
    const m = catalog.find((x) => x.id === r.droneModelId)!;
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  const fleet = [...counts].map(([model, count]) => ({ model, count }));
  const pct = (x: number) => `${Math.round(x * 100)} %`;
  const diagnostics = [
    `Dimensionnement : ${recommended} drone(s) et ${recommended} télépilote(s) ${SIZING_LEVEL} (${fleet
      .map((f) => `${f.count} × ${f.model.name}`)
      .join(', ')})`,
    recommended < nMax
      ? `Couverture pondérée attendue : ${pct(chosen.weightedCoverage)} avec ${recommended} drone(s), ${pct(best.weightedCoverage)} avec ${nMax} : un drone de plus apporte peu`
      : `Couverture pondérée attendue : ${pct(chosen.weightedCoverage)} ; le plafond de ${nMax} drone(s) est entièrement utile`,
  ];
  if (!chosen.feasible)
    diagnostics.push(
      'Certaines zones prioritaires restent sans drone, même au plafond de l’arrêté',
    );

  return {
    recommended,
    ...fleetResources,
    fleet,
    trials: [...trials.values()].sort((a, b) => a.drones - b.drones),
    diagnostics,
  };
}
