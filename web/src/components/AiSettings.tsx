import { useState } from 'react';
import {
  DEFAULT_AI_ENDPOINT,
  DEFAULT_AI_MODEL,
  readAiSettings,
  saveAiSettings,
  type AiSettings as AiSettingsValues,
} from '../ai-suggest';

/**
 * Réglages IA du dialogue Paramètres : endpoint compatible OpenAI, modèle et
 * clé personnelle (gratuite : Google AI Studio). Sauvegarde immédiate sur
 * l'appareil, comme les largeurs de colonnes. Aucun appel n'est fait ici.
 */
export function AiSettings() {
  const [form, setForm] = useState<AiSettingsValues>(readAiSettings);
  const set =
    (field: 'endpoint' | 'model' | 'key') => (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = { ...form, [field]: event.target.value };
      setForm(next);
      saveAiSettings(next);
    };
  const resetGemini = () => {
    const next = { ...form, endpoint: DEFAULT_AI_ENDPOINT, model: DEFAULT_AI_MODEL };
    setForm(next);
    saveAiSettings(next);
  };

  return (
    <section className="ai-settings" aria-label="IA — suggestions de sous-tâches">
      <h3>IA — suggestions de sous-tâches</h3>
      <p className="ai-hint">
        Clé gratuite : Google AI Studio. Gardée sur cet appareil uniquement. Chaque clic
        « ✨ Suggérer » envoie le seul titre au service configuré, jamais automatiquement.
      </p>
      <label>
        Endpoint IA
        <input aria-label="Endpoint IA" value={form.endpoint} onChange={set('endpoint')} inputMode="url" autoComplete="off" spellCheck={false} />
      </label>
      <label>
        Modèle IA
        <input aria-label="Modèle IA" value={form.model} onChange={set('model')} autoComplete="off" spellCheck={false} />
      </label>
      <label>
        Clé IA
        <input aria-label="Clé IA" type="password" value={form.key} onChange={set('key')} autoComplete="off" />
      </label>
      <div>
        <button className="ghost" type="button" onClick={resetGemini}>
          Valeurs Gemini gratuites
        </button>
      </div>
    </section>
  );
}
