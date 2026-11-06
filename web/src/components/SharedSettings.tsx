import { useEffect, useState } from 'react';
import { api, type SharedStatus } from '../lib';

/**
 * Paramètres › Dossier partagé : le nom que voient les collègues dans nos verrous
 * (LibreOffice affiche « Document en cours d'utilisation par … »). Absent de la PWA.
 */
export function SharedSettings() {
  const [status, setStatus] = useState<SharedStatus | null>(null);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let alive = true;
    api.sharedStatus().then((next) => {
      if (!alive) return;
      setStatus(next);
      setName(next.displayName ?? '');
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!status?.available) return null;

  const save = async () => {
    setMessage('');
    try {
      const next = await api.setSharedDisplayName(name);
      setStatus(next);
      setName(next.displayName ?? '');
      setMessage('Enregistré.');
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  return (
    <section className="display-settings" aria-label="Dossier partagé">
      <h3>Dossier partagé</h3>
      <p className="ai-hint">
        {status.root ? <>Dossier : <strong>{status.root}</strong>. </> : 'Aucun dossier choisi (colonne Procédures). '}
        Ce nom apparaît chez les collègues quand tu modifies un fichier (verrou lu par LibreOffice et WorkLogs).
      </p>
      <form className="shared-name" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label>
          Nom affiché dans les verrous
          <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
        </label>
        <button className="ghost" type="submit">Enregistrer</button>
      </form>
      {message && <p className="ai-hint" role="status">{message}</p>}
    </section>
  );
}
