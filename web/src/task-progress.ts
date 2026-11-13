import { aiBudgetRefusal } from './ai-budget';
import { AI_TIMEOUT_MS, postChatCompletions, readAiSettings, truncate } from './ai-suggest';
import type { Status } from './lib';
import { checklistProgress } from './markdown';

type TaskProgress = { id: string; status: Status; progress: number };

const LS_SEEN = 'worklogs-task-progress-seen:';
const MIN_TEXT = 40;
const MAX_NOTE = 2000;
const SYSTEM = `Tu estimes l'avancement d'une tâche d'après sa note.
Réponds uniquement en JSON : {"progress": N}, N entier de 0 à 100, la part du travail que la note dit déjà faite.
Compte seulement ce qui est écrit comme fait, et ce qui reste à faire. Une note qui décrit un plan sans dire ce qui est fait vaut 0.
Si la note ne permet pas d'en juger, réponds {"progress": null}.`;

/**
 * Avancement réglé automatiquement : jamais 100 %, car terminer une tâche archive sa note et
 * reste un geste. Une tâche terminée n'est pas touchée ; une tâche entamée passe « En cours ».
 */
export function autoTaskState(task: Pick<TaskProgress, 'status' | 'progress'>, estimate: number): { status: Status; progress: number } | null {
  if (task.status === 'done') return null;
  const progress = Math.min(99, Math.max(0, Math.round(estimate)));
  const status: Status = progress > 0 && task.status === 'todo' ? 'doing' : task.status;
  return progress === task.progress && status === task.status ? null : { status, progress };
}

/** Empreinte courte du texte : un même contenu ne coûte jamais deux estimations. */
function signature(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

const seen = {
  get: (id: string) => { try { return localStorage.getItem(LS_SEEN + id); } catch { return null; } },
  set: (id: string, value: string) => { try { localStorage.setItem(LS_SEEN + id, value); } catch { /* sans stockage : une estimation par ouverture */ } },
};

/** Estimation IA, appel automatique : deux modèles au plus, dans le tiers du plafond réservé au fond. */
export async function estimateTaskProgress(title: string, note: string): Promise<number | null> {
  const reply = await postChatCompletions({ ...readAiSettings(), background: true }, 'l’avancement automatique', SYSTEM,
    `Tâche : ${truncate(title, 200)}\nNote :\n${truncate(note, MAX_NOTE)}`, 256, AI_TIMEOUT_MS, { effort: 'minimal' });
  const value = /"progress"\s*:\s*(null|\d{1,3})/.exec(reply)?.[1];
  const estimate = value && value !== 'null' ? Number(value) : null;
  return estimate !== null && estimate <= 100 ? estimate : null;
}

/**
 * Nouvel avancement d'après la note, ou null. Rien ne se passe tant que le texte n'a pas changé :
 * un réglage à la main tient jusqu'à la prochaine modification. Les cases cochées font foi, sans IA ;
 * sinon l'IA estime, si elle est configurée, si le texte dit quelque chose et si le plafond le permet.
 */
export async function refreshTaskProgress(task: TaskProgress, title: string, note: string): Promise<{ status: Status; progress: number } | null> {
  if (task.status === 'done') return null;
  const mark = signature(`${title}\n${note}`);
  if (seen.get(task.id) === mark) return null;
  const checked = checklistProgress(note);
  if (checked !== null) {
    seen.set(task.id, mark);
    return autoTaskState(task, checked);
  }
  if (!readAiSettings().key.trim() || note.replace(/\s+/g, ' ').trim().length < MIN_TEXT || aiBudgetRefusal(true)) return null;
  seen.set(task.id, mark);
  const estimate = await estimateTaskProgress(title, note).catch(() => null);
  return estimate === null ? null : autoTaskState(task, estimate);
}
