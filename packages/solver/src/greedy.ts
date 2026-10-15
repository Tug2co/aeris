import { booleanPointInPolygon } from '@turf/turf';
import type { Cell, SolveContext, SolveResult } from '@aeris/shared';
import { distanceM } from '@aeris/geo';
import {
  addCandidate,
  buildProblem,
  candidateCost,
  holeValue,
  isProblem,
  marginal,
  toResult,
  type Problem,
} from './problem';

/**
 * Nombre d'itérations du recuit (≈ 100 ms sur la mission de démo). Pas de chronomètre, ni ici
 * ni dans l'affinage : le résultat ne doit pas dépendre de la charge de la machine (CI, démo).
 */
const ITERATIONS = 24_000;
/** Température finale relative à la température initiale. */
const FINAL_TEMPERATURE_RATIO = 1e-3;
/** Affinage final : rayon de recherche autour de chaque drone, et nombre max de passes. */
const REFINE_RADIUS_M = 300;
const REFINE_ROUNDS = 6;
/** Probabilité de chercher le nouveau candidat près de la position courante. */
const LOCAL_MOVE_PROBABILITY = 0.7;

/** Générateur pseudo-aléatoire déterministe (mulberry32) : mêmes entrées ⇒ même solution. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedOf(ctx: SolveContext): number {
  let h = 2166136261;
  // Graine tirée du CONTENU de la mission, pas de son identifiant (aléatoire à chaque création) :
  // deux missions identiques donnent le même dispositif.
  const { id: _id, name: _name, ...contenu } = ctx.mission;
  for (const ch of `${JSON.stringify(contenu)}|${ctx.phase}|${ctx.strategy}`)
    h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h;
}

/**
 * État incrémental : nombre de couples qui servent chaque cellule, nombre de drones posés
 * dans chaque zone prioritaire active, score courant.
 */
class State {
  readonly count: Int32Array;
  /** Drones (capables ou non) qui voient chaque cellule : 0 = trou. */
  readonly seen: Int32Array;
  readonly zoneCount: Int32Array;
  readonly choice: Int32Array;
  readonly pilotChoice = new Map<string, number>();
  engaged = 0;
  value = 0;

  constructor(private readonly p: Problem) {
    this.count = new Int32Array(p.weights.length);
    this.seen = new Int32Array(p.weights.length);
    this.zoneCount = new Int32Array(p.zones.length);
    this.choice = new Int32Array(p.usable.length).fill(-1);
  }

  /** Zones prioritaires pourvues d'au moins un drone. */
  zonesHeld(): number {
    let n = 0;
    for (const c of this.zoneCount) if (c > 0) n++;
    return n;
  }

  /** Retire le couple k de sa position ; renvoie la variation de score. */
  remove(k: number): number {
    const j = this.choice[k]!;
    if (j < 0) return 0;
    const u = this.p.usable[k]!;
    let d = candidateCost(this.p, k, j);
    for (const i of u.covers[j]!) {
      if (--this.seen[i]! === 0) d -= holeValue(this.p, i);
      if (u.capable[i]) d -= marginal(this.p, i, --this.count[i]!);
    }
    for (const z of u.zonesIn[j]!) if (--this.zoneCount[z]! === 0) d -= this.p.zoneValue;
    this.choice[k] = -1;
    this.pilotChoice.delete(u.res.pilotId);
    this.engaged--;
    this.value += d;
    return d;
  }

  /** Place le couple k (non placé) au candidat j ; renvoie la variation de score. */
  add(k: number, j: number): number {
    const u = this.p.usable[k]!;
    let d = -candidateCost(this.p, k, j);
    for (const i of u.covers[j]!) {
      if (this.seen[i]!++ === 0) d += holeValue(this.p, i);
      if (u.capable[i]) d += marginal(this.p, i, this.count[i]!++);
    }
    for (const z of u.zonesIn[j]!) if (this.zoneCount[z]!++ === 0) d += this.p.zoneValue;
    this.choice[k] = j;
    this.pilotChoice.set(u.res.pilotId, k);
    this.engaged++;
    this.value += d;
    return d;
  }

  /** Gain qu'apporterait le couple k (non placé) au candidat j, sans modifier l'état. */
  gainAt(k: number, j: number): number {
    const u = this.p.usable[k]!;
    let d = -candidateCost(this.p, k, j);
    for (const i of u.covers[j]!) {
      if (this.seen[i]! === 0) d += holeValue(this.p, i);
      if (u.capable[i]) d += marginal(this.p, i, this.count[i]!);
    }
    for (const z of u.zonesIn[j]!) if (this.zoneCount[z]! === 0) d += this.p.zoneValue;
    return d;
  }
}

/**
 * Construction gloutonne : positions imposées, puis les couples déjà placés par la solution
 * précédente restent où ils étaient (stabilité), puis chaque autre couple (portées
 * décroissantes) à sa meilleure position, s'il apporte quelque chose et que l'arrêté le permet.
 */
function construct(p: Problem): State {
  const s = new State(p);
  p.usable.forEach((u, k) => {
    if (u.fixed && s.engaged < p.maxEngaged && !s.pilotChoice.has(u.res.pilotId)) s.add(k, 0);
  });
  p.usable.forEach((u, k) => {
    if (s.engaged >= p.maxEngaged || u.fixed || u.prevIndex < 0 || s.pilotChoice.has(u.res.pilotId))
      return;
    if (s.gainAt(k, u.prevIndex) > 0) s.add(k, u.prevIndex);
  });
  p.usable.forEach((u, k) => {
    if (
      s.choice[k]! >= 0 ||
      u.fixed ||
      s.engaged >= p.maxEngaged ||
      s.pilotChoice.has(u.res.pilotId)
    )
      return;
    let best = -1;
    let bestGain = 0;
    for (let j = 0; j < u.candidates.length; j++) {
      const g = s.gainAt(k, j);
      if (g > bestGain) {
        bestGain = g;
        best = j;
      }
    }
    if (best >= 0) s.add(k, best);
  });
  return s;
}

/** Candidat aléatoire de k, de préférence proche de `near` (déplacement local). */
function pickCandidate(
  p: Problem,
  k: number,
  near: [number, number] | undefined,
  rand: () => number,
) {
  const u = p.usable[k]!;
  const n = u.candidates.length;
  if (near && rand() < LOCAL_MOVE_PROBABILITY) {
    // Quelques tirages pour trouver un voisin à moins d'un demi-rayon (en degrés, approximatif).
    const maxDeg = u.radius / 2 / 111_000;
    for (let t = 0; t < 12; t++) {
      const j = Math.floor(rand() * n);
      const c = u.candidates[j]!;
      if (Math.abs(c[0] - near[0]) < maxDeg * 1.5 && Math.abs(c[1] - near[1]) < maxDeg) return j;
    }
  }
  return Math.floor(rand() * n);
}

export interface AnnealOptions {
  /** Solution de départ (sinon construction gloutonne). */
  init?: Int32Array;
  iterations?: number;
  /** Température initiale relative au gain moyen d'un couple engagé. */
  temperature?: number;
  seed?: number;
}

/**
 * Recuit simulé sur le modèle commun. Voisinages : déplacer un couple, l'engager,
 * le désengager, ou en échanger deux (un engagé contre un libre quand l'arrêté est atteint).
 * Renvoie la meilleure solution rencontrée.
 */
export function anneal(p: Problem, opts: AnnealOptions = {}): Int32Array {
  let s: State;
  if (opts.init) {
    s = new State(p);
    opts.init.forEach((j, k) => {
      if (j >= 0 && !s.pilotChoice.has(p.usable[k]!.res.pilotId)) s.add(k, j);
    });
  } else s = construct(p);

  const movable = p.usable.map((u, k) => (u.fixed ? -1 : k)).filter((k) => k >= 0);
  if (movable.length === 0) return s.choice.slice();

  const rand = rng(opts.seed ?? 1);
  const iterations = opts.iterations ?? ITERATIONS;
  // Échelle de température : gain moyen d'un drone, hors valeur (énorme) des zones pourvues.
  const coverValue = s.value - s.zonesHeld() * p.zoneValue;
  const meanGain = Math.max(coverValue / Math.max(s.engaged, 1), p.totalWeight * 0.01, 1e-9);
  const t0 = meanGain * (opts.temperature ?? 0.1);
  const cooling = Math.pow(FINAL_TEMPERATURE_RATIO, 1 / iterations);

  let best = s.choice.slice();
  let bestValue = s.value;
  let temp = t0;

  for (let it = 0; it < iterations; it++, temp *= cooling) {
    const k = movable[Math.floor(rand() * movable.length)]!;
    const j = s.choice[k]!;
    const u = p.usable[k]!;
    // Mouvement appliqué puis annulé si refusé : `undo` restaure l'état exact.
    let delta = 0;
    let undo: () => void;

    if (j >= 0 && rand() < 0.9) {
      // Déplacement (ou, rarement, désengagement).
      const nj = rand() < 0.95 ? pickCandidate(p, k, u.candidates[j], rand) : -1;
      if (nj === j) continue;
      delta += s.remove(k);
      if (nj >= 0) delta += s.add(k, nj);
      undo = () => {
        if (nj >= 0) s.remove(k);
        s.add(k, j);
      };
    } else if (j >= 0) {
      delta += s.remove(k);
      undo = () => s.add(k, j);
    } else {
      const pilotResource = s.pilotChoice.get(u.res.pilotId);
      if (pilotResource !== undefined) {
        if (p.usable[pilotResource]!.fixed) continue;
        const pilotPosition = s.choice[pilotResource]!;
        const nj = pickCandidate(p, k, p.usable[pilotResource]!.candidates[pilotPosition], rand);
        delta += s.remove(pilotResource);
        delta += s.add(k, nj);
        undo = () => {
          s.remove(k);
          s.add(pilotResource, pilotPosition);
        };
      } else if (s.engaged < p.maxEngaged) {
        const nj = pickCandidate(p, k, undefined, rand);
        delta += s.add(k, nj);
        undo = () => s.remove(k);
      } else {
        // Arrêté atteint : échange avec un couple engagé non imposé, repris près de sa position.
        const others = movable.filter((o) => s.choice[o]! >= 0);
        if (others.length === 0) continue;
        const o = others[Math.floor(rand() * others.length)]!;
        const oj = s.choice[o]!;
        const nj = pickCandidate(p, k, p.usable[o]!.candidates[oj], rand);
        delta += s.remove(o);
        delta += s.add(k, nj);
        undo = () => {
          s.remove(k);
          s.add(o, oj);
        };
      }
    }

    if (delta >= 0 || rand() < Math.exp(delta / temp)) {
      if (s.value > bestValue + 1e-9) {
        bestValue = s.value;
        best = s.choice.slice();
      }
    } else undo();
  }
  return best;
}

/**
 * Affinage au pas de la grille (100 m) : les candidats du recuit sont espacés de 300 m, ce qui
 * laisse des interstices entre disques. Chaque drone essaie les cellules voisines de sa
 * position et garde la meilleure ; on recommence tant qu'une passe améliore le score.
 */
export function refine(p: Problem, choice: Int32Array): Int32Array {
  const s = new State(p);
  choice.forEach((j, k) => {
    if (j >= 0) s.add(k, j);
  });
  const { grid } = p.ctx;
  const at = new Map(grid.cells.map((c) => [`${c.row},${c.col}`, c]));
  const reach = Math.max(1, Math.round(REFINE_RADIUS_M / grid.cellSizeM));
  // Par couple : cellule → indice de candidat, pour ne pas créer deux fois le même.
  const known = p.usable.map((u) => {
    const m = new Map<number, number>();
    u.candidateCells.forEach((c, j) => c && m.set(c.id, j));
    return m;
  });
  const indexOf = (k: number, c: Cell) => {
    let j = known[k]!.get(c.id);
    if (j === undefined) {
      j = addCandidate(p, k, c);
      known[k]!.set(c.id, j);
    }
    return j;
  };

  // Nombre de passes borné par REFINE_ROUNDS, sans limite de temps (déterminisme).
  const deadline = Number.POSITIVE_INFINITY;
  for (let round = 0; round < REFINE_ROUNDS; round++) {
    let improved = false;
    p.usable.forEach((u, k) => {
      const j = s.choice[k]!;
      const here = j >= 0 ? u.candidateCells[j] : undefined;
      if (!here || u.fixed) return;
      s.remove(k);
      let best = j;
      let bestGain = s.gainAt(k, j);
      for (let dr = -reach; dr <= reach; dr++)
        for (let dc = -reach; dc <= reach; dc++) {
          const c = at.get(`${here.row + dr},${here.col + dc}`);
          if (!c || c.forbidden || c.id === here.id) continue;
          if (u.res.allowedArea && !booleanPointInPolygon(c.center, u.res.allowedArea)) continue;
          const nj = indexOf(k, c);
          const g = s.gainAt(k, nj);
          if (g > bestGain + 1e-9) {
            bestGain = g;
            best = nj;
          }
        }
      s.add(k, best);
      if (best !== j) improved = true;
    });
    if (fillGaps(p, s, at, indexOf, deadline)) improved = true;
    if (!improved) break;
  }
  return s.choice.slice();
}

/**
 * Passe ciblée sur les trous : pour chaque cellule non servie, chaque drone essaie le plus petit
 * déplacement qui la met juste à portée (vers le trou, jusqu'à un rayon moins une cellule).
 * Comble les trous enclavés que la recherche locale à 300 m ne voit pas.
 */
function fillGaps(
  p: Problem,
  s: State,
  at: Map<string, Cell>,
  indexOf: (k: number, c: Cell) => number,
  deadline: number,
): boolean {
  const { grid } = p.ctx;
  let improved = false;
  for (const h of grid.cells) {
    if (Date.now() > deadline) break;
    if (p.weights[h.id]! <= 0 || s.seen[h.id]! > 0) continue;
    p.usable.forEach((u, k) => {
      const j = s.choice[k]!;
      const here = j >= 0 ? u.candidateCells[j] : undefined;
      if (!here || u.fixed || s.seen[h.id]! > 0) return;
      const d = distanceM(here.center, h.center);
      if (d <= u.radius) return;
      // Point à (rayon − 1 cellule) du trou, sur le segment trou → position actuelle.
      const f = (u.radius - grid.cellSizeM) / d;
      const c = at.get(
        `${Math.round(h.row + (here.row - h.row) * f)},${Math.round(h.col + (here.col - h.col) * f)}`,
      );
      if (!c || c.forbidden) return;
      if (u.res.allowedArea && !booleanPointInPolygon(c.center, u.res.allowedArea)) return;
      const nj = indexOf(k, c);
      s.remove(k);
      if (s.gainAt(k, nj) > s.gainAt(k, j) + 1e-9) {
        s.add(k, nj);
        improved = true;
      } else s.add(k, j);
    });
  }
  return improved;
}

/**
 * Couverture maximale pondérée (MCLP) par recuit simulé, démarré d'une construction gloutonne.
 * C'est le solveur utilisé par l'API (voir index.ts).
 */
export function greedySolve(ctx: SolveContext): SolveResult {
  const problem = buildProblem(ctx);
  if (!isProblem(problem)) return problem;
  const choice = refine(problem, anneal(problem, { seed: seedOf(ctx) }));
  return toResult(problem, choice);
}
