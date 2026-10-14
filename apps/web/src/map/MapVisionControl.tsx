import { VISION_OPTIONS, useMapVisionStore } from './visionStore';

/**
 * Sélecteur de vision opérationnelle sur la carte :
 * - Dispositif : drones et portées légères (carte dégagée)
 * - Secteurs : zones propres attribuées à chaque drone (sans quadrillage)
 * - Trous & Alertes : trous non couverts et chevauchements critiques
 */
export function MapVisionControl() {
  const { mode, setMode } = useMapVisionStore();

  return (
    <nav className="map-vision-control" role="group" aria-label="Mode de vision cartographique">
      {VISION_OPTIONS.map((opt) => {
        const active = mode === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            className={active ? 'active' : ''}
            aria-pressed={active}
            title={opt.description}
            onClick={() => setMode(opt.id)}
          >
            <span aria-hidden="true">{opt.icon}</span>
            <span>{opt.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
