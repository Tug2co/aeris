import { useMissionStore } from './app/missionStore';
import { MapView } from './map/MapView';
import { MissionLayers } from './map/layers/MissionLayers';
import { MissionSetupLayer } from './map/layers/MissionSetupLayer';
import { Topbar } from './components/Topbar';
import { Legend } from './components/Legend';
import { Welcome, useStartStore } from './components/Welcome';
import { ConfigPanel } from './features/config/ConfigPanel';
import { PlaceLayer } from './features/config/PlaceLayer';
import { ScenariosPanel } from './features/scenarios/ScenariosPanel';
import { ScenarioLayers } from './features/scenarios/ScenarioLayers';
import { useScenarioStore } from './features/scenarios/store';
import { LiveLeft } from './features/live/LiveLeft';
import { LiveRight } from './features/live/LiveRight';
import { LiveLayers } from './features/live/LiveLayers';
import { useLiveStore } from './features/live/store';
import { ResumeWizard, useResumeStore } from './features/live/ResumeWizard';
import { MapVisionControl } from './map/MapVisionControl';
import './theme';

/**
 * Assemblage uniquement : bandeau, panneau gauche, carte, panneau droit. En préparation
 * (planification ou reprise d'un projet) et en Propositions, la carte prend toute la largeur
 * et les fenêtres de l'étape sont posées dessus.
 * Chaque bloc vit dans sa fonctionnalité (features/<nom>) ou dans components/.
 */
export function App() {
  const { state, error } = useMissionStore();
  const mode = useStartStore((s) => s.mode);
  const { phase, selectedId, minimized } = useScenarioStore();
  const live = useLiveStore((s) => s.live);
  const resuming = useResumeStore((s) => !!s.project);
  const status = state?.status ?? 'config';
  const preparing = status === 'config' || status === 'phasage';
  // Propositions : carte pleine largeur, fenêtres posées dessus (assombrie tant qu'elles sont ouvertes).
  const proposing = status === 'propositions';
  const layout = proposing || preparing ? 'no-sides' : '';

  // Communes concernées : métriques de la phase affichée (proposition ou conduite).
  const selected = state?.proposals.find((p) => p.id === selectedId) ?? state?.proposals[0];
  const communes =
    status === 'conduite'
      ? live?.metrics.communes
      : status === 'propositions'
        ? selected?.metricsByPhase[phase]?.communes
        : undefined;

  // Au lancement : choisir Planification (partir de rien) ou Conduite (reprendre un projet).
  if (!state && mode !== 'planification') return <Welcome />;

  return (
    <div className={`app ${layout}`}>
      <Topbar />

      {status === 'conduite' && (
        <aside className="side side-left" aria-label="Panneau de travail">
          <LiveLeft />
        </aside>
      )}

      <main className={`map-area ${proposing && !minimized ? 'dimmed' : ''}`}>
        <MapView>
          {state && preparing && (
            <MissionLayers
              mission={state.mission}
              phase={status === 'phasage' ? phase : undefined}
            />
          )}
          {!state && <MissionSetupLayer />}
          {!state && <PlaceLayer />}
          {status === 'propositions' && <ScenarioLayers />}
          {status === 'conduite' && <LiveLayers />}
        </MapView>
        {preparing && (resuming ? <ResumeWizard /> : <ConfigPanel />)}
        {proposing && <ScenariosPanel />}
        {state && !preparing && !(proposing && !minimized) && <MapVisionControl />}
        {state && !preparing && !(proposing && !minimized) && (
          <Legend withCoverage communes={communes} pilots={state.mission.pilots} />
        )}
        {error && (
          <p className="toast" role="alert">
            {error}
          </p>
        )}
      </main>

      {status === 'conduite' && (
        <aside className="side side-right" aria-label="Évaluation et décision">
          <LiveRight />
        </aside>
      )}
    </div>
  );
}
