import { useEffect } from 'react';
import { api } from '../../api/client';
import { useMissionStore } from '../../app/missionStore';
import { pilotColor } from '../../map/colors';
import { resourceLabel } from '../resourceLabel';
import { KpiGrid } from '../../components/KpiGrid';
import { SeparationCard } from '../../components/SeparationCard';
import { useFocusStore } from '../../components/focus';
import { formatSlot } from '../../components/format';
import { phaseDiagnostics } from '../../components/separation';
import { CompareTable } from './CompareTable';
import { STATUS_LABELS, columnLabels } from './compare';
import { applyMoves, moveKey } from './draft';
import { buildSectorsGeoJSON, downloadGeoJson } from './exportSectors';
import { useSelection } from './selection';
import { useScenarioStore } from './store';
import './scenarios.css';

/**
 * Étape « Propositions », posée sur la carte : fenêtre Proposition à gauche (choix en un
 * clic, indicateurs, couples, séparation, décision) et fenêtre Comparaison à droite, en
 * lecture seule. Un seul bouton, toujours au même endroit, réduit et rouvre les fenêtres :
 * réduites, la carte repasse au premier plan pour déplacer les pilotes.
 */
export function ScenariosPanel() {
  const { setState, run, busy, catalog } = useMissionStore();
  const { select, minimized, setMinimized, clearDraft } = useScenarioStore();
  const { focusId, focus } = useFocusStore();
  const { state, proposals, selected, phase, moves, pending, inPhase } = useSelection();

  useEffect(() => {
    if (minimized) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMinimized(true);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [minimized, setMinimized]);

  if (!state) return null;
  const { mission } = state;
  const pilotIds = mission.pilots.map((pilot) => pilot.id);
  const labels = columnLabels(proposals);
  const metrics = selected?.metricsByPhase[phase];

  // Recalcul : applique les déplacements en attente, sinon relance le solveur
  // en remplaçant les propositions existantes (elles ne s'empilent plus).
  const recompute = () =>
    run(async () => {
      if (selected && pending > 0) {
        await api.editProposal(mission.id, selected.id, applyMoves(selected.assignments, moves));
      } else {
        for (const p of proposals) await api.deleteProposal(mission.id, p.id);
        await api.solve(mission.id);
      }
      clearDraft();
      setState(await api.getMission(mission.id));
    });

  const exportAllSectors = async () => {
    if (!selected) return;
    try {
      const cov = await api.coverage(mission.id, selected.id, phase);
      const fc = buildSectorsGeoJSON(mission, phase, inPhase, cov, catalog);
      downloadGeoJson(fc.name, fc);
    } catch {
      const fc = buildSectorsGeoJSON(mission, phase, inPhase, undefined, catalog);
      downloadGeoJson(fc.name, fc);
    }
  };

  const exportSingleSector = async (resourceId: string) => {
    if (!selected) return;
    try {
      const cov = await api.coverage(mission.id, selected.id, phase);
      const fc = buildSectorsGeoJSON(mission, phase, inPhase, cov, catalog, resourceId);
      downloadGeoJson(`secteur-${resourceId}-phase-${phase + 1}`, fc);
    } catch {
      const fc = buildSectorsGeoJSON(mission, phase, inPhase, undefined, catalog, resourceId);
      downloadGeoJson(`secteur-${resourceId}-phase-${phase + 1}`, fc);
    }
  };

  // Même bouton, même place pour réduire et rouvrir : seule la flèche s'inverse.
  const toggle = (
    <button
      className={`window-toggle ${minimized ? 'floating' : ''}`}
      onClick={() => setMinimized(!minimized)}
      aria-expanded={!minimized}
      title={minimized ? 'Rouvrir les propositions' : 'Réduire pour voir le plan (Échap)'}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path
          d={minimized ? 'M3 6l5 5 5-5' : 'M3 10l5-5 5 5'}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        />
      </svg>
      <span>{selected?.label ?? 'Aucune proposition'}</span>
      {minimized && pending > 0 && <em>{pending} à recalculer</em>}
    </button>
  );

  if (minimized) return toggle;

  return (
    <>
      {toggle}

      <section className="float-panel proposal-window" aria-label="Proposition retenue">
        <div className="float-scroll">
          {proposals.length > 0 && (
            <div className="segmented strategies" role="group" aria-label="Proposition affichée">
              {proposals.map((p) => (
                <button
                  key={p.id}
                  className={`${p.id === selected?.id ? 'active' : ''} strategy-${p.strategy}`}
                  aria-pressed={p.id === selected?.id}
                  disabled={pending > 0 && p.id !== selected?.id}
                  title={pending > 0 ? 'Recalculez ou annulez les déplacements d’abord' : p.label}
                  onClick={() => select(p.id)}
                >
                  {labels.get(p.id)}
                </button>
              ))}
            </div>
          )}

          {!selected ? (
            <p className="empty">Aucune proposition. Lancez le calcul pour en obtenir.</p>
          ) : (
            <>
              <p className="window-status">
                <span
                  className={`pill ${selected.status === 'infaisable' ? 'danger' : selected.status === 'optimal' ? 'ok' : ''}`}
                >
                  {STATUS_LABELS[selected.status]}
                </span>
                {pending === 0 && (
                  <small>Réduisez la fenêtre pour déplacer les pilotes sur le plan.</small>
                )}
              </p>

              {pending > 0 && (
                <div className="notice warn draft">
                  {pending === 1 ? '1 couple déplacé' : `${pending} couples déplacés`} sur le plan :
                  les indicateurs ne sont pas à jour.
                  <button className="small" onClick={clearDraft} disabled={busy}>
                    Annuler les déplacements
                  </button>
                </div>
              )}

              {metrics && <KpiGrid metrics={metrics} />}

              <div className="section-header-actions">
                <h3>
                  Couples engagés
                  {mission.phaseCount > 1 && <small> en phase {phase + 1}</small>}
                </h3>
                {inPhase.length > 0 && (
                  <button
                    className="small"
                    title="Télécharger les secteurs de vol des drones au format GeoJSON (QGIS / ATAK)"
                    onClick={exportAllSectors}
                  >
                    Exporter les secteurs (GeoJSON)
                  </button>
                )}
              </div>
              {inPhase.length === 0 ? (
                <p className="hint">Aucun couple engagé sur cette phase.</p>
              ) : (
                <ul className="couples-list">
                  {inPhase.map((a) => {
                    const moved = moves[moveKey(a.resourceId, a.phase)] !== undefined;
                    const pilotId = mission.resources.find(
                      (resource) => resource.id === a.resourceId,
                    )?.pilotId;
                    return (
                      <li key={a.resourceId} className={focusId === a.resourceId ? 'focused' : ''}>
                        <div>
                          <b title={a.resourceId}>
                            {pilotId && (
                              <span
                                className="pilot-color-dot"
                                style={{ backgroundColor: pilotColor(pilotId, pilotIds) }}
                                aria-hidden="true"
                              />
                            )}{' '}
                            {resourceLabel(mission, a.resourceId, catalog)}
                          </b>
                          <span className="pill">{a.radiusM / 1000} km</span>
                          {moved && <span className="pill warn">Déplacé</span>}
                          <small>
                            {a.altitude.minM} à {a.altitude.maxM} m,{' '}
                            {formatSlot(a.slot).toLowerCase()}
                          </small>
                        </div>
                        <div className="couple-buttons">
                          <button
                            className="small"
                            title="Réduire la fenêtre et centrer la carte sur ce couple"
                            onClick={() => {
                              focus(a.resourceId);
                              setMinimized(true);
                            }}
                          >
                            Déplacer
                          </button>
                          <button
                            className="small"
                            title="Exporter la zone de couverture propre à ce drone (GeoJSON)"
                            onClick={() => exportSingleSector(a.resourceId)}
                          >
                            Secteur
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              <SeparationCard
                assignments={inPhase}
                diagnostics={phaseDiagnostics(selected.diagnostics, phase)}
                infeasible={selected.status === 'infaisable'}
              />
            </>
          )}
        </div>

        <footer className="float-foot">
          <button className="recompute" disabled={busy} onClick={recompute}>
            {pending > 0 ? 'Recalculer la couverture' : 'Recalculer'}
          </button>
          <button
            className="validate"
            disabled={busy || !selected || pending > 0 || selected.status === 'infaisable'}
            title={pending > 0 ? 'Recalculez ou annulez les déplacements d’abord' : undefined}
            onClick={() =>
              selected && run(async () => setState(await api.start(mission.id, selected.id)))
            }
          >
            Valider le dispositif
          </button>
        </footer>
      </section>

      <section className="float-panel compare-window" aria-labelledby="compare-title">
        <div className="float-scroll">
          <h2 id="compare-title">
            Comparaison
            {mission.phaseCount > 1 && <small> en phase {phase + 1}</small>}
          </h2>
          {proposals.length === 0 ? (
            <p className="empty">Aucune proposition à comparer.</p>
          ) : (
            <>
              <CompareTable proposals={proposals} selectedId={selected?.id} phase={phase} />
              <p className="hint">
                En vert, la meilleure valeur de la phase. La colonne soulignée est la proposition
                affichée.
              </p>
            </>
          )}
        </div>
      </section>
    </>
  );
}
