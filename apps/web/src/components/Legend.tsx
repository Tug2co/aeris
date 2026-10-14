import { useState } from 'react';
import type { CommuneCoverage, Pilot } from '@aeris/shared';
import {
  CONSTRAINT_COLORS,
  COVERAGE_COLORS,
  pilotColor,
  PRIORITY_COLORS,
  WORK_AREA_STYLE,
} from '../map/colors';
import { useMapVisionStore } from '../map/visionStore';
import { pct } from './format';
import './components.css';

interface Item {
  label: string;
  /** Contour (couleur, tirets éventuels) et remplissage. */
  stroke: string;
  fill?: string;
  dash?: string;
  round?: boolean;
}

const BASE: Item[] = [
  { label: 'Zone de travail', stroke: WORK_AREA_STYLE.color, dash: '4 2' },
  { label: 'Zone prioritaire', stroke: PRIORITY_COLORS[3], fill: PRIORITY_COLORS[3] },
  {
    label: 'Zone interdite',
    stroke: CONSTRAINT_COLORS.interdite,
    fill: CONSTRAINT_COLORS.interdite,
  },
  { label: 'Hauteur limitée', stroke: CONSTRAINT_COLORS.hauteur_limitee, dash: '2 2' },
];

function Swatch({ item }: { item: Item }) {
  return (
    <svg viewBox="0 0 16 12" width="16" height="12" aria-hidden="true">
      {item.round ? (
        <circle cx="8" cy="6" r="5" fill="none" stroke={item.stroke} strokeWidth="1.8" />
      ) : (
        <rect
          x="1"
          y="1"
          width="14"
          height="10"
          rx="2"
          fill={item.fill ?? 'none'}
          fillOpacity={item.fill ? 0.35 : 0}
          stroke={item.stroke}
          strokeWidth="1.5"
          strokeDasharray={item.dash}
        />
      )}
    </svg>
  );
}

/**
 * Légende flottante de la carte : styles des couches visibles et communes concernées
 * avec la part de leur surface couverte (adaptée au mode de vision actif).
 */
export function Legend({
  withCoverage,
  communes,
  pilots,
}: {
  withCoverage: boolean;
  communes?: CommuneCoverage[];
  pilots?: Pick<Pilot, 'id' | 'name'>[];
}) {
  const [open, setOpen] = useState(true);
  const mode = useMapVisionStore((s) => s.mode);

  const pilotItems: Item[] = pilots?.length
    ? pilots.map((pilot) => ({
        label: `${pilot.name} — portée`,
        stroke: pilotColor(
          pilot.id,
          pilots.map((item) => item.id),
        ),
        round: true,
      }))
    : [{ label: 'Portée par télépilote', stroke: '#2563eb', round: true }];

  let items = BASE;
  if (withCoverage) {
    if (mode === 'dispositif') {
      items = [...BASE, ...pilotItems];
    } else if (mode === 'secteurs') {
      items = [
        ...BASE,
        { label: 'Secteur propre par drone', stroke: 'transparent', fill: '#1d4ed8' },
      ];
    } else {
      items = [
        ...BASE,
        { label: 'Zone couverte', stroke: 'transparent', fill: COVERAGE_COLORS.covered },
        { label: 'Chevauchement', stroke: 'transparent', fill: COVERAGE_COLORS.overlap },
        { label: 'Trou de couverture', stroke: COVERAGE_COLORS.gaps, dash: '2 2' },
      ];
    }
  }

  return (
    <div className="legend card">
      <button className="legend-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        Légende
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path
            d={open ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          />
        </svg>
      </button>
      {open && (
        <>
          <ul>
            {items.map((item) => (
              <li key={item.label}>
                <Swatch item={item} />
                {item.label}
              </li>
            ))}
          </ul>
          {communes && communes.length > 0 && (
            <div className="communes">
              <b>
                {communes.length} commune{communes.length > 1 ? 's' : ''} concernée
                {communes.length > 1 ? 's' : ''}
              </b>
              <ul className="communes-list">
                {communes.map((c) => (
                  <li key={c.code}>
                    {c.nom}
                    <span>{c.areaM2 > 0 ? pct(c.coveredAreaM2 / c.areaM2) : '—'} couverte</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
