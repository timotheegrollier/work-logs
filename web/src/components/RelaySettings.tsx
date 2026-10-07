import { useState } from 'react';
import { api } from '../lib';
import { normalizeRelayUrl, readRelay, saveRelay } from '../relay-settings';

/**
 * PWA › Paramètres › Dossier partagé du TSE : l'adresse du relais (la VM du
 * bureau, jointe par Tailscale) et son code d'accès, donnés à l'installation du
 * relais. Enregistrer vérifie aussitôt que le relais répond.
 */
export function RelaySettings({ onChange }: { onChange: () => void }) {
  const saved = readRelay();
  const [url, setUrl] = useState(saved?.url ?? '');
  const [token, setToken] = useState(saved?.token ?? '');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setMessage('');
    let address: string;
    try {
      address = normalizeRelayUrl(url);
    } catch (e) {
      setMessage((e as Error).message);
      return;
    }
    if (token.trim().length < 32) {
      setMessage('Code d’accès incomplet : copie-le en entier.');
      return;
    }
    setBusy(true);
    saveRelay({ url: address, token: token.trim() });
    setUrl(address);
    try {
      const status = await api.sharedStatus();
      setMessage(status.relayError
        ? `Enregistré, mais le relais ne répond pas : ${status.relayError} Tailscale est-il allumé sur ce téléphone ?`
        : `Relié au dossier partagé (${status.label || 'relais'}).`);
    } finally {
      setBusy(false);
      onChange();
    }
  };

  const forget = () => {
    saveRelay(null);
    setUrl('');
    setToken('');
    setMessage('Relais oublié sur ce téléphone.');
    onChange();
  };

  return (
    <section className="display-settings" aria-label="Dossier partagé du TSE">
      <h3>Dossier partagé du TSE</h3>
      <p className="ai-hint">
        Les procédures du serveur, par le relais du bureau (joint par Tailscale). L’adresse et le code
        sont donnés à l’installation du relais ; ils restent sur ce téléphone.
      </p>
      <label className="relay-field">
        Adresse du relais
        <input aria-label="Adresse du relais" placeholder="https://relais.exemple.ts.net" value={url} spellCheck={false} autoComplete="off" onChange={(event) => setUrl(event.target.value)} />
      </label>
      <label className="relay-field">
        Code d’accès
        <input aria-label="Code d’accès du relais" type="password" value={token} spellCheck={false} autoComplete="off" onChange={(event) => setToken(event.target.value)} />
      </label>
      <div className="shared-project-link">
        <button className="task-primary" type="button" disabled={busy || !url.trim() || !token.trim()} onClick={() => void save()}>Enregistrer</button>
        {saved && <button className="ghost" type="button" disabled={busy} onClick={forget}>Oublier ce relais</button>}
      </div>
      {message && <p className="ai-hint" role="status">{message}</p>}
    </section>
  );
}
