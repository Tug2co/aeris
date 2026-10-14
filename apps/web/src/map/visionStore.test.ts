import { describe, expect, it, beforeEach } from 'vitest';
import { VISION_OPTIONS, useMapVisionStore } from './visionStore';

describe('visionStore', () => {
  beforeEach(() => {
    useMapVisionStore.setState({ mode: 'dispositif' });
  });

  it('a le mode "dispositif" par défaut', () => {
    expect(useMapVisionStore.getState().mode).toBe('dispositif');
  });

  it('permet de basculer vers "secteurs" et "trous"', () => {
    useMapVisionStore.getState().setMode('secteurs');
    expect(useMapVisionStore.getState().mode).toBe('secteurs');

    useMapVisionStore.getState().setMode('trous');
    expect(useMapVisionStore.getState().mode).toBe('trous');

    useMapVisionStore.getState().setMode('dispositif');
    expect(useMapVisionStore.getState().mode).toBe('dispositif');
  });

  it('propose les 3 visions opérationnelles attendues', () => {
    expect(VISION_OPTIONS.map((o) => o.id)).toEqual(['dispositif', 'secteurs', 'trous']);
    expect(VISION_OPTIONS.find((o) => o.id === 'dispositif')?.label).toBe('Dispositif');
    expect(VISION_OPTIONS.find((o) => o.id === 'secteurs')?.label).toBe('Secteurs');
    expect(VISION_OPTIONS.find((o) => o.id === 'trous')?.label).toBe('Trous & Alertes');
  });
});
