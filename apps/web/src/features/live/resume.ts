import {
  maxHeightM,
  rangeM,
  type Assignment,
  type Mission,
  type MissionState,
  type PilotRule,
  type Proposal,
  type Weather,
} from '@aeris/shared';
import { api } from '../../api/client';
import { availabilityEvents, type Project } from '../../components/project';

export interface ResumeChoices {
  /** Disponibilité de chaque couple, choisie par l'opérateur. */
  available: Record<string, boolean>;
  /** Météo importée ou saisie ; absente = celle relevée par l'API au lancement. */
  weather?: Weather;
}

/**
 * Préfixe des télépilotes et couples générés par le dimensionnement en planification
 * (SIZING_PREFIX de @aeris/solver) : tant qu'ils le portent, l'API les régénère au calcul.
 */
const GENERATED_PREFIX = 'auto-';
const adopt = (id: string) =>
  id.startsWith(GENERATED_PREFIX) ? `plan-${id.slice(GENERATED_PREFIX.length)}` : id;

/**
 * Projet repris en conduite : les moyens générés en planification deviennent des moyens
 * déclarés (nouveaux identifiants, dispositif enregistré compris). Sans cela, le calcul
 * redimensionnerait la flotte et écraserait les niveaux et drones choisis par l'opérateur.
 */
export function adoptGeneratedMeans(project: Project): Project {
  const { mission, proposals } = project.state;
  if (!mission.resources.some((r) => r.id.startsWith(GENERATED_PREFIX))) return project;
  return {
    ...project,
    state: {
      ...project.state,
      mission: {
        ...mission,
        pilots: mission.pilots.map((p) => ({ ...p, id: adopt(p.id) })),
        resources: mission.resources.map((r) => ({
          ...r,
          id: adopt(r.id),
          pilotId: adopt(r.pilotId),
        })),
      },
      proposals: proposals.map((p) => ({
        ...p,
        assignments: p.assignments.map((a) => ({ ...a, resourceId: adopt(a.resourceId) })),
      })),
    },
  };
}

/** Mission du projet recréée côté API, pour la retoucher avant la conduite ou la planifier. */
export async function openProject(project: Project): Promise<MissionState> {
  const { id: _id, ...input } = project.state.mission;
  return api.createMission(input);
}

type Means = Pick<Mission, 'pilots' | 'resources' | 'environment'>;

/** Niveau du télépilote et modèle de drone d'un couple. */
function coupleOf(mission: Pick<Mission, 'pilots' | 'resources'>, resourceId: string) {
  const r = mission.resources.find((x) => x.id === resourceId);
  if (!r) return undefined;
  const level = mission.pilots.find((p) => p.id === r.pilotId)?.level;
  return `${r.droneModelId}|${level}`;
}

/**
 * Dispositif enregistré à restaurer avec les moyens déclarés. Chaque télépilote encore là
 * garde son emplacement : tel quel si son couple n'a pas changé ; sinon sur l'un de ses
 * drones actuels (de préférence disponible), avec la portée et le plafond de son niveau
 * actuel. Le recalcul part ensuite de ces positions.
 */
export function restoredAssignments(
  saved: Proposal,
  savedMission: Pick<Mission, 'pilots' | 'resources'>,
  mission: Means,
  rules: PilotRule[],
  isAvailable: (resourceId: string) => boolean = () => true,
): Assignment[] {
  const used = new Set<string>();
  return saved.assignments.flatMap((a) => {
    const key = `${a.phase}|`;
    const same = coupleOf(mission, a.resourceId);
    if (same !== undefined && same === coupleOf(savedMission, a.resourceId)) {
      used.add(key + a.resourceId);
      return [a];
    }
    const pilotId = savedMission.resources.find((r) => r.id === a.resourceId)?.pilotId;
    const pilot = mission.pilots.find((p) => p.id === pilotId);
    const couples = mission.resources.filter((r) => r.pilotId === pilotId && !used.has(key + r.id));
    const target = couples.find((r) => isAvailable(r.id)) ?? couples[0];
    if (!pilot || !target || !rules.length) return [];
    used.add(key + target.id);
    const ceiling = maxHeightM(rules, pilot.level, mission.environment);
    const maxM = Math.min(a.altitude.maxM, ceiling);
    const minM = Math.min(a.altitude.minM, Math.max(0, maxM - 20));
    return [
      {
        ...a,
        resourceId: target.id,
        radiusM: rangeM(rules, pilot.level),
        altitude: { minM, maxM },
      },
    ];
  });
}

/**
 * Reprise en conduite d'une mission rouverte (zones et moyens déjà retouchés), avec les
 * seules routes existantes : dispositif enregistré restauré → conduite lancée →
 * disponibilités et météo déclarées → recalcul (le solveur repart des positions en place),
 * laissé en attente de validation.
 */
export async function resumeInConduite(
  state: MissionState,
  project: Project,
  saved: Proposal,
  choices: ResumeChoices,
  rules: PilotRule[],
  onStep: (step: string) => void,
): Promise<MissionState> {
  const { id, resources } = state.mission;

  onStep('Restauration du dispositif enregistré');
  const [proposal] = await api.solve(id, [saved.strategy]);
  if (!proposal) throw new Error('Le solveur n’a renvoyé aucune proposition.');
  await api.editProposal(
    id,
    proposal.id,
    restoredAssignments(
      saved,
      project.state.mission,
      state.mission,
      rules,
      (resourceId) =>
        choices.available[resourceId] ??
        resources.find((r) => r.id === resourceId)?.available ??
        true,
    ),
  );

  onStep('Lancement de la conduite');
  await api.start(id, proposal.id);

  const events = availabilityEvents(resources, choices.available);
  if (choices.weather) events.push({ type: 'weather_update', weather: choices.weather });
  if (events.length) onStep('Prise en compte des moyens et de la météo');
  for (const ev of events) await api.sendEvent(id, ev);

  onStep('Optimisation avec les nouvelles contraintes');
  await api.recompute(id);
  return api.getMission(id);
}
