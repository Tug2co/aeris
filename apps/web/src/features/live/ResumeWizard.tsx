import { useState, type ReactNode } from 'react';
import { create } from 'zustand';
import type { PilotLevel, Weather } from '@aeris/shared';
import { useMissionStore } from '../../app/missionStore';
import { WizardWindow } from '../../components/WizardWindow';
import { retainedProposal, type Project } from '../../components/project';
import { summarizeWeather } from '../../components/format';
import { useStartStore } from '../../components/Welcome';
import {
  AreaFields,
  ConstraintFields,
  PriorityFields,
  useMissionUpdate,
} from '../config/ConfigPanel';
import { useConfigEditorStore } from '../config/store';
import { pilotModels, withDrone, withLevel, withPilot, withoutPilots } from './means';
import { resumeInConduite } from './resume';
import { useLiveStore } from './store';
import { MANUAL_WEATHER, editWeather, importWeather, weatherLimits } from './weather';
import './live.css';

const STEPS = ['Zones', 'Moyens disponibles', 'Météo'] as const;
type Step = 0 | 1 | 2;

interface ResumeStore {
  /** Projet importé en cours de reprise (absent = pas de reprise en cours). */
  project?: Project;
  step: Step;
  /** Disponibilité choisie pour chaque couple (absent = celle du projet). */
  available: Record<string, boolean>;
  weather?: Weather;
  begin: (project: Project) => void;
  setStep: (step: Step) => void;
  setAvailable: (id: string, available: boolean) => void;
  setWeather: (weather?: Weather) => void;
  clear: () => void;
}

export const useResumeStore = create<ResumeStore>((set) => ({
  step: 0,
  available: {},
  begin: (project) => set({ project, step: 0, available: {}, weather: undefined }),
  setStep: (step) => {
    useConfigEditorStore.getState().setStep(undefined);
    set({ step });
  },
  setAvailable: (id, available) => set((s) => ({ available: { ...s.available, [id]: available } })),
  setWeather: (weather) => set({ weather }),
  clear: () => set({ project: undefined, step: 0, available: {}, weather: undefined }),
}));

/**
 * Reprise d'une intervention enregistrée, une fenêtre par étape posée sur la carte :
 * retoucher les zones si la situation a changé → déclarer les moyens réellement disponibles
 * → importer la météo → relancer l'optimisation avec ces nouvelles contraintes.
 */
export function ResumeWizard() {
  const { state, catalog, setState, run, busy } = useMissionStore();
  const { project, step, available, weather, setStep, clear } = useResumeStore();
  const setView = useLiveStore((s) => s.setView);
  const setMode = useStartStore((s) => s.setMode);
  const [progress, setProgress] = useState<string>();
  if (!state || !project) return null;
  const saved = retainedProposal(project);

  const toPlanning = () => {
    clear();
    useConfigEditorStore.getState().setStep(2);
    setMode('planification');
  };

  const launch = () =>
    saved &&
    run(async () => {
      const next = await resumeInConduite(
        state,
        project,
        saved,
        { available, weather },
        catalog?.rules ?? [],
        setProgress,
      );
      setView('pending');
      clear();
      setMode(undefined);
      setState(next);
    }).finally(() => setProgress(undefined));

  const back = step > 0 && (
    <button onClick={() => setStep((step - 1) as Step)} disabled={busy}>
      Retour
    </button>
  );

  const windows: Record<Step, { intro: string; body: ReactNode; next: ReactNode }> = {
    0: {
      intro: saved
        ? 'Les zones enregistrées sont sur la carte. Modifiez-les si la situation a changé, sinon continuez.'
        : 'Ce projet n’a pas encore de dispositif calculé : il faut d’abord le planifier.',
      body: saved ? <ZoneTabs /> : null,
      next: saved ? (
        <button className="primary" onClick={() => setStep(1)} disabled={busy}>
          Continuer
        </button>
      ) : (
        <button className="primary" onClick={toPlanning}>
          Ouvrir en planification
        </button>
      ),
    },
    1: {
      intro:
        'Cochez les télépilotes présents, ajustez leur niveau et les drones qu’ils emportent. Ajoutez ceux qui n’étaient pas prévus, retirez les autres.',
      body: <MeansFields />,
      next: (
        <button className="primary" onClick={() => setStep(2)} disabled={busy}>
          Continuer
        </button>
      ),
    },
    2: {
      intro:
        'Importez la météo du secteur, corrigez-la si besoin avec les relevés du terrain, puis relancez l’optimisation.',
      body: (
        <>
          <WeatherFields />
          {progress && (
            <p className="resume-step" role="status">
              {progress}…
            </p>
          )}
        </>
      ),
      next: (
        <button className="primary" onClick={() => void launch()} disabled={busy || !saved}>
          {busy ? 'Optimisation en cours…' : 'Lancer l’optimisation'}
        </button>
      ),
    },
  };
  const current = windows[step];

  return (
    <WizardWindow
      steps={STEPS}
      current={step}
      canOpen={() => !busy && !!saved}
      onOpen={(i) => setStep(i as Step)}
      intro={current.intro}
      footer={
        <>
          {back}
          {step === 0 && saved && (
            <button onClick={toPlanning} disabled={busy}>
              Ouvrir en planification
            </button>
          )}
          {current.next}
        </>
      }
    >
      <p className="resume-project">
        <b>{state.mission.name}</b>
        <small>Enregistré le {new Date(project.savedAt).toLocaleString('fr-FR')}</small>
      </p>
      {current.body}
    </WizardWindow>
  );
}

const ZONE_TABS = ['Intervention', 'Interdites', 'Urbaines', 'Prioritaires'] as const;

/** Les mêmes outils de tracé qu'en planification, regroupés en onglets. */
function ZoneTabs() {
  const [tab, setTab] = useState(0);
  const { setDrawMode, setEditing } = useConfigEditorStore();
  return (
    <>
      <div className="segmented" role="tablist" aria-label="Zones à retoucher">
        {ZONE_TABS.map((label, i) => (
          <button
            key={label}
            role="tab"
            aria-selected={tab === i}
            className={tab === i ? 'active' : ''}
            onClick={() => {
              setDrawMode('idle');
              setEditing(false);
              setTab(i);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 0 && <AreaFields />}
      {tab === 1 && <ConstraintFields kinds={['interdite', 'hauteur_limitee']} />}
      {tab === 2 && <ConstraintFields kinds={['urbaine']} />}
      {tab === 3 && <PriorityFields />}
    </>
  );
}

const shortName = (name: string) => name.replace(/^DJI /, '');

/**
 * Drones qu'un télépilote emporte : il peut en avoir plusieurs, mais n'en pilote qu'un à la
 * fois (le solveur choisit lequel). Il en garde toujours au moins un.
 */
function DroneChoice({
  selected,
  onToggle,
  label,
}: {
  selected: string[];
  onToggle: (modelId: string, on: boolean) => void;
  label: string;
}) {
  const catalog = useMissionStore((s) => s.catalog);
  const busy = useMissionStore((s) => s.busy);
  return (
    <div className="drone-chips" role="group" aria-label={label}>
      {catalog?.drones.map((d) => {
        const on = selected.includes(d.id);
        const last = on && selected.length === 1;
        return (
          <button
            key={d.id}
            aria-pressed={on}
            className={`drone-chip ${on ? 'on' : ''}`}
            disabled={busy || last}
            title={last ? 'Il faut au moins un drone par télépilote' : d.name}
            onClick={() => onToggle(d.id, !on)}
          >
            {on && (
              <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                <path
                  d="M2 6.5l2.5 2.5L10 3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                />
              </svg>
            )}
            {shortName(d.name)}
          </button>
        );
      })}
    </div>
  );
}

/** Niveau du télépilote : il fixe sa portée (1 ou 2 km) et ses hauteurs de vol. */
function LevelSwitch({
  level,
  onChange,
  name,
}: {
  level: PilotLevel;
  onChange: (level: PilotLevel) => void;
  name: string;
}) {
  const busy = useMissionStore((s) => s.busy);
  return (
    <div className="segmented level-switch" role="group" aria-label={`Niveau de ${name}`}>
      {(['TP1', 'TP2'] as const).map((l) => (
        <button
          key={l}
          className={level === l ? 'active' : ''}
          aria-pressed={level === l}
          disabled={busy}
          onClick={() => level !== l && onChange(l)}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

/**
 * Télépilotes réellement présents : niveau, drone qu'ils font voler, présence.
 * On peut en ajouter qui n'étaient pas prévus et en retirer un ou plusieurs.
 */
function MeansFields() {
  const { state, catalog, busy } = useMissionStore();
  const { project, available, setAvailable } = useResumeStore();
  const update = useMissionUpdate();
  const [removing, setRemoving] = useState(false);
  const [toRemove, setToRemove] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [level, setLevel] = useState<PilotLevel>('TP1');
  const [models, setModels] = useState<string[]>([]);
  if (!state || !project) return null;
  const { mission } = state;
  const drones = catalog?.drones ?? [];
  const saved = retainedProposal(project);
  const engaged = new Set(saved?.assignments.map((a) => a.resourceId));
  const couplesOf = (pilotId: string) => mission.resources.filter((r) => r.pilotId === pilotId);
  const isPresent = (pilotId: string) =>
    couplesOf(pilotId).some((r) => available[r.id] ?? r.available);
  const present = mission.pilots.filter((p) => isPresent(p.id));

  const setPresent = (pilotId: string, on: boolean) =>
    couplesOf(pilotId).forEach((r) => setAvailable(r.id, on));
  const removeSelected = () =>
    void update(withoutPilots(mission, toRemove)).then(() => {
      setToRemove([]);
      setRemoving(false);
    });
  const addPilot = () => {
    if (!name.trim() || !models.length) return;
    void update(
      withPilot(mission, { id: crypto.randomUUID(), name: name.trim(), level, modelIds: models }),
    ).then(() => {
      setName('');
      setModels([]);
    });
  };

  return (
    <>
      <p className="means-summary">
        <span>
          <b>{present.length}</b> télépilote(s) présent(s) sur {mission.pilots.length}
        </span>
      </p>

      <div className={`means-toolbar ${removing ? 'selecting' : ''}`}>
        {removing ? (
          <span className="means-toolbar-hint" role="status">
            {toRemove.length
              ? `${toRemove.length} télépilote(s) sélectionné(s)`
              : 'Cochez les télépilotes à retirer'}
          </span>
        ) : (
          <span className="means-toolbar-hint">
            <span
              className={`pill ${present.length > mission.maxDrones ? 'warn' : ''}`}
              title="Le solveur n’engagera pas plus de drones que l’arrêté n’en autorise"
            >
              Arrêté : {mission.maxDrones} drones max
            </span>
          </span>
        )}
        <button
          className={`icon-button ${removing ? 'active' : ''}`}
          aria-pressed={removing}
          aria-label={removing ? 'Terminer la sélection' : 'Sélectionner des télépilotes'}
          title={removing ? 'Terminer la sélection' : 'Sélectionner des télépilotes à retirer'}
          disabled={busy || !mission.pilots.length}
          onClick={() => {
            setRemoving(!removing);
            setToRemove([]);
          }}
        >
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
            <rect
              x="3"
              y="3"
              width="14"
              height="14"
              rx="3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            />
            <path
              d="M6.5 10.2l2.4 2.4 4.6-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          className="icon-button trash"
          aria-label={`Retirer ${toRemove.length} télépilote(s)`}
          title={
            toRemove.length
              ? `Retirer ${toRemove.length} télépilote(s)`
              : 'Sélectionnez d’abord les télépilotes à retirer'
          }
          disabled={busy || !removing || !toRemove.length}
          onClick={removeSelected}
        >
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
            <path
              d="M3.5 5.5h13M8 5.5V4a1 1 0 011-1h2a1 1 0 011 1v1.5M5.2 5.5l.8 10.6a1.5 1.5 0 001.5 1.4h5a1.5 1.5 0 001.5-1.4l.8-10.6M8.5 8.5v6M11.5 8.5v6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {removing && toRemove.length > 0 && <span className="count">{toRemove.length}</span>}
        </button>
      </div>

      <ul className={`pilot-cards ${removing ? 'removing' : ''}`}>
        {mission.pilots.length === 0 && (
          <li className="empty">Aucun télépilote : ajoutez ceux qui sont présents.</li>
        )}
        {mission.pilots.map((pilot) => {
          const on = isPresent(pilot.id);
          const selected = toRemove.includes(pilot.id);
          const isEngaged = couplesOf(pilot.id).some((r) => engaged.has(r.id));
          return (
            <li
              key={pilot.id}
              className={`pilot-card ${on ? '' : 'absent'} ${selected ? 'selected' : ''}`}
            >
              <div className="pilot-card-head">
                {removing ? (
                  <input
                    type="checkbox"
                    checked={selected}
                    aria-label={`Sélectionner ${pilot.name} pour le retirer`}
                    onChange={(e) =>
                      setToRemove(
                        e.target.checked
                          ? [...toRemove, pilot.id]
                          : toRemove.filter((id) => id !== pilot.id),
                      )
                    }
                  />
                ) : (
                  <input
                    type="checkbox"
                    checked={on}
                    aria-label={`${pilot.name} présent`}
                    title={on ? 'Présent' : 'Absent'}
                    onChange={(e) => setPresent(pilot.id, e.target.checked)}
                  />
                )}
                <b className="pilot-name">{pilot.name}</b>
                {isEngaged && <span className="pill">Engagé</span>}
                {!on && <span className="pill danger">Absent</span>}
                <LevelSwitch
                  level={pilot.level}
                  name={pilot.name}
                  onChange={(l) => void update(withLevel(mission, pilot.id, l))}
                />
              </div>
              <DroneChoice
                label={`Drone de ${pilot.name}`}
                selected={pilotModels(mission, pilot.id)}
                onToggle={(model, on) => void update(withDrone(mission, pilot.id, model, on))}
              />
            </li>
          );
        })}
      </ul>

      <details className="add-couple">
        <summary>Ajouter un télépilote</summary>
        <div className="add-pilot">
          <label>
            Nom
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex. GND Dupont"
            />
          </label>
          <LevelSwitch level={level} name="ce télépilote" onChange={setLevel} />
        </div>
        <DroneChoice
          label="Drones du nouveau télépilote"
          selected={models}
          onToggle={(model, on) =>
            setModels(on ? [...models, model] : models.filter((m) => m !== model))
          }
        />
        <small className="hint">
          Il peut emporter plusieurs drones, mais n’en pilote qu’un à la fois.
        </small>
        <button
          className="primary"
          onClick={addPilot}
          disabled={busy || !name.trim() || !models.length}
        >
          Ajouter le télépilote
        </button>
      </details>

      <label>
        Drones maximum autorisés par l’arrêté
        <input
          type="number"
          min={0}
          value={mission.maxDrones}
          onChange={(e) =>
            void update({ maxDrones: Math.max(0, Math.floor(Number(e.target.value))) })
          }
        />
      </label>
    </>
  );
}

const kmh = (ms: number) => Math.round(ms * 3.6);

/** Import de la météo du secteur, corrections de l'opérateur, drones hors limites. */
function WeatherFields() {
  const { state, catalog, busy } = useMissionStore();
  const { available, weather, setWeather } = useResumeStore();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  if (!state) return null;
  const { mission } = state;

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      setWeather(await importWeather(mission.workArea));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setWeather(weather ?? MANUAL_WEATHER);
    } finally {
      setLoading(false);
    }
  };
  const edit = (patch: Partial<Weather>) => weather && setWeather(editWeather(weather, patch));
  const summary = weather && summarizeWeather(weather);

  const grounded = weather
    ? mission.resources
        .filter((r) => available[r.id] ?? r.available)
        .flatMap((r) => {
          const drone = catalog?.drones.find((d) => d.id === r.droneModelId);
          const limits = drone ? weatherLimits(drone, weather) : [];
          const pilot = mission.pilots.find((p) => p.id === r.pilotId);
          return limits.length
            ? [{ id: r.id, label: `${drone?.name}, ${pilot?.name ?? r.id}`, limits }]
            : [];
        })
    : [];

  const number = (
    label: string,
    value: number,
    onChange: (v: number) => void,
    unit: string,
    step = 1,
  ) => (
    <label className="weather-field">
      {label}
      <span className="with-unit">
        <input
          type="number"
          step={step}
          value={value}
          onChange={(e) =>
            Number.isFinite(e.target.valueAsNumber) && onChange(e.target.valueAsNumber)
          }
        />
        <small>{unit}</small>
      </span>
    </label>
  );

  return (
    <>
      <button className="draw-button" onClick={() => void load()} disabled={busy || loading}>
        {loading
          ? 'Import en cours…'
          : weather
            ? 'Importer à nouveau la météo du secteur'
            : 'Importer la météo du secteur'}
      </button>
      {error && (
        <p className="notice warn" role="alert">
          {error}
        </p>
      )}

      {!weather ? (
        <p className="hint">
          Sans import, la météo relevée par le serveur au lancement sera utilisée.
        </p>
      ) : (
        <>
          <p className={`weather-source ${summary?.caveat ? 'caveat' : ''}`}>
            {weather.source === 'api'
              ? `Relevé Open-Meteo de ${new Date(weather.fetchedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
              : summary?.caveat}
          </p>
          <div className="weather-grid">
            {number('Vent moyen', kmh(weather.windMs), (v) => edit({ windMs: v / 3.6 }), 'km/h')}
            {number('Rafales', kmh(weather.gustMs), (v) => edit({ gustMs: v / 3.6 }), 'km/h')}
            {number(
              'Précipitations',
              weather.precipitationMm,
              (v) => edit({ precipitationMm: Math.max(0, v) }),
              'mm',
              0.1,
            )}
            {number('Température', weather.temperatureC, (v) => edit({ temperatureC: v }), '°C')}
          </div>
          <div className="segmented" role="group" aria-label="Luminosité">
            {[true, false].map((day) => (
              <button
                key={String(day)}
                className={weather.isDay === day ? 'active' : ''}
                aria-pressed={weather.isDay === day}
                onClick={() => edit({ isDay: day })}
              >
                {day ? 'Jour' : 'Nuit'}
              </button>
            ))}
          </div>
          {grounded.length > 0 ? (
            <div className="notice warn">
              <b>Hors limites avec cette météo</b>
              <ul className="grounded">
                {grounded.map((g) => (
                  <li key={g.id}>
                    {g.label} : {g.limits.join(', ')}
                  </li>
                ))}
              </ul>
              <small>Ces drones seront écartés par l’optimisation.</small>
            </div>
          ) : (
            <p className="hint">Tous les drones disponibles peuvent voler avec cette météo.</p>
          )}
        </>
      )}
    </>
  );
}
