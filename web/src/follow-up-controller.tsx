import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type AppState, type FollowUp, type FollowUpKind } from './lib';
import { AiCancelled, generateFollowUp, readAiSettings } from './ai-suggest';
import { flushPendingSaves, hasPendingSaves } from './autosave';

export interface FollowUpItem {
  id: string;
  title: string;
  follow_up?: FollowUp | null;
  follow_up_key?: string;
}
type Item = FollowUpItem & { kind: FollowUpKind };
type Runtime = { busy: boolean; error: string };
type Job = { item: Item; manual: boolean };
const keyOf = (kind: FollowUpKind, id: string) => `${kind}:${id}`;
const AUTO_DELAY = 2000;
const idle: Runtime = { busy: false, error: '' };
interface Control {
  runtime: Record<string, Runtime>;
  toggle: (item: Item, enabled: boolean) => void;
  refresh: (item: Item) => void;
  stop: (item: Item) => void;
}
const Context = createContext<Control | null>(null);

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
    const controller = new AbortController();
    const request = { key, sourceKey: job.item.follow_up_key ?? '', controller, manual: job.manual };
    active.current = request;
    attempted.current.set(key, request.sourceKey);
    patch(key, { busy: true, error: '' });
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
        const report = await generateFollowUp({ ...readAiSettings(), signal: controller.signal }, snapshot.source);
        if (controller.signal.aborted) return;
        // Les frappes arrivées pendant l'analyse doivent aussi participer au CAS
        // serveur ; aucune ancienne analyse ne devient le bilan d'un nouveau texte.
        await flushPendingSaves();
        if (controller.signal.aborted) return;
        await api.saveFollowUp(job.item.kind, job.item.id, { report, source_key: snapshot.source_key });
        if (!controller.signal.aborted) await changed.current();
      } catch (error) {
        if (!controller.signal.aborted && (error as { code?: string }).code === 'FOLLOW_UP_STALE') {
          attempted.current.delete(key);
          await changed.current();
        } else if (!controller.signal.aborted && !(error instanceof AiCancelled)) {
          patch(key, { busy: false, error: (error as Error).message || 'Impossible de préparer le bilan.' });
        }
      } finally {
        if (active.current === request) active.current = null;
        if (mounted.current) {
          setRuntime((current) => ({ ...current, [key]: { ...(current[key] ?? idle), busy: false } }));
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
    patch(key, { busy: true, error: '' });
    drain.current();
  }, [patch]);
  const stop = useCallback((item: Item) => {
    const key = keyOf(item.kind, item.id);
    attempted.current.set(key, latest.current.get(key)?.follow_up_key ?? item.follow_up_key ?? '');
    queue.current.delete(key);
    if (active.current?.key === key) active.current.controller.abort();
    patch(key, idle);
  }, [patch]);
  const toggle = useCallback((item: Item, enabled: boolean) => {
    const key = keyOf(item.kind, item.id);
    if (configBusy.current.has(key)) return;
    if (!enabled) stop(item);
    configBusy.current.add(key);
    patch(key, { busy: true, error: '' });
    void (async () => {
      try {
        await flushPendingSaves();
        if (!mounted.current) return;
        const snapshot = await api.saveFollowUp(item.kind, item.id, { enabled });
        await changed.current();
        configBusy.current.delete(key);
        if (enabled && snapshot.follow_up?.report?.source_key !== snapshot.source_key && mounted.current && latest.current.has(key)) {
          attempted.current.delete(key);
          enqueue({ ...item, follow_up: snapshot.follow_up, follow_up_key: snapshot.source_key }, true);
        } else patch(key, idle);
      } catch (error) {
        patch(key, { busy: false, error: (error as Error).message || 'Impossible de régler le suivi.' });
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
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        // Une sauvegarde en erreur reste en attente : pas d'envoi d'une copie
        // dépassée, et aucun appel IA déclenché par des frappes seules.
        if (hasPendingSaves()) { schedule(); return; }
        for (const item of latest.current.values()) {
          if (item.follow_up?.enabled && item.follow_up_key && item.follow_up.report?.source_key !== item.follow_up_key) enqueue(item, false);
        }
      }, AUTO_DELAY);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [items, wake, enqueue, patch]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queue.current.clear();
      active.current?.controller.abort();
    };
  }, []);

  return <Context.Provider value={{ runtime, toggle, refresh: (item) => enqueue(item, true), stop }}>{children}</Context.Provider>;
}

export function useFollowUp(kind: FollowUpKind, item: FollowUpItem) {
  const context = useContext(Context);
  const value = context?.runtime[keyOf(kind, item.id)] ?? idle;
  const followUp = item.follow_up ?? null;
  return {
    followUp,
    stale: Boolean(followUp?.report && item.follow_up_key && followUp.report.source_key !== item.follow_up_key),
    ...value,
    toggle: (enabled: boolean) => context?.toggle({ ...item, kind }, enabled),
    refresh: () => context?.refresh({ ...item, kind }),
    stop: () => context?.stop({ ...item, kind }),
  };
}
