import { useEffect, useState } from 'react';
import { AI_USED_EVENT, aiModelName, readAiStatus, type AiEngineStatus, type AiLimitKind, type AiStatus } from '../ai-status';

/** Relecture tant que le panneau est ouvert ; chaque réponse IA la déclenche aussi. */
export const AI_STATUS_REFRESH_MS = 60_000;

const LIMIT_LABELS: Record<AiLimitKind, string> = {
  requests_per_day: 'requêtes / jour',
  requests_per_minute: 'requêtes / minute',
  tokens_per_day: 'jetons / jour',
  tokens_per_minute: 'jetons / minute',
};

const count = (value: number) => value.toLocaleString('fr-FR').replace(/\s/g, ' ');
const hour = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—');
const day = (iso: string) => new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function AiQuotas() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let controller: AbortController | null = null;
    const load = () => {
      controller?.abort();
      const current = (controller = new AbortController());
      readAiStatus(current.signal).then(
        (value) => { setStatus(value); setFailed(false); },
        () => { if (!current.signal.aborted) setFailed(true); },
      );
    };
    load();
    const timer = setInterval(load, AI_STATUS_REFRESH_MS);
    window.addEventListener(AI_USED_EVENT, load);
    return () => {
      controller?.abort();
      clearInterval(timer);
      window.removeEventListener(AI_USED_EVENT, load);
    };
  }, []);

  return (
    <section className="ai-quotas" aria-label="Modèles et quotas de l’IA">
      <h4>Modèles et quotas</h4>
      {!status && !failed && <p className="ai-hint">Lecture des quotas…</p>}
      {failed && <p className="ai-hint" role="status">Quotas illisibles pour le moment : le Worker WorkLogs ne répond pas.</p>}
      {status && <>
        {!status.gemini_configured && <p className="notice">Gemini Flash n’est pas encore activé sur le Worker WorkLogs : Gemma 4 répond seul.</p>}
        <ol className="ai-quota-list">
          {status.models.map((engine) => <AiEngine key={engine.id} engine={engine} />)}
        </ol>
        <p className="ai-hint">
          Essayés dans cet ordre : le suivant prend le relais quand un quota est atteint. Comptés par le Worker
          pour tous tes appareils, actualisés à {hour(status.updated_at)}.
        </p>
      </>}
    </section>
  );
}

function AiEngine({ engine }: { engine: AiEngineStatus }) {
  const name = engine.resolved && engine.resolved !== engine.id ? `${engine.label} → ${aiModelName(engine.resolved)}` : engine.label;
  const { requests, input_tokens: input, output_tokens: output } = engine.today;
  const limits = Object.entries(engine.limits) as [AiLimitKind, { value: number; learned_at: string | null }][];
  const learned = limits.map(([, { learned_at: at }]) => at).filter((at): at is string => Boolean(at)).sort().at(-1);
  return (
    <li className={engine.blocked_until ? 'is-blocked' : ''} aria-label={name}>
      <div className="ai-quota-head">
        <b>{name}</b>
        <span className="ai-quota-state">
          {engine.blocked_until ? `${capitalized(engine.blocked_reason ?? 'indisponible')} — retour à ${hour(engine.blocked_until)}` : 'Disponible'}
        </span>
      </div>
      <p>
        Aujourd’hui : {count(requests)} requête{requests > 1 ? 's' : ''} · {count(input + output)} jetons
        {engine.last_minute > 0 && ` · ${count(engine.last_minute)} dans la dernière minute`}
      </p>
      <p>
        Limite :{' '}
        {engine.neurons
          ? `≈ ${count(engine.neurons.used)} / ${count(engine.neurons.limit)} neurones utilisés (quota gratuit Cloudflare)`
          : limits.length
            ? `${limits.map(([kind, { value }]) => `${count(value)} ${LIMIT_LABELS[kind]}`).join(' · ')}, indiquée par Google${learned ? ` le ${day(learned)}` : ''}`
            : <>non publiée par Google, <a href="https://aistudio.google.com/rate-limit" target="_blank" rel="noreferrer">visible dans AI Studio</a></>}
      </p>
      <p>
        Remise à zéro à {hour(engine.reset_at)}
        {!engine.blocked_until && engine.last_error && ` · dernière erreur : ${engine.last_error.reason}`}
      </p>
    </li>
  );
}
