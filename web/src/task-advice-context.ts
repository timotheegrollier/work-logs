import { api, type Project, type Task } from './lib';
import { AiCancelled, AiError, MAX_ADVICE_SOURCE_CHARS, MAX_ADVICE_SOURCES, MAX_ADVICE_TASKS, truncate, type AdviceSource, type AdviceTask } from './ai-suggest';
import { readProjectAiBrief } from './ai-context';
import { richToMarkdown } from './rich-markdown';

const MAX_SOURCES_PER_TASK = 3;

/** Prépare localement les extraits proposés ; aucun appel au fournisseur IA. */
export async function prepareTaskAdvice(
  tasks: Task[], projects: Project[], signal?: AbortSignal,
): Promise<{ tasks: AdviceTask[]; sources: AdviceSource[]; omitted: number }> {
  const open = tasks.filter((task) => task.status !== 'done');
  if (!open.length) throw new AiError('Aucune tâche ouverte à conseiller.');
  if (open.length > MAX_ADVICE_TASKS) throw new AiError(`Trop de tâches à analyser (${open.length}, ${MAX_ADVICE_TASKS} au plus) : filtre un projet ou une catégorie.`);
  if (signal?.aborted) throw new AiCancelled();
  const chosen = new Map<string, Task['documents'][number]>();
  const all = new Set<string>();
  const taskSourceIds = new Map<string, string[]>();
  for (const task of open) {
    const ids: string[] = [];
    for (const doc of task.documents ?? []) {
      all.add(doc.id);
      if (doc.archived || doc.google_document_id || doc.google_tab_id || ids.includes(doc.id) || ids.length >= MAX_SOURCES_PER_TASK) continue;
      if (!chosen.has(doc.id) && chosen.size >= MAX_ADVICE_SOURCES) continue;
      chosen.set(doc.id, doc);
      ids.push(doc.id);
    }
    taskSourceIds.set(task.id, ids);
  }
  // Limiter les lectures simultanées évite de saturer l'API et le stockage PWA.
  const loaded = new Map<string, AdviceSource>();
  const candidates = [...chosen.values()];
  for (let i = 0; i < candidates.length; i += 5) {
    await Promise.all(candidates.slice(i, i + 5).map(async (summary) => {
      if (signal?.aborted) throw new AiCancelled();
      try {
        const entry = await api.entry(summary.id);
        if (signal?.aborted) throw new AiCancelled();
        if (entry.google_sync || entry.archived || entry.project_id !== summary.project_id) {
          throw new Error('source modifiée depuis le chargement');
        }
        const text = entry.content_json ? richToMarkdown(entry.content_json) : entry.content_md;
        if (text.trim()) loaded.set(entry.id, { id: entry.id, title: entry.title, kind: entry.kind, text: truncate(text, MAX_ADVICE_SOURCE_CHARS) });
      } catch (error) {
        if (error instanceof AiCancelled) throw error;
        throw new AiError(`Impossible de lire « ${summary.title} » pour les conseils IA. Réessaie après actualisation.`);
      }
    }));
  }
  if (signal?.aborted) throw new AiCancelled();
  const sources = candidates.flatMap((source) => loaded.get(source.id) ? [loaded.get(source.id)!] : []);
  return {
    tasks: open.map((task) => ({
      id: task.id, title: task.title, status: task.status, priority: task.priority, due_date: task.due_date,
      pinned: task.pinned, created_at: task.created_at, project: projects.find((project) => project.id === task.project_id)?.name,
      projectId: task.project_id ?? undefined, projectBrief: readProjectAiBrief(task.project_id), documents: task.documents?.length ?? 0,
      sources: (taskSourceIds.get(task.id) ?? []).flatMap((id) => loaded.get(id) ? [loaded.get(id)!] : []),
    })),
    sources,
    omitted: [...all].filter((id) => !loaded.has(id)).length,
  };
}
