import { describe, expect, it } from 'vitest';
import { isCoverageVisible, sectorStyle, shouldShowAssignmentCircle } from './visionStore';

describe('Vision cartographique : règles d’affichage des couches', () => {
  describe('isCoverageVisible', () => {
    it('masque la couche de couverture en mode "dispositif" pour aérer la carte', () => {
      expect(isCoverageVisible('dispositif')).toBe(false);
    });

    it('affiche la couverture en modes "secteurs" et "trous"', () => {
      expect(isCoverageVisible('secteurs')).toBe(true);
      expect(isCoverageVisible('trous')).toBe(true);
    });
  });

  describe('sectorStyle (nettoyage du quadrillage parasite)', () => {
    it('désactive le contour (stroke: false) pour éliminer les bordures parasites entre blocs', () => {
      const style = sectorStyle('#2563eb');
      expect(style.stroke).toBe(false);
      expect(style.fillColor).toBe('#2563eb');
      expect(style.fillOpacity).toBe(0.18);
    });
  });

  describe('shouldShowAssignmentCircle', () => {
    it('affiche les cercles de portée en mode "dispositif"', () => {
      expect(shouldShowAssignmentCircle('dispositif', false)).toBe(true);
      expect(shouldShowAssignmentCircle('dispositif', true)).toBe(true);
    });

    it('masque les grands cercles de portée en mode "secteurs" et "trous" si non ciblé', () => {
      expect(shouldShowAssignmentCircle('secteurs', false)).toBe(false);
      expect(shouldShowAssignmentCircle('trous', false)).toBe(false);
    });

    it('conserve le cercle si le couple est en cours de déplacement (focused: true)', () => {
      expect(shouldShowAssignmentCircle('secteurs', true)).toBe(true);
      expect(shouldShowAssignmentCircle('trous', true)).toBe(true);
    });
  });
});
