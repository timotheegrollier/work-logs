import { useState } from 'react';
import type { Project } from '../lib';
import { readProjectAiBrief, saveProjectAiBrief } from '../ai-context';
import {
  AI_CUSTOM_MODEL,
  AI_MODELS,
  DEFAULT_AI_ENDPOINT,
  DEFAULT_AI_MODEL,
  readAiSettings,
  saveAiSettings,
  testAiConnection,
  type AiSettings as AiSettingsValues,
} from '../ai-suggest';

type Probe = { state: 'idle' } | { state: 'testing' } | { state: 'ok'; ms: number } | { state: 'error'; message: string };

/**
 * Réglages IA du dialogue Paramètres : endpoint compatible OpenAI, modèle en
 * liste (options testées pour de vrai + saisie libre) avec bouton de diagnostic,
 * et clé personnelle (gratuite : Google AI Studio). Sauvegarde immédiate sur
 * l'appareil, comme les largeurs de colonnes. Aucun appel n'est fait ici,
 * sauf « Tester ».
 */
export function AiSettings({ projects = [] }: { projects?: Pick<Project, 'id' | 'name'>[] }) {
  const [form, setForm] = useState<AiSettingsValues>(readAiSettings);
  const [briefProject, setBriefProject] = useState('');
  const [projectBrief, setProjectBrief] = useState(() => readProjectAiBrief(null));
  const knownModel = AI_MODELS.some((option) => option.id === form.model);
  const [customModel, setCustomModel] = useState(knownModel ? '' : form.model);
  const [probe, setProbe] = useState<Probe>({ state: 'idle' });
  const setText =
    (field: 'endpoint' | 'key' | 'profile') =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const next = { ...form, [field]: event.target.value };
      setForm(next);
      saveAiSettings(next);
    };
  const selectModel = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const next = { ...form, model: event.target.value === AI_CUSTOM_MODEL ? customModel : event.target.value };
    setForm(next);
    saveAiSettings(next);
  };
  const editCustomModel = (event: React.ChangeEvent<HTMLInputElement>) => {
    setCustomModel(event.target.value);
    const next = { ...form, model: event.target.value };
    setForm(next);
    saveAiSettings(next);
  };
  const resetGemini = () => {
    const next = { ...form, endpoint: DEFAULT_AI_ENDPOINT, model: DEFAULT_AI_MODEL };
    setForm(next);
    setCustomModel('');
    setProbe({ state: 'idle' });
    saveAiSettings(next);
  };
  const testModel = async () => {
    setProbe({ state: 'testing' });
    try {
      const ms = await testAiConnection(form);
      setProbe({ state: 'ok', ms });
    } catch (error) {
      setProbe({ state: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <section className="ai-settings" aria-label="IA — suggestions de sous-tâches">
      <h3>Assistance IA</h3>
      <p className="ai-hint">
        Clé gratuite : Google AI Studio. Gardée sur cet appareil uniquement. Chaque clic
        d’assistance envoie le titre, ton profil et le contexte (projet, consignes,
        documents locaux sélectionnés, tâches voisines, contenu de l’entrée,
        noms des pièces jointes, vocabulaire) au service
        configuré, jamais automatiquement. Dans le dossier partagé, « ✨ Suggérer une
        procédure » et « ✨ Mettre en page » envoient le nom, le dossier et le contenu
        du fichier ouvert.
      </p>
      <label>
        Mon contexte de travail
        <textarea
          aria-label="Mon contexte de travail"
          rows={3}
          placeholder="Ex. développeur solo dans une pisciculture : suivi des bassins, devis, maintenance…"
          value={form.profile}
          onChange={setText('profile')}
        />
      </label>
      <label>
        Projet du contexte IA
        <select aria-label="Projet du contexte IA" value={briefProject} onChange={(event) => {
          setBriefProject(event.target.value);
          setProjectBrief(readProjectAiBrief(event.target.value || null));
        }}>
          <option value="">Sans projet</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>
      <label>
        Contexte IA du projet
        <textarea
          aria-label="Contexte IA du projet"
          rows={3}
          maxLength={2000}
          placeholder="Objectif, environnement, contraintes et termes propres à ce projet…"
          value={projectBrief}
          onChange={(event) => {
            setProjectBrief(event.target.value);
            saveProjectAiBrief(briefProject || null, event.target.value);
          }}
        />
      </label>
      <p className="ai-hint">Facultatif, enregistré sur cet appareil uniquement. Ces consignes accompagnent les actions IA de ce projet.</p>
      <label>
        Endpoint IA
        <input aria-label="Endpoint IA" value={form.endpoint} onChange={setText('endpoint')} inputMode="url" autoComplete="off" spellCheck={false} />
      </label>
      <label>
        Modèle IA
        <select aria-label="Modèle IA" value={knownModel ? form.model : AI_CUSTOM_MODEL} onChange={selectModel}>
          {AI_MODELS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
          <option value={AI_CUSTOM_MODEL}>Personnalisé…</option>
        </select>
      </label>
      {!knownModel && (
        <label>
          Modèle personnalisé
          <input aria-label="Modèle personnalisé" value={customModel} onChange={editCustomModel} autoComplete="off" spellCheck={false} />
        </label>
      )}
      <label>
        Clé IA
        <input aria-label="Clé IA" type="password" value={form.key} onChange={setText('key')} autoComplete="off" />
      </label>
      <div>
        <button type="button" onClick={testModel} disabled={probe.state === 'testing'}>
          Tester le modèle
        </button>
        <button className="ghost" type="button" onClick={resetGemini}>
          Valeurs Gemini gratuites
        </button>
      </div>
      {probe.state === 'testing' && <p role="status">Test en cours…</p>}
      {probe.state === 'ok' && <p role="status">✓ Modèle OK ({(probe.ms / 1000).toFixed(1)} s)</p>}
      {probe.state === 'error' && <p role="alert">{probe.message}</p>}
    </section>
  );
}
