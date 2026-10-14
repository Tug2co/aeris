import { describe, expect, it } from 'vitest';
import { pilotModels, withDrone, withLevel, withPilot, withoutPilots } from './means';

const ids = () => {
  let n = 0;
  return () => `new-${++n}`;
};

const base = {
  pilots: [
    { id: 'a', name: 'ADJ Martin', level: 'TP2' as const },
    { id: 'b', name: 'GND Petit', level: 'TP1' as const },
  ],
  resources: [
    { id: 'r1', pilotId: 'a', droneModelId: 'matrice', available: true },
    { id: 'r3', pilotId: 'b', droneModelId: 'mini', available: true },
  ],
};

describe('moyens déclarés en conduite', () => {
  it('bascule un TP2 en TP1 sans changer ses drones', () => {
    const m = withLevel(base, 'a', 'TP1');
    expect(m.pilots.find((p) => p.id === 'a')?.level).toBe('TP1');
    expect(pilotModels(m, 'a')).toEqual(['matrice']);
  });

  it('donne plusieurs drones à un télépilote, un couple par drone', () => {
    const m = withDrone(base, 'a', 'mavic', true, ids());
    expect(pilotModels(m, 'a')).toEqual(['matrice', 'mavic']);
    expect(m.resources.at(-1)).toEqual({
      id: 'new-1',
      pilotId: 'a',
      droneModelId: 'mavic',
      available: true,
    });
    expect(pilotModels(withDrone(m, 'a', 'matrice', false), 'a')).toEqual(['mavic']);
  });

  it('garde toujours au moins un drone', () => {
    expect(withDrone(base, 'b', 'mini', false)).toBe(base);
    expect(withDrone(base, 'b', 'mini', true)).toBe(base);
  });

  it('retire plusieurs télépilotes avec leurs couples', () => {
    const m = withoutPilots(base, ['a', 'b']);
    expect(m.pilots).toEqual([]);
    expect(m.resources).toEqual([]);
  });

  it('ajoute un télépilote non prévu avec ses drones', () => {
    const m = withPilot(
      base,
      { id: 'c', name: 'GND Dupont', level: 'TP1', modelIds: ['mini', 'mavic'] },
      ids(),
    );
    expect(m.pilots.at(-1)).toEqual({ id: 'c', name: 'GND Dupont', level: 'TP1' });
    expect(pilotModels(m, 'c')).toEqual(['mini', 'mavic']);
  });
});
