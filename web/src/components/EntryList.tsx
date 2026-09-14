import { dayLabel, groupByDay, plainText, type EntrySummary, type Project } from '../lib';

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
  const colors = new Map(projects.map((p) => [p.id, p.color]));

  return (
    <section className="journal" aria-label="Journal">
      <button className="new-entry" onClick={onCreate}>
        <span aria-hidden="true">＋</span> Nouvelle entrée
      </button>
      <button className="new-document" onClick={onCreateDocument}>＋ Nouveau document</button>

      {entries.length === 0 && (
        <p className="empty">
          {searching ? 'Aucune entrée ne correspond.' : 'Rien encore. Écris la première.'}
        </p>
      )}

      <ol className="days">
        {groupByDay(entries).map(([date, ofDay]) => (
          <li key={date}>
            <h2 className="day">{dayLabel(date)}</h2>
            <ul>
              {ofDay.map((entry) => (
                <li key={entry.id}>
                  <button
                    className={'entry' + (entry.id === selectedId ? ' is-selected' : '')}
                    aria-current={entry.id === selectedId ? 'true' : undefined}
                    onClick={() => onSelect(entry.id)}
                  >
                    <span className="entry-title">
                      {entry.project_id && (
                        <span
                          className="dot"
                          style={{ background: colors.get(entry.project_id) }}
                          aria-hidden="true"
                        />
                      )}
                      {entry.title}
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
    </section>
  );
}
