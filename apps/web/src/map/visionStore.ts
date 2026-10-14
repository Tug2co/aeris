import { create } from 'zustand';

export type MapVisionMode = 'dispositif' | 'secteurs' | 'trous';

export interface VisionOption {
  id: MapVisionMode;
  label: string;
  icon: string;
  description: string;
}

export const VISION_OPTIONS: VisionOption[] = [
  {
    id: 'dispositif',
    label: 'Dispositif',
    icon: '🎯',
    description: 'Drones et cercles de portée légers (contour seul, sans surcharge)',
  },
  {
    id: 'secteurs',
    label: 'Secteurs',
    icon: '🗺️',
    description: 'Polygones propres attribués à chaque drone (aplat unifié sans quadrillage)',
  },
  {
    id: 'trous',
    label: 'Trous & Alertes',
    icon: '🔍',
    description: 'Détection des trous de couverture et chevauchements critiques',
  },
];

/** Détermine si la couche de couverture (surfaces ou secteurs) doit être affichée selon le mode. */
export function isCoverageVisible(mode: MapVisionMode): boolean {
  return mode !== 'dispositif';
}

/** Style appliqué aux secteurs par drone : sans contour pour éliminer le quadrillage parasite des blocs. */
export function sectorStyle(color: string) {
  return {
    stroke: false,
    fillColor: color,
    fillOpacity: 0.18,
  };
}

/** Détermine si un cercle de portée de drone doit être affiché selon le mode et la sélection. */
export function shouldShowAssignmentCircle(mode: MapVisionMode, focused?: boolean): boolean {
  return mode === 'dispositif' || !!focused;
}

interface MapVisionState {
  mode: MapVisionMode;
  setMode: (mode: MapVisionMode) => void;
}

export const useMapVisionStore = create<MapVisionState>((set) => ({
  mode: 'dispositif',
  setMode: (mode) => set({ mode }),
}));
