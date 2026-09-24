import { useState } from 'react';
import { dayLabel, groupByDay, groupTabs, plainText, todayISO, type EntrySummary, type JournalItem, type Project } from '../lib';

export function EntryList({
  entries,
  projects,
  selectedId,
  onSelect,
  onCreate,
  onCreateDocument,
  searching,
}: {
  entries: EntrySummary[];
  projects: Project[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onCreateDocument: () => void;
  searching: boolean;
}) {
  // Archiver = masquer du journal sans rien détruire : les documents archivés
  // (locaux comme Google) restent ouvrables et restaurables depuis ci-dessous.
  const active = entries.filter((entry) => !entry.archived);
  const archived = entries.filter((entry) => entry.archived);
  // Les lignes archivées ne sont montées qu'une fois le dépliant ouvert :
  // le journal reste léger et les assertions « masqué » portent sur le DOM.
  const [archivesOpen, setArchivesOpen] = useState(false);
  const colors = new Map(projects.map((p) => [p.id, p.color]));

  return (
    <section className="journal" aria-label="Journal">
      <button className="new-entry" onClick={onCreate}>
        <span aria-hidden="true">＋</span> Nouvelle entrée
      </button>
      <button className="ghost new-document" onClick={onCreateDocument}>＋ Nouveau document</button>

      {active.length === 0 && (
        <p className="empty">
          {searching ? 'Aucune entrée ne correspond.' : 'Rien encore. Écris la première.'}
        </p>
      )}

      <DayGroups items={groupTabs(active)} colors={colors} selectedId={selectedId} onSelect={onSelect} />

      {archived.length > 0 && (
        <details className="archives" open={archivesOpen} onToggle={(e) => setArchivesOpen(e.currentTarget.open)}>
          <summary>
            Archives <span className="count" title={`${archived.length} document${archived.length > 1 ? 's' : ''} archivé${archived.length > 1 ? 's' : ''}`}>{archived.length}</span>
          </summary>
          {archivesOpen && (
            <DayGroups items={groupTabs(archived)} colors={colors} selectedId={selectedId} onSelect={onSelect} dimmed />
          )}
        </details>
      )}
    </section>
  );
}

function DayGroups({
  items,
  colors,
  selectedId,
  onSelect,
  dimmed = false,
}: {
  items: JournalItem[];
  colors: Map<string, string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  dimmed?: boolean;
}) {
  return (
    <ol className="days">
      {groupByDay(items.map(item => item.entry)).map(([date, ofDay]) => (
        <li key={date} className={date === todayISO() ? 'is-today' : undefined}>
          <h2 className="day">{dayLabel(date)}</h2>
          <ul>
            {ofDay.map(representative => items.find(item => item.entry.id === representative.id)!).map(({ entry, title, tabs }) => (
              <li key={entry.id}>
                <button
                  className={'entry' + (tabs.some((t) => t.id === selectedId) || entry.id === selectedId ? ' is-selected' : '') + (dimmed ? ' is-archived' : '')}
                  aria-current={entry.id === selectedId || tabs.some(t => t.id === selectedId) ? 'true' : undefined}
                  onClick={() => onSelect(tabs.find(t => t.id === selectedId)?.id || entry.id)}
                >
                  <span className="entry-title">
                    {entry.project_id && (
                      <span
                        className="dot"
                        style={{ background: colors.get(entry.project_id) }}
                        aria-hidden="true"
                      />
                    )}
                    {title}
                    {/* Un document Google compte pour une ligne, quel que soit
                        son nombre d'onglets : ils s'ouvrent dans l'éditeur. */}
                    {tabs.length > 1 && (
                      <span className="count" title={`${tabs.length} onglets`}>{tabs.length}</span>
                    )}
                  </span>
                  <span className="entry-excerpt">
                    {plainText(entry.excerpt) || 'Vide'}
                    {entry.attachments > 0 && (
                      <span className="clip" title={`${entry.attachments} fichier(s)`}>
                        {' '}📎 {entry.attachments}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}
