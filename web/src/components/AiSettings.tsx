import { useEffect, useRef, useState } from 'react';
import type { Project } from '../lib';
import { MAX_DAILY_REQUESTS, MIN_DAILY_REQUESTS, aiUsageLabel, readDailyLimit, saveDailyLimit } from '../ai-budget';
import { readDeviceAiStatus, prepareDeviceAi, type DeviceStatus } from '../ai-device';
import { readProjectAiBrief, saveProjectAiBrief } from '../ai-context';
import { AiQuotas } from './AiQuotas';
import {
  AI_CUSTOM_MODEL,
  AI_MODELS,
  DEFAULT_AI_ENDPOINT,
  DEFAULT_AI_MODEL,
  GEMINI_AI_ENDPOINT,
  GEMINI_DEFAULT_MODEL,
  OPENROUTER_AI_ENDPOINT,
  MAX_AI_PROFILE,
  aiDailyDefault,
  isAnonymousAi,
  isFreeAi,
  isGoogleAiEndpoint,
  readGoogleAiConsent,
  readAiSettings,
  saveGoogleAiConsent,
  saveAiSettings,
  testAiConnection,
  type AiSettings as AiSettingsValues,
} from '../ai-suggest';

type Probe = { state: 'idle' } | { state: 'testing' } | { state: 'ok'; ms: number } | { state: 'error'; message: string };

function endpointOrigin(endpoint: string): string | null {
  try {
    const url = new URL(endpoint.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** Réglages enregistrés sur l’appareil. Seul « Tester la connexion » appelle le service IA. */
export function AiSettings({ projects = [], projectId = null }: { projects?: Pick<Project, 'id' | 'name'>[]; projectId?: string | null }) {
  const initialProject = projects.some((project) => project.id === projectId) ? projectId ?? '' : '';
  const [form, setForm] = useState<AiSettingsValues>(readAiSettings);
  const [briefProject, setBriefProject] = useState(initialProject);
  const [projectBrief, setProjectBrief] = useState(() => readProjectAiBrief(initialProject || null));
  const anonymous = isAnonymousAi(form);
  const google = isGoogleAiEndpoint(form.endpoint);
  const models = google ? AI_MODELS.filter((option) => option.id.startsWith('gemini-')) : [];
  const knownModel = models.some((option) => option.id === form.model);
  const modelLabel = models.find((option) => option.id === form.model)?.label.split(' — ')[0] || form.model || 'À renseigner';
  const [customModel, setCustomModel] = useState(knownModel ? '' : form.model);
  // Le texte saisi reste libre le temps de la frappe : « 2 » en route vers « 200 » n'est pas ramené à 10.
  const [dailyLimit, setDailyLimit] = useState<string | null>(null);
  const defaultDailyLimit = aiDailyDefault(form);
  const free = isFreeAi(form);
  const origin = endpointOrigin(form.endpoint);
  const openRouter = origin === endpointOrigin(OPENROUTER_AI_ENDPOINT);
  const [googleConsent, setGoogleConsent] = useState(readGoogleAiConsent);
  const [probe, setProbe] = useState<Probe>({ state: 'idle' });
  const [device, setDevice] = useState<DeviceStatus>({ state: 'unsupported' });
  const [preparing, setPreparing] = useState(false);
  const probeVersion = useRef(0);
  useEffect(() => {
    let alive = true;
    void readDeviceAiStatus().then((status) => { if (alive) setDevice(status); });
    return () => { alive = false; };
  }, []);
  const prepareDevice = async () => {
    setPreparing(true);
    setDevice(await prepareDeviceAi());
    setPreparing(false);
  };
  const invalidateProbe = () => {
    probeVersion.current += 1;
    setProbe({ state: 'idle' });
  };
  const setText =
    (field: 'endpoint' | 'key' | 'profile') =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = event.target.value;
      const next = { ...form, [field]: value };
      if (field === 'endpoint') {
        if (!origin || endpointOrigin(value) !== origin) next.key = '';
        if (isAnonymousAi(next)) {
          next.key = '';
          next.model = DEFAULT_AI_MODEL;
        } else if (!google && isGoogleAiEndpoint(value)) {
          next.model = GEMINI_DEFAULT_MODEL;
          setCustomModel('');
        }
      }
      if (field !== 'profile') invalidateProbe();
      setForm(next);
      saveAiSettings(next);
    };
  const selectModel = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const next = { ...form, model: event.target.value === AI_CUSTOM_MODEL ? customModel : event.target.value };
    invalidateProbe();
    setForm(next);
    saveAiSettings(next);
  };
  const editCustomModel = (event: React.ChangeEvent<HTMLInputElement>) => {
    setCustomModel(event.target.value);
    const next = { ...form, model: event.target.value };
    invalidateProbe();
    setForm(next);
    saveAiSettings(next);
  };
  // Gemini en un clic, comme demandé : une clé d'un autre service ne part jamais chez Google.
  const useGemini = () => {
    const next = { ...form, endpoint: GEMINI_AI_ENDPOINT, model: GEMINI_DEFAULT_MODEL, key: '' };
    setForm(next);
    setCustomModel('');
    invalidateProbe();
    saveAiSettings(next);
  };
  const resetFree = () => {
    const next = { ...form, endpoint: DEFAULT_AI_ENDPOINT, model: DEFAULT_AI_MODEL, key: '' };
    setForm(next);
    setCustomModel('');
    invalidateProbe();
    saveAiSettings(next);
  };
  const testModel = async () => {
    const version = ++probeVersion.current;
    setProbe({ state: 'testing' });
    try {
      const ms = await testAiConnection(form);
      if (version === probeVersion.current) setProbe({ state: 'ok', ms });
    } catch (error) {
      if (version === probeVersion.current) setProbe({ state: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <section className="ai-settings" aria-label="Assistance IA">
      <h3>Assistance IA</h3>
      {anonymous && <>
        <p className="ai-hint"><b>IA gratuite sans clé.</b> Aucun compte ni abonnement. Les demandes passent par le Worker WorkLogs : Groq, puis Gemini chez Google, puis Gemma 4 chez Cloudflare, le suivant prenant le relais quand un quota est atteint. Sur son palier gratuit, Google peut utiliser les demandes pour améliorer ses produits : n’y mets pas de données sensibles.</p>
        <AiQuotas />
      </>}
      {(device.state === 'available' || device.state === 'downloadable' || device.state === 'downloading') && <div className={'ai-device-status is-' + device.state}>
        {device.state === 'available' && <p><b>✓ IA intégrée prête.</b> Elle peut répondre aux demandes de texte sur cet appareil.</p>}
        {device.state === 'downloadable' && <>
          <p><b>IA intégrée disponible.</b> Le navigateur peut télécharger son modèle une fois : ensuite, l’assistance marche sans clé et sur l’appareil.</p>
          <button className="ghost" type="button" disabled={preparing} onClick={() => void prepareDevice()}>
            {preparing ? 'Préparation…' : 'Préparer l’IA gratuite'}
          </button>
        </>}
        {device.state === 'downloading' && <p><b>Téléchargement du modèle en cours</b> par le navigateur.</p>}
      </div>}
      <div>
        <button type="button" onClick={testModel} disabled={probe.state === 'testing'}>
          Tester la connexion
        </button>
      </div>
      {probe.state === 'idle' && <p role="status">{anonymous || form.key.trim()
        ? 'Connexion non testée.'
        : device.state === 'available'
          ? 'Sans clé : l’IA intégrée de cet appareil répond.'
          : 'Sans clé : recherche locale, aucune dépense.'}</p>}
      {probe.state === 'testing' && <p role="status">Test en cours…</p>}
      {probe.state === 'ok' && <p role="status">✓ Connexion vérifiée ({(probe.ms / 1000).toFixed(1)} s)</p>}
      {probe.state === 'error' && <p role="alert">{probe.message}</p>}
      {!anonymous && <p className="ai-hint">Modèle choisi : {form.key.trim()
        ? modelLabel
        : device.state === 'available'
          ? 'IA intégrée de l’appareil (sans clé)'
          : 'recherche locale, sans service externe'}</p>}
      <p className="ai-hint">{aiUsageLabel(defaultDailyLimit)}</p>
      <label>
        Mon contexte de travail
        <textarea
          aria-label="Mon contexte de travail"
          rows={3}
          placeholder="Ex. développeur solo dans une pisciculture : suivi des bassins, devis, maintenance…"
          maxLength={MAX_AI_PROFILE}
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
      <p className="ai-hint">
        Chaque clic d’assistance envoie le titre, ton profil et le contexte (projet, consignes,
        documents locaux sélectionnés, tâches voisines, contenu de l’entrée,
        noms des pièces jointes, vocabulaire) au service configuré. Sans clic, seuls les
        éléments ajoutés au suivi IA envoient leur texte enregistré, après une pause.
        Dans le dossier partagé, « ✨ IA › Compléter » et « Mettre en page » envoient le nom,
        le dossier et le contenu du fichier ouvert.
      </p>
      <details className="ai-advanced-settings">
        <summary>Réglages avancés</summary>
        <label>
          Endpoint IA
          <input aria-label="Endpoint IA" value={form.endpoint} onChange={setText('endpoint')} inputMode="url" autoComplete="off" spellCheck={false} />
        </label>
        {!anonymous && <>
          <label>
            Clé d’un service externe <span className="ai-hint">(facultative)</span>
            <input aria-label="Clé IA" type="password" value={form.key} onChange={setText('key')} autoComplete="off" />
          </label>
          <p className="ai-hint">
            {form.key.trim() && 'Clé enregistrée sur cet appareil uniquement. '}
            {google && <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">Créer une clé Gemini dans Google AI Studio</a>}
            {openRouter && <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">Créer une clé OpenRouter</a>}
          </p>
          {models.length > 0 && <label>
            Modèle IA
            <select aria-label="Modèle IA" value={knownModel ? form.model : AI_CUSTOM_MODEL} onChange={selectModel}>
              {models.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              <option value={AI_CUSTOM_MODEL}>Personnalisé…</option>
            </select>
          </label>}
          {!knownModel && <label>
            Modèle personnalisé
            <input aria-label="Modèle personnalisé" value={form.model} onChange={editCustomModel} autoComplete="off" spellCheck={false} />
          </label>}
          {google && <div className="notice">
            <p><b>Avant d’utiliser Gemini :</b> avec le palier gratuit, Google peut utiliser les requêtes et réponses pour améliorer ses produits et les faire examiner. N’y envoie pas de données personnelles, confidentielles ou sensibles. Quotas et conditions peuvent changer ; ne configure pas la facturation si tu veux éviter tout coût.</p>
            <p>La clé est stockée dans ce navigateur, mais les appels partent directement de l’application vers Google : elle reste visible côté navigateur. Google déconseille cette méthode pour une application web publique en production. Réserve-la à un usage personnel et, si possible, restreins la clé à l’API et aux sites autorisés dans Google Cloud.</p>
            <label>
              <input
                aria-label="Accepter l’envoi à Google"
                type="checkbox"
                checked={googleConsent}
                onChange={(event) => {
                  setGoogleConsent(event.target.checked);
                  saveGoogleAiConsent(event.target.checked);
                  invalidateProbe();
                }}
              />
              J’ai compris les conditions de confidentialité et le risque lié à une clé dans le navigateur ; j’autorise l’envoi de mes demandes à Google.
            </label>
          </div>}
          {free && google && <p className="ai-hint">Ce modèle est proposé au palier gratuit de Google, sous réserve des quotas et conditions en vigueur. Aucun modèle payant n’est utilisé en secours.</p>}
          {!free && <p className="notice">Avec ce modèle ou ce service, WorkLogs ne peut pas garantir la gratuité : vérifie ses tarifs.</p>}
        </>}
        <label>
          Plafond de requêtes IA par jour
          <input
            aria-label="Plafond de requêtes IA par jour"
            type="number"
            inputMode="numeric"
            min={MIN_DAILY_REQUESTS}
            max={MAX_DAILY_REQUESTS}
            step={1}
            value={dailyLimit ?? readDailyLimit(defaultDailyLimit)}
            onChange={(event) => {
              setDailyLimit(event.target.value);
              if (event.target.value) saveDailyLimit(Number(event.target.value));
            }}
            onBlur={() => setDailyLimit(null)}
          />
        </label>
        <p className="ai-hint">
          Le compteur porte sur cet appareil. Le service peut atteindre son propre quota avant ce plafond.
        </p>
        <div>
          {!google && <button className="ghost" type="button" onClick={useGemini}>
            Utiliser Gemini avec ma clé gratuite
          </button>}
          <button className="ghost" type="button" onClick={resetFree}>
            Restaurer les réglages gratuits
          </button>
        </div>
      </details>
    </section>
  );
}
