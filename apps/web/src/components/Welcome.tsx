import { useRef, useState } from 'react';
import { create } from 'zustand';
import { useMissionStore } from '../app/missionStore';
import { adoptGeneratedMeans, openProject } from '../features/live/resume';
import { useResumeStore } from '../features/live/ResumeWizard';
import { resetConfigEditor } from '../features/config/store';
import { parseProject } from './project';
import './welcome.css';

export type StartMode = 'planification' | 'conduite';

/** Choix fait sur l'écran d'accueil (aucun = accueil affiché tant qu'il n'y a pas de mission). */
export const useStartStore = create<{ mode?: StartMode; setMode: (mode?: StartMode) => void }>(
  (set) => ({ setMode: (mode) => set({ mode }) }),
);

/**
 * Écran d'accueil : partir de rien (Planification) ou reprendre un projet enregistré
 * pour le conduire avec les moyens réellement disponibles (Conduite).
 */
export function Welcome() {
  const { mode, setMode } = useStartStore();
  return (
    <div className="welcome">
      <div className="welcome-watermark" aria-hidden="true">
        Aeris
      </div>
      <main className="welcome-content">
        <header className="welcome-brand">
          <span className="tricolore" aria-hidden="true" />
          <div>
            <h1>Aeris</h1>
            <p>Aide à la décision drones</p>
          </div>
        </header>
        {mode === 'conduite' ? (
          <ResumeProject onBack={() => setMode(undefined)} />
        ) : (
          <div className="welcome-choices">
            <button
              className="choice"
              onClick={() => {
                resetConfigEditor();
                setMode('planification');
              }}
            >
              <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
                <path
                  d="M5 9l7-3 8 3 7-3v17l-7 3-8-3-7 3z M12 6v17 M20 9v17"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
              </svg>
              <b>Planification</b>
              <span>
                Partir de rien : situer l’intervention, tracer ses zones et ses phases, puis obtenir
                les dispositifs optimisés.
              </span>
            </button>
            <button className="choice" onClick={() => setMode('conduite')}>
              <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
                <g fill="none" stroke="currentColor" strokeWidth="1.8">
                  <circle cx="16" cy="16" r="11" />
                  <circle cx="16" cy="16" r="5" />
                  <path d="M16 16l8-8" strokeLinecap="round" />
                </g>
              </svg>
              <b>Conduite</b>
              <span>
                Reprendre une intervention enregistrée, ajuster zones, moyens et météo, puis
                relancer l’optimisation.
              </span>
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

/** Conduite : choisir le projet enregistré ; la suite se fait sur la carte (ResumeWizard). */
function ResumeProject({ onBack }: { onBack: () => void }) {
  const { setState, run, busy } = useMissionStore();
  const begin = useResumeStore((s) => s.begin);
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();

  const load = async (file?: File) => {
    if (!file) return;
    const { project: parsed, error: e } = parseProject(await file.text());
    setError(e);
    if (!parsed) return;
    const project = adoptGeneratedMeans(parsed);
    await run(async () => {
      const state = await openProject(project);
      begin(project);
      setState(state);
    });
  };

  return (
    <section className="welcome-step">
      <h2>Reprendre une intervention</h2>
      <p>
        Choisissez un projet enregistré depuis le menu d’Aeris (.aeris.json). Vous pourrez ensuite
        retoucher les zones, déclarer les moyens disponibles et importer la météo.
      </p>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        className="sr-only"
        onChange={(e) => void load(e.target.files?.[0])}
      />
      <div
        className="dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void load(e.dataTransfer.files[0]);
        }}
      >
        <button className="primary" onClick={() => input.current?.click()} disabled={busy}>
          {busy ? 'Ouverture…' : 'Choisir un fichier de projet'}
        </button>
        <small>ou déposez-le ici</small>
      </div>
      {error && (
        <p className="notice danger" role="alert">
          {error}
        </p>
      )}
      <div className="welcome-nav">
        <button onClick={onBack}>Retour</button>
      </div>
    </section>
  );
}
