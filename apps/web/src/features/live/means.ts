import type { MissionInput, PilotLevel } from '@aeris/shared';

/**
 * Moyens déclarés à la reprise en conduite : chaque télépilote a un niveau (TP1 ou TP2, qui
 * fixe sa portée et ses hauteurs de vol) et un ou plusieurs drones qu'il peut faire voler,
 * un couple par drone. Le solveur n'en engage qu'un à la fois par télépilote.
 */
type Means = Pick<MissionInput, 'pilots' | 'resources'>;

export const newResourceId = () => `r-${crypto.randomUUID().slice(0, 8)}`;

/** Drones qu'un télépilote peut faire voler. */
export const pilotModels = (m: Means, pilotId: string) =>
  m.resources.filter((r) => r.pilotId === pilotId).map((r) => r.droneModelId);

/** Change le niveau d'un télépilote (ses drones ne changent pas). */
export function withLevel(m: Means, pilotId: string, level: PilotLevel): Means {
  return {
    pilots: m.pilots.map((p) => (p.id === pilotId ? { ...p, level } : p)),
    resources: m.resources,
  };
}

/** Ajoute ou retire un drone d'un télépilote ; il en garde toujours au moins un. */
export function withDrone(
  m: Means,
  pilotId: string,
  modelId: string,
  on: boolean,
  makeId = newResourceId,
): Means {
  const models = pilotModels(m, pilotId);
  if (on === models.includes(modelId)) return m;
  if (!on && models.length <= 1) return m;
  return {
    pilots: m.pilots,
    resources: on
      ? [...m.resources, { id: makeId(), pilotId, droneModelId: modelId, available: true }]
      : m.resources.filter((r) => !(r.pilotId === pilotId && r.droneModelId === modelId)),
  };
}

/** Retire un ou plusieurs télépilotes, avec leurs couples. */
export function withoutPilots(m: Means, pilotIds: string[]): Means {
  const gone = new Set(pilotIds);
  return {
    pilots: m.pilots.filter((p) => !gone.has(p.id)),
    resources: m.resources.filter((r) => !gone.has(r.pilotId)),
  };
}

/** Ajoute un télépilote qui n'était pas prévu, avec ses drones. */
export function withPilot(
  m: Means,
  pilot: { id: string; name: string; level: PilotLevel; modelIds: string[] },
  makeId = newResourceId,
): Means {
  return {
    pilots: [...m.pilots, { id: pilot.id, name: pilot.name, level: pilot.level }],
    resources: [
      ...m.resources,
      ...pilot.modelIds.map((droneModelId) => ({
        id: makeId(),
        pilotId: pilot.id,
        droneModelId,
        available: true,
      })),
    ],
  };
}
