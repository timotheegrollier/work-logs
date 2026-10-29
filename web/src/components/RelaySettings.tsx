import { useState } from 'react';
import { api } from '../lib';
import { normalizeRelayUrl, readRelay, saveRelay } from '../relay-settings';
import { syncRelayVault } from '../store/relay-drive';
import { checkRelayAgain } from '../store/sync-web';

/** La copie du compte Google suit ce téléphone ; ce qu'on en dit à la suite du message. */
async function followInGoogle(forgotten: boolean): Promise<string> {
  try {
    const result = await syncRelayVault();
    if (result === 'unavailable') return forgotten ? '' : 'Il reste sur ce téléphone seulement : connecte ton compte Google pour le retrouver tout seul.';
    if (forgotten) return result === 'removed' ? 'Retiré aussi du compte Google.' : '';
    return 'Adresse gardée dans ton compte Google : elle revient toute seule à la connexion.';
  } catch {
    checkRelayAgain();
    return forgotten
      ? 'La copie du compte Google sera retirée à la prochaine synchronisation.'
      : 'Copie dans le compte Google impossible pour l’instant : nouvel essai à la prochaine synchronisation.';
  }
}

/**
 * PWA › Paramètres › Dossier partagé du TSE : l'adresse du relais (la VM du
 * bureau, jointe par Tailscale), donnée à l'installation du relais. Pas de code :
 * le réseau Tailscale suffit (§55). Enregistrer vérifie aussitôt que le relais répond.
 */
export function RelaySettings({ onChange }: { onChange: () => void }) {
  const saved = readRelay();
  const [url, setUrl] = useState(saved?.url ?? '');
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
    setBusy(true);
    saveRelay({ url: address });
    setUrl(address);
    try {
      const status = await api.sharedStatus();
      const relay = status.relayError
        ? `Enregistré, mais le relais ne répond pas : ${status.relayError} Tailscale est-il allumé sur ce téléphone ?`
        : `Relié au dossier partagé (${status.label || 'relais'}).`;
      setMessage(relay);
      const google = await followInGoogle(false);
      if (google) setMessage(`${relay} ${google}`);
    } finally {
      setBusy(false);
      onChange();
    }
  };

  const forget = async () => {
    saveRelay(null);
    setUrl('');
    setMessage('Relais oublié sur ce téléphone.');
    onChange();
    setBusy(true);
    try {
      const google = await followInGoogle(true);
      if (google) setMessage(`Relais oublié sur ce téléphone. ${google}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="display-settings" aria-label="Dossier partagé du TSE">
      <h3>Dossier partagé du TSE</h3>
      <p className="ai-hint">
        Les procédures du serveur, par le relais du bureau, joint par Tailscale : pas de code, il suffit
        que Tailscale soit allumé. L’adresse est gardée sur ce téléphone et dans ton compte Google : elle
        revient toute seule à la connexion.
      </p>
      <label className="relay-field">
        Adresse du relais
        <input aria-label="Adresse du relais" placeholder="https://relais.exemple.ts.net" value={url} spellCheck={false} autoComplete="off" onChange={(event) => setUrl(event.target.value)} />
      </label>
      <div className="shared-project-link">
        <button className="task-primary" type="button" disabled={busy || !url.trim()} onClick={() => void save()}>Enregistrer</button>
        {saved && <button className="ghost" type="button" disabled={busy} onClick={() => void forget()}>Oublier ce relais</button>}
      </div>
      {message && <p className="ai-hint" role="status">{message}</p>}
    </section>
  );
}
