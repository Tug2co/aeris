import { useEffect, useRef, useState, type FormEvent } from 'react';
import { create } from 'zustand';
import type { NewDroneModel } from '@aeris/shared';
import { api } from '../api/client';
import { useMissionStore } from '../app/missionStore';
import { useLiveStore } from '../features/live/store';
import { useResumeStore } from '../features/live/ResumeWizard';
import { resetConfigEditor } from '../features/config/store';
import { useScenarioStore } from '../features/scenarios/store';
import { useThemeStore, type Theme } from '../theme';
import { projectFileName, toProject } from './project';
import { useStartStore } from './Welcome';
import { buildSectorsGeoJSON, downloadGeoJson } from '../features/scenarios/exportSectors';
import { VISION_OPTIONS, useMapVisionStore } from '../map/visionStore';
import './components.css';

/** Ouverture du menu latéral, déclenchée par le bloc logo + nom du bandeau. */
export const useMenuStore = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/** Télécharge le projet en cours (mission, propositions, dispositif retenu). */
function saveProject() {
  const state = useMissionStore.getState().state;
  if (!state) return;
  const project = toProject(state);
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = projectFileName(project);
  link.click();
  URL.revokeObjectURL(url);
}

/** Télécharge les secteurs d'intervention des drones au format GeoJSON (QGIS / ATAK). */
async function exportCurrentSectors() {
  const state = useMissionStore.getState().state;
  const catalog = useMissionStore.getState().catalog;
  if (!state) return;
  const { mission, live } = state;
  const proposal = state.selectedProposalId
    ? state.proposals.find((p) => p.id === state.selectedProposalId)
    : state.proposals[0];
  const phase = live?.phase ?? 0;
  const assignments = live?.assignments ?? proposal?.assignments ?? [];
  try {
    const cov = live
      ? await api.liveCoverage(mission.id)
      : proposal
        ? await api.coverage(mission.id, proposal.id, phase)
        : undefined;
    const fc = buildSectorsGeoJSON(mission, phase, assignments, cov, catalog);
    downloadGeoJson(fc.name, fc);
  } catch {
    const fc = buildSectorsGeoJSON(mission, phase, assignments, undefined, catalog);
    downloadGeoJson(fc.name, fc);
  }
}

/** Ferme le projet en cours et revient au choix Planification / Conduite. */
function backToStart() {
  useMissionStore.setState({ state: undefined, error: undefined });
  useLiveStore.setState({ live: undefined, view: 'current', zoneLevel: undefined });
  useScenarioStore.setState({
    selectedId: undefined,
    phase: 0,
    draft: undefined,
    minimized: false,
  });
  useResumeStore.getState().clear();
  resetConfigEditor();
  useStartStore.getState().setMode(undefined);
}

const THEMES: { id: Theme; label: string }[] = [
  { id: 'light', label: 'Clair' },
  { id: 'dark', label: 'Sombre' },
];

/**
 * Menu latéral de l'application (réglages). Chaque rubrique est une <section> :
 * en ajouter une suffit pour les réglages à venir.
 */
export function AppMenu() {
  const { open, setOpen } = useMenuStore();
  const { theme, setTheme } = useThemeStore();
  const { mode: visionMode, setMode: setVisionMode } = useMapVisionStore();
  const hasMission = useMissionStore((st) => !!st.state);
  const { catalog, setCatalog, run, busy } = useMissionStore();
  const [droneDraft, setDroneDraft] = useState<NewDroneModel>({
    name: '',
    maxWindMs: 10,
    rainOk: false,
    zoomX: 1,
    thermal: false,
    night: false,
  });
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    // Phase de capture : Échap ferme le menu avant de réduire les fenêtres de l'étape.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, setOpen]);

  const updateDroneDraft = <K extends keyof NewDroneModel>(key: K, value: NewDroneModel[K]) =>
    setDroneDraft((current) => ({ ...current, [key]: value }));
  const addDrone = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run(async () => {
      const drone = await api.addDrone(droneDraft);
      if (catalog) setCatalog({ ...catalog, drones: [...catalog.drones, drone] });
      setDroneDraft((current) => ({ ...current, name: '' }));
    });
  };

  if (!open) return null;

  return (
    <>
      <div className="menu-scrim" onClick={() => setOpen(false)} aria-hidden="true" />
      <nav
        id="app-menu"
        ref={panel}
        className="app-menu"
        aria-label="Menu de l’application"
        tabIndex={-1}
      >
        <section aria-labelledby="menu-project">
          <h3 id="menu-project">Projet</h3>
          <div className="menu-actions">
            <button disabled={!hasMission} onClick={saveProject}>
              Enregistrer le projet
            </button>
            <button disabled={!hasMission} onClick={exportCurrentSectors}>
              Exporter les secteurs (GeoJSON)
            </button>
            <button
              onClick={() => {
                if (
                  hasMission &&
                  !window.confirm(
                    'Fermer le projet en cours ? Enregistrez-le d’abord pour le reprendre.',
                  )
                )
                  return;
                backToStart();
                setOpen(false);
              }}
            >
              Revenir à l’accueil
            </button>
          </div>
          {!hasMission && <p className="hint">Aucun projet ouvert.</p>}
        </section>

        <section aria-labelledby="menu-display">
          <h3 id="menu-display">Affichage</h3>
          <div className="menu-row">
            <span>Vision</span>
            <div className="segmented" role="group" aria-label="Vision de la carte">
              {VISION_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  className={visionMode === opt.id ? 'active' : ''}
                  aria-pressed={visionMode === opt.id}
                  title={opt.description}
                  onClick={() => setVisionMode(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div className="menu-row" style={{ marginTop: 8 }}>
            <span>Thème</span>
            <div className="segmented" role="group" aria-label="Thème">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  className={theme === t.id ? 'active' : ''}
                  aria-pressed={theme === t.id}
                  onClick={() => setTheme(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </section>
        <section aria-labelledby="menu-catalog">
          <h3 id="menu-catalog">Catalogue de drones</h3>
          {catalog ? (
            <ul className="menu-drone-list">
              {catalog.drones.map((drone) => (
                <li key={drone.id}>
                  <strong>{drone.name}</strong>
                  <small>
                    Vent {drone.maxWindMs} m/s · zoom ×{drone.zoomX}
                  </small>
                  <small>
                    {drone.rainOk ? 'Résistant à la pluie' : 'Non résistant à la pluie'} · Vision :{' '}
                    {drone.thermal || drone.night
                      ? [drone.thermal && 'thermique', drone.night && 'nocturne']
                          .filter(Boolean)
                          .join(' et ')
                      : 'standard'}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="menu-help">Chargement du catalogue…</p>
          )}
          <form className="menu-drone-form" onSubmit={addDrone}>
            <h4>Ajouter un drone</h4>
            <label>
              Nom du modèle
              <input
                required
                type="text"
                value={droneDraft.name}
                onChange={(event) => updateDroneDraft('name', event.target.value)}
                placeholder="Ex. Autel EVO Max 4T"
              />
            </label>
            <label>
              Vent maximal (m/s)
              <input
                required
                type="number"
                min={0}
                step={0.1}
                value={droneDraft.maxWindMs}
                onChange={(event) => updateDroneDraft('maxWindMs', Number(event.target.value))}
              />
            </label>
            <label>
              Zoom optique (×)
              <input
                required
                type="number"
                min={0}
                step={0.1}
                value={droneDraft.zoomX}
                onChange={(event) => updateDroneDraft('zoomX', Number(event.target.value))}
              />
            </label>
            <label className="menu-drone-toggle">
              <input
                type="checkbox"
                checked={droneDraft.rainOk}
                onChange={(event) => updateDroneDraft('rainOk', event.target.checked)}
              />
              Résistant à la pluie
            </label>
            <fieldset className="menu-drone-capabilities">
              <legend>Capacités de vision</legend>
              <label className="menu-drone-toggle">
                <input
                  type="checkbox"
                  checked={droneDraft.night}
                  onChange={(event) => updateDroneDraft('night', event.target.checked)}
                />
                Vision nocturne
              </label>
              <label className="menu-drone-toggle">
                <input
                  type="checkbox"
                  checked={droneDraft.thermal}
                  onChange={(event) => updateDroneDraft('thermal', event.target.checked)}
                />
                Caméra thermique
              </label>
            </fieldset>
            <button
              className="primary"
              type="submit"
              disabled={busy || !catalog || !droneDraft.name.trim()}
            >
              Ajouter au catalogue
            </button>
          </form>
        </section>
      </nav>
    </>
  );
}
