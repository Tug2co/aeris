import type { SolveContext, SolveResult } from '@aeris/shared';
import { buildProblem, isProblem, toResult, type Problem } from './problem';

/**
 * Nombre d'itérations du recuit (≈ 100 ms sur la mission de démo). Fixe, sans chronomètre :
 * le résultat ne doit pas dépendre de la charge de la machine (démo et CI reproductibles).
 */
const ITERATIONS = 30_000;
/** Température finale relative à la température initiale. */
const FINAL_TEMPERATURE_RATIO = 1e-3;
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

/** État incrémental : nombre de couples qui servent chaque cellule, score courant. */
class State {
  readonly count: Int32Array;
  readonly choice: Int32Array;
  engaged = 0;
  value = 0;

  constructor(private readonly p: Problem) {
    this.count = new Int32Array(p.weights.length);
    this.choice = new Int32Array(p.usable.length).fill(-1);
  }

  /** Retire le couple k de sa position ; renvoie la variation de score. */
  remove(k: number): number {
    const j = this.choice[k]!;
    if (j < 0) return 0;
    const u = this.p.usable[k]!;
    const { weights, overlapPenalty } = this.p;
    let d = u.moveCost[j]! + (u.fixed ? 0 : this.p.droneCost);
    for (const i of u.covers[j]!) {
      const n = --this.count[i]!;
      d += n === 0 ? -weights[i]! : overlapPenalty * weights[i]!;
    }
    this.choice[k] = -1;
    this.engaged--;
    this.value += d;
    return d;
  }

  /** Place le couple k (non placé) au candidat j ; renvoie la variation de score. */
  add(k: number, j: number): number {
    const u = this.p.usable[k]!;
    const { weights, overlapPenalty } = this.p;
    let d = -u.moveCost[j]! - (u.fixed ? 0 : this.p.droneCost);
    for (const i of u.covers[j]!) {
      const n = this.count[i]!++;
      d += n === 0 ? weights[i]! : -overlapPenalty * weights[i]!;
    }
    this.choice[k] = j;
    this.engaged++;
    this.value += d;
    return d;
  }

  /** Gain qu'apporterait le couple k (non placé) au candidat j, sans modifier l'état. */
  gainAt(k: number, j: number): number {
    const u = this.p.usable[k]!;
    const { weights, overlapPenalty } = this.p;
    let d = -u.moveCost[j]! - (u.fixed ? 0 : this.p.droneCost);
    for (const i of u.covers[j]!)
      d += this.count[i]! === 0 ? weights[i]! : -overlapPenalty * weights[i]!;
    return d;
  }
}

/**
 * Construction gloutonne : positions imposées, puis chaque couple (portées décroissantes)
 * à sa meilleure position, s'il apporte quelque chose et que l'arrêté le permet.
 */
function construct(p: Problem): State {
  const s = new State(p);
  p.usable.forEach((u, k) => {
    if (s.engaged >= p.maxEngaged) return;
    if (u.fixed) {
      s.add(k, 0);
      return;
    }
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
      if (j >= 0) s.add(k, j);
    });
  } else s = construct(p);

  const movable = p.usable.map((u, k) => (u.fixed ? -1 : k)).filter((k) => k >= 0);
  if (movable.length === 0) return s.choice.slice();

  const rand = rng(opts.seed ?? 1);
  const iterations = opts.iterations ?? ITERATIONS;
  const meanGain = Math.max(s.value / Math.max(s.engaged, 1), p.totalWeight * 0.01, 1e-9);
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
 * Couverture maximale pondérée (MCLP) par recuit simulé, démarré d'une construction gloutonne.
 * Sert de solveur rapide et de secours si l'ILP (ilp.ts) dépasse le temps imparti.
 */
export function greedySolve(ctx: SolveContext): SolveResult {
  const problem = buildProblem(ctx);
  if (!isProblem(problem)) return problem;
  const choice = anneal(problem, { seed: seedOf(ctx) });
  return toResult(problem, choice);
}
