import { Fragment } from 'react';
import { Circle, Marker, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import type { Assignment, Mission } from '@aeris/shared';
import { useMissionStore } from '../../app/missionStore';
import { resourceLabel } from '../../features/resourceLabel';
import { pilotColor } from '../colors';
import { SEMANTIC } from '../../theme';
import { shouldShowAssignmentCircle, useMapVisionStore, type MapVisionMode } from '../visionStore';

export { shouldShowAssignmentCircle };

interface Props {
  mission: Mission;
  assignments: Assignment[];
  /** Pointillés (recalcul proposé, non validé). */
  ghost?: boolean;
  /** Couple mis en évidence (bouton « Déplacer » des panneaux). */
  focusedId?: string;
  /** Si fourni, les positions sont déplaçables à la souris. */
  onMove?: (resourceId: string, lngLat: [number, number]) => void;
  /** Mode de vision forcé ou par défaut lu depuis le store. */
  mode?: MapVisionMode;
}

/** Un cercle de portée + un marqueur par couple, coloré selon le télépilote. */
export function AssignmentsLayer({
  mission,
  assignments,
  ghost,
  focusedId,
  onMove,
  mode: propMode,
}: Props) {
  const catalog = useMissionStore((state) => state.catalog);
  const storeMode = useMapVisionStore((s) => s.mode);
  const mode = propMode ?? storeMode;
  const pilotIds = mission.pilots.map((pilot) => pilot.id);
  return (
    <>
      {assignments.map((a) => {
        const res = mission.resources.find((r) => r.id === a.resourceId);
        const pilot = mission.pilots.find((p) => p.id === res?.pilotId);
        const color = pilot ? pilotColor(pilot.id, pilotIds) : SEMANTIC.neutral;
        const focused = a.resourceId === focusedId;
        const [lng, lat] = a.position.coordinates;
        const icon = L.divIcon({
          className: 'drone-icon',
          html: `<span style="background:${color}${focused ? `;outline:3px solid ${SEMANTIC.warn}` : ''}">C${mission.resources.findIndex((resource) => resource.id === a.resourceId) + 1}</span>`,
          iconSize: [34, 20],
        });
        // En mode Dispositif ou si le couple est sélectionné pour déplacement, on affiche le cercle de portée.
        // En mode Secteurs ou Trous, les cercles sont masqués pour dégager la vision.
        const showCircle = shouldShowAssignmentCircle(mode, focused);
        return (
          <Fragment key={`${ghost ? 'g' : 'a'}-${a.resourceId}-${a.phase}`}>
            {showCircle && (
              <Circle
                center={[lat, lng]}
                radius={a.radiusM}
                pathOptions={{
                  color,
                  weight: ghost ? 2 : focused ? 3 : 1.5,
                  dashArray: ghost ? '4 6' : undefined,
                  fillOpacity: ghost ? 0.03 : 0, // Contour seul, sans fond opaque pour ne pas noyer le fond IGN
                }}
              />
            )}
            {!ghost && (
              <Marker
                position={[lat, lng]}
                icon={icon}
                draggable={!!onMove}
                eventHandlers={{
                  dragend: (e) => {
                    const p = (e.target as L.Marker).getLatLng();
                    onMove?.(a.resourceId, [p.lng, p.lat]);
                  },
                }}
              >
                <Tooltip>
                  {resourceLabel(mission, a.resourceId, catalog)}
                  <br />
                  Rayon {a.radiusM / 1000} km, {a.altitude.minM} à {a.altitude.maxM} m/sol
                </Tooltip>
              </Marker>
            )}
          </Fragment>
        );
      })}
    </>
  );
}
