import { useEffect, useRef, type ReactNode } from 'react';
import { useFollowUp, type FollowUpItem } from '../follow-up-controller';
import { isFollowed } from '../lib';
import { AiPending } from './AiMenu';

const STATUS_LABELS = { unclear: 'À préciser', todo: 'À faire', doing: 'En cours', blocked: 'Bloqué', done: 'Terminé' };

function ReportList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return <div className="follow-up-list"><h4>{title}</h4><ul>{items.map((text, index) => <li key={index}>{text}</li>)}</ul></div>;
}

/** Le bilan reste à côté du texte et partage le même état depuis tous ses accès. */
export function FollowUpPanel({ kind, item, compact = false, dirty = false, actions }: {
  kind: 'entry' | 'task';
  item: FollowUpItem;
  compact?: boolean;
  dirty?: boolean;
  /** Vue d'ensemble : les gestes sur l'élément, à côté de la suite proposée, qui reste dépliée pour décider. */
  actions?: ReactNode;
}) {
  const { followUp, stale, busy, queued, error, background, toggle, disable, refresh, stop } = useFollowUp(kind, item);
  const report = followUp?.report;
  const initial = !followUp || !isFollowed(item);
  const activate = useRef<HTMLButtonElement>(null);
  const turnedOff = useRef(false);
  useEffect(() => {
    // Après « Désactiver », le focus passe au bouton qui relance le suivi, pas en haut de page.
    // Une entrée n’a plus de bouton : son panneau disparaît, rien à restaurer.
    if (initial && turnedOff.current && kind !== 'entry') activate.current?.focus();
    turnedOff.current = false;
  }, [initial, kind]);
  // Une entrée sans suivi n’affiche rien : l’activation se fait dans la vue
  // d’ensemble (« + Ajouter au suivi IA »), jamais dans l’entrée.
  if (kind === 'entry' && initial) return null;
  const proposals = report && <>
    <ReportList title="Prochaines actions" items={report.next_steps} />
    <ReportList title="Blocages" items={report.blockers} />
  </>;
  const details = <>
    {report && <>
      <div className="follow-up-lists">
        <ReportList title="Avancées" items={report.completed} />
        {!actions && proposals}
      </div>
      {report.warnings.length > 0 && <ul className="follow-up-warnings" aria-label="Limites du bilan">{report.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    </>}
    <label className="follow-up-auto">
      <input type="checkbox" aria-label={`Actualisation automatique de ${item.title}`} checked={Boolean(followUp?.enabled)} onChange={(event) => toggle(event.target.checked)} />
      <span>Actualiser automatiquement après enregistrement</span>
    </label>
    <p className="follow-up-privacy">Le texte enregistré{kind === 'task' ? ' des documents liés et les champs de la tâche sont envoyés' : ' est envoyé'} au service IA configuré dans les Paramètres.</p>
  </>;

  return <section className={'follow-up no-print' + (compact ? ' is-compact' : '') + (initial ? ' is-inactive' : '')} aria-label={`Suivi IA de ${item.title}`} aria-busy={busy}>
    {initial ? <>
      {/* Un bouton, pas un encadré : une entrée qui n'en a pas besoin n'en est pas encombrée. */}
      <button ref={activate} className="ghost" type="button" aria-label={`Activer le suivi IA de ${item.title}`} title={`Un bilan des avancées, des prochaines actions et des blocages, actualisé après chaque enregistrement ; le texte${kind === 'task' ? ' des documents liés' : ' de cette entrée'} est envoyé au service IA configuré dans les Paramètres`} disabled={busy} onClick={() => toggle(true)}><span aria-hidden="true">✨ </span>{compact ? 'Suivi IA' : 'Activer le suivi IA'}</button>
    </> : <>
      <div className="follow-up-head">
        <strong>Suivi IA</strong>
        <span className="follow-up-mode">{followUp.enabled ? 'Automatique' : 'Manuel'}</span>
        {report && <span className={'follow-up-status is-' + report.status}>État proposé : {STATUS_LABELS[report.status]}</span>}
        {report && <span className="follow-up-date">Bilan du <time dateTime={report.generated_at}>{new Date(report.generated_at).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></span>}
        {busy && background
          ? <span className="follow-up-refreshing" role="status"><span className="ai-spark" aria-hidden="true">✨</span>{queued ? 'En attente…' : 'Actualisation en cours…'}</span>
          : (stale || dirty) && report && <span className="follow-up-stale" role="status">À actualiser{dirty ? ' après enregistrement' : ''}</span>}
      </div>
      {report ? <p className="follow-up-summary">{report.summary}</p> : !busy && <p className="follow-up-empty">Aucun bilan pour le moment.</p>}
      {actions && <div className="follow-up-lists">{proposals}</div>}
      <div className="follow-up-actions">
        {actions}
        <button className="ghost" type="button" aria-label={`Actualiser le bilan de ${item.title}`} disabled={busy} onClick={refresh}>{report ? 'Actualiser' : 'Générer le bilan'}</button>
        {busy && <button className="ghost" type="button" aria-label={`Arrêter le suivi IA de ${item.title}`} onClick={stop}>Arrêter</button>}
        <button className="ghost follow-up-off" type="button" aria-label={`Désactiver le suivi IA de ${item.title}`} title={kind === 'entry' ? "Arrête le suivi et retire son bilan ; la vue d’ensemble permet de le relancer avec « + Ajouter au suivi IA »" : "Arrête le suivi et retire son bilan ; « ✨ Suivi IA » le relance"} onClick={() => { turnedOff.current = true; disable(); }}>Désactiver</button>
      </div>
      {compact ? <details className="follow-up-details"><summary>Détails du suivi</summary>{details}</details> : details}
    </>}
    {busy && !background && <AiPending label={queued ? 'En attente…' : 'L’IA prépare le bilan…'} />}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
