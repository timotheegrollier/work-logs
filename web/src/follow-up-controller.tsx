import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type AppState, type FollowUp, type FollowUpKind, type FollowUpReportDraft } from './lib';
import { AiCancelled, generateFollowUp, readAiSettings } from './ai-suggest';
import { flushPendingSaves, hasPendingSaves } from './autosave';

export interface FollowUpItem {
  id: string;
  title: string;
  follow_up?: FollowUp | null;
  follow_up_key?: string;
}
type Item = FollowUpItem & { kind: FollowUpKind };
/** `background` : actualisation automatique, présentée sans déplacer le bilan affiché. */
type Runtime = { busy: boolean; error: string; background: boolean };
type Job = { item: Item; manual: boolean };
const keyOf = (kind: FollowUpKind, id: string) => `${kind}:${id}`;
// Une vraie pause d'écriture : deux secondes relançaient l'IA au milieu d'une note.
const AUTO_DELAY = 8000;
/** Deux actualisations automatiques du même élément ne partent pas plus rapprochées. */
const AUTO_COOLDOWN = 60_000;
const idle: Runtime = { busy: false, error: '', background: false };
const reportContent = (report: FollowUpReportDraft) => JSON.stringify([
  report.status, report.summary, report.completed, report.next_steps, report.blockers, report.warnings,
]);
interface Control {
  runtime: Record<string, Runtime>;
  /** `clear` : « Désactiver », l'automatisme et le bilan partent ensemble. */
  toggle: (item: Item, enabled: boolean, clear?: boolean) => void;
  refresh: (item: Item) => void;
  stop: (item: Item) => void;
}
export const FollowUpContext = createContext<Control | null>(null);

/** Un ordonnanceur pour l'écran entier : une seule génération à la fois, même
 * quand une carte et son bilan sont visibles à deux endroits. */
export function FollowUpProvider({ state, onChanged, children }: {
  state: AppState | null;
  onChanged: () => void | Promise<void>;
  children: ReactNode;
}) {
  const [runtime, setRuntime] = useState<Record<string, Runtime>>({});
  const [wake, setWake] = useState(0);
  const mounted = useRef(true);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const items = useMemo(() => new Map<string, Item>([
    ...(state?.entries ?? []).map((item) => [keyOf('entry', item.id), { ...item, kind: 'entry' as const }] as const),
    ...(state?.tasks ?? []).map((item) => [keyOf('task', item.id), { ...item, kind: 'task' as const }] as const),
  ]), [state]);
  const latest = useRef(items);
  latest.current = items;
  // Une erreur ou « Arrêter » ne provoque pas une boucle sur la même version.
  const attempted = useRef(new Map<string, string>());
  // Versions vues pendant cette session : un bilan déjà périmé au chargement ou
  // après une synchro ne doit pas partir tout seul. Une modification faite après
  // l'ouverture, elle, autorise l'actualisation automatique.
  const observed = useRef<{ ready: boolean; keys: Map<string, string>; changed: Map<string, string> }>({
    ready: false, keys: new Map(), changed: new Map(),
  });
  // Le coût d'un appel automatique se limite aussi dans le temps.
  const lastAutoAt = useRef(new Map<string, number>());
  const queue = useRef(new Map<string, Job>());
  const active = useRef<{ key: string; sourceKey: string; controller: AbortController; manual: boolean } | null>(null);
  const configBusy = useRef(new Set<string>());
  const patch = useCallback((key: string, value: Runtime) => {
    if (mounted.current) setRuntime((current) => ({ ...current, [key]: value }));
  }, []);
  const drain = useRef<() => void>(() => {});
  drain.current = () => {
    if (!mounted.current || active.current || queue.current.size === 0) return;
    const [key, job] = queue.current.entries().next().value!;
    queue.current.delete(key);
    // Une demande explicite repart tout de suite ; une actualisation de fond
    // n'ouvre la période de calme qu'au moment où elle appelle vraiment l'IA.
    if (job.manual) lastAutoAt.current.delete(key);
    const controller = new AbortController();
    const request = { key, sourceKey: job.item.follow_up_key ?? '', controller, manual: job.manual };
    active.current = request;
    attempted.current.set(key, request.sourceKey);
    patch(key, { busy: true, error: '', background: !job.manual });
    void (async () => {
      try {
        await flushPendingSaves();
        if (controller.signal.aborted) return;
        const snapshot = await api.followUp(job.item.kind, job.item.id);
        if (controller.signal.aborted) return;
        request.sourceKey = snapshot.source_key;
        // Une file attendue peut déjà avoir été mise à jour sur un autre appareil.
        if (!job.manual && (!snapshot.follow_up?.enabled || snapshot.follow_up.report?.source_key === snapshot.source_key)) return;
        attempted.current.set(key, snapshot.source_key);
        if (!job.manual) lastAutoAt.current.set(key, Date.now());
        const report = await generateFollowUp({ ...readAiSettings(), signal: controller.signal }, snapshot.source);
        if (controller.signal.aborted) return;
        // Les frappes arrivées pendant l'analyse doivent aussi participer au CAS
        // serveur ; aucune ancienne analyse ne devient le bilan d'un nouveau texte.
        await flushPendingSaves();
        if (controller.signal.aborted) return;
        try {
          await api.saveFollowUp(job.item.kind, job.item.id, { report, source_key: snapshot.source_key });
        } catch (error) {
          if (controller.signal.aborted) return;
          if ((error as { code?: string }).code === 'FOLLOW_UP_STALE') throw error;
          // Une réponse perdue peut cacher une écriture réussie. La confirmer
          // évite de payer une nouvelle génération pour le même bilan.
          const saved = await api.followUp(job.item.kind, job.item.id).catch(() => null);
          if (controller.signal.aborted) return;
          const stored = saved?.follow_up?.report;
          const previous = snapshot.follow_up?.report;
          const content = reportContent(report);
          const confirmed = saved?.source_key === snapshot.source_key && stored?.source_key === snapshot.source_key
            && reportContent(stored) === content
            && (!previous || stored.generated_at !== previous.generated_at || stored.source_key !== previous.source_key || reportContent(previous) !== content);
          if (!confirmed) throw error;
        }
        if (!controller.signal.aborted) await changed.current();
      } catch (error) {
        if (!controller.signal.aborted && (error as { code?: string }).code === 'FOLLOW_UP_STALE') {
          attempted.current.delete(key);
          await changed.current();
        } else if (!controller.signal.aborted && !(error instanceof AiCancelled)) {
          patch(key, { busy: false, error: (error as Error).message || 'Impossible de préparer le bilan.', background: false });
        }
      } finally {
        if (active.current === request) active.current = null;
        if (mounted.current) {
          setRuntime((current) => ({ ...current, [key]: { ...(current[key] ?? idle), busy: false, background: false } }));
          setWake((value) => value + 1);
          drain.current();
        }
      }
    })();
  };
  const enqueue = useCallback((item: Item, manual: boolean) => {
    const key = keyOf(item.kind, item.id);
    if (configBusy.current.has(key) || active.current?.key === key || queue.current.has(key)) return;
    if (!manual && attempted.current.get(key) === item.follow_up_key) return;
    queue.current.set(key, { item, manual });
    patch(key, { busy: true, error: '', background: !manual });
    drain.current();
  }, [patch]);
  const stop = useCallback((item: Item) => {
    const key = keyOf(item.kind, item.id);
    attempted.current.set(key, latest.current.get(key)?.follow_up_key ?? item.follow_up_key ?? '');
    observed.current.changed.delete(key);
    lastAutoAt.current.delete(key);
    queue.current.delete(key);
    if (active.current?.key === key) active.current.controller.abort();
    patch(key, idle);
  }, [patch]);
  const toggle = useCallback((item: Item, enabled: boolean, clear = false) => {
    const key = keyOf(item.kind, item.id);
    if (configBusy.current.has(key)) return;
    if (!enabled) stop(item);
    configBusy.current.add(key);
    patch(key, { busy: true, error: '', background: false });
    void (async () => {
      try {
        await flushPendingSaves();
        if (!mounted.current) return;
        const snapshot = await api.saveFollowUp(item.kind, item.id, clear ? { enabled: false, report: null } : { enabled });
        await changed.current();
        configBusy.current.delete(key);
        if (enabled && snapshot.follow_up?.report?.source_key !== snapshot.source_key && mounted.current && latest.current.has(key)) {
          attempted.current.delete(key);
          enqueue({ ...item, follow_up: snapshot.follow_up, follow_up_key: snapshot.source_key }, true);
        } else patch(key, idle);
      } catch (error) {
        patch(key, { busy: false, error: (error as Error).message || 'Impossible de régler le suivi.', background: false });
      } finally {
        configBusy.current.delete(key);
      }
    })();
  }, [enqueue, patch, stop]);

  useEffect(() => {
    // Le nouveau texte annule la réponse en vol ; la version suivante sera
    // regroupée après la pause de saisie et la sauvegarde réussie.
    const request = active.current;
    if (request) {
      const current = items.get(request.key);
      if (!current) {
        request.controller.abort();
        attempted.current.delete(request.key);
      } else if ((!request.manual && !current.follow_up?.enabled) || (current.follow_up_key && request.sourceKey && current.follow_up_key !== request.sourceKey)) request.controller.abort();
    }
    for (const [key, job] of queue.current) {
      const current = items.get(key);
      if (!current || (!job.manual && (!current.follow_up?.enabled || current.follow_up_key !== job.item.follow_up_key))) {
        queue.current.delete(key);
        patch(key, idle);
      }
    }
    // L'état chargé au départ est la référence. Un bilan déjà périmé (relecture
    // hors ligne, synchro d'un autre appareil) reste marqué « À actualiser » et
    // n'est pas payé une deuxième fois sans geste. Seules les versions qui
    // changent pendant la session ouverte déclenchent l'automatisme.
    const watch = observed.current;
    const present = new Set<string>();
    for (const [key, item] of items) {
      present.add(key);
      const sourceKey = item.follow_up_key ?? '';
      const previous = watch.keys.get(key);
      if (watch.ready && previous && sourceKey && sourceKey !== previous) watch.changed.set(key, sourceKey);
      if (!item.follow_up?.enabled || !sourceKey || item.follow_up.report?.source_key === sourceKey) watch.changed.delete(key);
      watch.keys.set(key, sourceKey);
    }
    for (const key of watch.keys.keys()) {
      if (!present.has(key)) {
        watch.keys.delete(key);
        watch.changed.delete(key);
        attempted.current.delete(key);
        lastAutoAt.current.delete(key);
      }
    }
    if (!watch.ready && items.size > 0) watch.ready = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const changed = observed.current.changed;
      if (!observed.current.ready || changed.size === 0) return;
      // Chaque élément attend la pause d'écriture ; s'il vient d'être actualisé,
      // il attend aussi la fin de la période de calme.
      const now = Date.now();
      let wait = Number.POSITIVE_INFINITY;
      for (const key of changed.keys()) {
        const last = lastAutoAt.current.get(key);
        wait = Math.min(wait, last === undefined ? AUTO_DELAY : Math.max(AUTO_DELAY, last + AUTO_COOLDOWN - now));
      }
      if (!Number.isFinite(wait)) return;
      timer = setTimeout(() => {
        // Une sauvegarde en erreur reste en attente : pas d'envoi d'une copie
        // dépassée, et aucun appel IA déclenché par des frappes seules.
        if (hasPendingSaves()) { schedule(); return; }
        const current = Date.now();
        let cooling = false;
        for (const [key, sourceKey] of [...observed.current.changed]) {
          const item = latest.current.get(key);
          if (!item || !item.follow_up?.enabled || item.follow_up_key !== sourceKey) continue;
          if (item.follow_up.report?.source_key === sourceKey) { observed.current.changed.delete(key); continue; }
          const last = lastAutoAt.current.get(key);
          if (last !== undefined && current - last < AUTO_COOLDOWN) { cooling = true; continue; }
          enqueue(item, false);
        }
        if (cooling) schedule();
      }, wait);
    };
    schedule();
    return () => { if (timer) clearTimeout(timer); };
  }, [items, wake, enqueue, patch]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queue.current.clear();
      active.current?.controller.abort();
    };
  }, []);

  return <FollowUpContext.Provider value={{ runtime, toggle, refresh: (item) => enqueue(item, true), stop }}>{children}</FollowUpContext.Provider>;
}

export function useFollowUp(kind: FollowUpKind, item: FollowUpItem) {
  const context = useContext(FollowUpContext);
  const value = context?.runtime[keyOf(kind, item.id)] ?? idle;
  const followUp = item.follow_up ?? null;
  return {
    followUp,
    stale: Boolean(followUp?.report && item.follow_up_key && followUp.report.source_key !== item.follow_up_key),
    ...value,
    toggle: (enabled: boolean) => context?.toggle({ ...item, kind }, enabled),
    disable: () => context?.toggle({ ...item, kind }, false, true),
    refresh: () => context?.refresh({ ...item, kind }),
    stop: () => context?.stop({ ...item, kind }),
  };
}
