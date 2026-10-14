import { describe, expect, it } from 'vitest';
import type { Assignment, PilotRule, Proposal } from '@aeris/shared';
import type { Project } from '../../components/project';
import { adoptGeneratedMeans, restoredAssignments } from './resume';

const assignment = (resourceId: string): Assignment =>
  ({
    resourceId,
    phase: 0,
    position: { type: 'Point', coordinates: [2, 48] },
    radiusM: 2000,
    altitude: { minM: 90, maxM: 120 },
  }) as Assignment;

const rules: PilotRule[] = [
  { level: 'TP1', scenario: '', rangeM: 1000, maxHeightM: { rural: 50, urbain: 80 } },
  { level: 'TP2', scenario: '', rangeM: 2000, maxHeightM: { rural: 120, urbain: 120 } },
];

const savedMission = {
  environment: 'rural' as const,
  pilots: [
    { id: 'a', name: 'ADJ Martin', level: 'TP2' as const },
    { id: 'b', name: 'GND Petit', level: 'TP2' as const },
  ],
  resources: [
    { id: 'r1', pilotId: 'a', droneModelId: 'matrice', available: true },
    { id: 'r2', pilotId: 'b', droneModelId: 'matrice', available: true },
  ],
};
const saved = { assignments: [assignment('r1'), assignment('r2')] } as Proposal;

describe('restoredAssignments', () => {
  it('restaure tels quels les couples inchangés', () => {
    expect(restoredAssignments(saved, savedMission, savedMission, rules)).toEqual(
      saved.assignments,
    );
  });

  it('un télépilote passé TP1 garde sa place, avec la portée et le plafond d’un TP1', () => {
    const tp1 = {
      ...savedMission,
      pilots: savedMission.pilots.map((p) => (p.id === 'a' ? { ...p, level: 'TP1' as const } : p)),
    };
    const [a] = restoredAssignments(saved, savedMission, tp1, rules);
    expect(a).toMatchObject({ resourceId: 'r1', radiusM: 1000, altitude: { minM: 30, maxM: 50 } });
  });

  it('un télépilote qui a changé de drone garde sa place sur son nouveau drone disponible', () => {
    const otherDrones = {
      ...savedMission,
      resources: [
        { id: 'r3', pilotId: 'a', droneModelId: 'mini', available: true },
        { id: 'r4', pilotId: 'a', droneModelId: 'mavic', available: true },
        savedMission.resources[1],
      ],
    };
    const restored = restoredAssignments(
      saved,
      savedMission,
      otherDrones,
      rules,
      (id) => id !== 'r3',
    );
    expect(restored.map((a) => a.resourceId)).toEqual(['r4', 'r2']);
    expect(restored[0].position).toEqual(saved.assignments[0].position);
  });

  it('écarte le télépilote retiré', () => {
    const removed = {
      ...savedMission,
      pilots: [savedMission.pilots[1]],
      resources: [savedMission.resources[1]],
    };
    expect(restoredAssignments(saved, savedMission, removed, rules)).toEqual([assignment('r2')]);
  });
});

describe('adoptGeneratedMeans', () => {
  const project = {
    format: 'aeris-projet',
    version: 1,
    savedAt: '2026-10-14T10:00:00.000Z',
    state: {
      status: 'propositions',
      mission: {
        pilots: [{ id: 'auto-p1', name: 'Télépilote 1', level: 'TP2' }],
        resources: [
          { id: 'auto-r1', pilotId: 'auto-p1', droneModelId: 'matrice', available: true },
        ],
      },
      proposals: [{ id: 'p', assignments: [assignment('auto-r1')] }],
    },
  } as unknown as Project;

  it('les moyens générés en planification deviennent des moyens déclarés', () => {
    const { state } = adoptGeneratedMeans(project);
    expect(state.mission.pilots[0].id).toBe('plan-p1');
    expect(state.mission.resources[0]).toMatchObject({ id: 'plan-r1', pilotId: 'plan-p1' });
    expect(state.proposals[0].assignments[0].resourceId).toBe('plan-r1');
  });

  it('laisse intact un projet sans moyens générés', () => {
    const named = {
      ...project,
      state: { ...project.state, mission: { ...project.state.mission, resources: [] } },
    } as Project;
    expect(adoptGeneratedMeans(named)).toBe(named);
  });
});
