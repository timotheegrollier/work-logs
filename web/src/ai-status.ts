import { WORKLOGS_AI_ENDPOINT } from './lib';

/** Modèles et quotas de l'IA gratuite, comptés par le Worker WorkLogs pour tous les appareils (§98). */
export type AiLimitKind = 'requests_per_day' | 'requests_per_minute' | 'tokens_per_day' | 'tokens_per_minute';

export interface AiEngineStatus {
  id: string;
  provider: 'groq' | 'google' | 'cloudflare';
  label: string;
  version: string | null;
  resolved: string | null;
  today: { requests: number; input_tokens: number; output_tokens: number };
  last_minute: number;
  limits: Partial<Record<AiLimitKind, { value: number; learned_at: string | null }>>;
  neurons?: { used: number; limit: number };
  reset_at: string | null;
  blocked_until: string | null;
  blocked_reason: string | null;
  last_used_at: string | null;
  last_error: { at: string | null; reason: string } | null;
}

export interface AiStatus {
  updated_at: string;
  gemini_configured: boolean;
  /** Fournisseurs dont la clé n'est pas encore posée sur le Worker (§100). */
  missing_providers?: string[];
  catalog_checked_at: string | null;
  models: AiEngineStatus[];
}

export async function readAiStatus(signal?: AbortSignal): Promise<AiStatus> {
  const res = await fetch(`${WORKLOGS_AI_ENDPOINT}/status`, { credentials: 'omit', redirect: 'error', signal });
  if (!res.ok) throw new Error('État de l’IA indisponible.');
  const value = await res.json() as Partial<AiStatus> | null;
  if (!value || !Array.isArray(value.models)) throw new Error('État de l’IA illisible.');
  return value as AiStatus;
}

/** Après chaque réponse du Worker : le tableau des quotas se relit, l'assistant nomme le modèle. */
export const AI_USED_EVENT = 'worklogs:ai-used';

export function announceAiModel(model: string): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(AI_USED_EVENT, { detail: { model } }));
}

/** « gemini-3.8-flash » → « Gemini 3.8 Flash » ; « openai/gpt-oss-120b » → « GPT-OSS 120B »… */
export function aiModelName(id: string): string {
  if (/gemma-4-26b/.test(id)) return 'Gemma 4 26B';
  const oss = id.match(/gpt-oss-(\d+)b/);
  if (oss) return `GPT-OSS ${oss[1]}B`;
  const llama = id.match(/^llama-(\d+(?:\.\d+)*)-(\d+)b/);
  if (llama) return `Llama ${llama[1]} ${llama[2]}B`;
  if (!id.startsWith('gemini-')) return id;
  return id.split('-').map((part) => (/^\d/.test(part) ? part : part[0].toUpperCase() + part.slice(1))).join(' ').replace('Flash Lite', 'Flash-Lite');
}
