import { useState } from 'react';
import { COLUMNS, PRIORITIES, api, dayLabel, isOverdue, priorityLabel, type EntrySummary, type Priority, type Status, type Task } from '../lib';

const DRAG_TYPE = 'text/plain';

export function TaskBoard({
  tasks,
  entries,
  projectId,
  onOpenDocument,
  onChanged,
}: {
  tasks: Task[];
  entries: EntrySummary[];
  projectId: string;
  onOpenDocument: (entryId: string) => void;
  onChanged: () => void;
}) {
  const [title, setTitle] = useState('');
  const [over, setOver] = useState<Status | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const add = async () => {
    if (!title.trim()) return;
    await api.createTask({ title: title.trim(), project_id: projectId || null });
    setTitle('');
    onChanged();
  };

  const drop = async (event: React.DragEvent, status: Status, position: number) => {
    event.preventDefault();
    event.stopPropagation();
    setOver(null);
    const id = event.dataTransfer.getData(DRAG_TYPE);
    if (!id) return;
    await api.moveTask(id, status, position);
    onChanged();
  };

  return (
    <section className="board" aria-label="Tâches">
      <div className="quick">
        <input
          aria-label="Nouvelle tâche"
          placeholder="Nouvelle tâche…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button className="ghost" type="button" onClick={add} disabled={!title.trim()}>
          Ajouter
        </button>
      </div>

      {COLUMNS.map((column) => {
        const inColumn = tasks.filter((t) => t.status === column.id);
        return (
          <div
            key={column.id}
            className={'column' + (over === column.id ? ' is-over' : '')}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(column.id);
            }}
            onDragLeave={() => setOver((c) => (c === column.id ? null : c))}
            onDrop={(e) => drop(e, column.id, inColumn.length)}
          >
            <h2>
              {column.label} <span className="count">{inColumn.length}</span>
            </h2>
            <ul>
              {inColumn.map((task, index) => (
                <li key={task.id}>
                  <TaskCard
                    task={task}
                    entries={entries}
                    editing={editing === task.id}
                    onEdit={() => setEditing(task.id)}
                    onEditDone={() => setEditing(null)}
                    onOpenDocument={onOpenDocument}
                    onChanged={onChanged}
                    onDrop={(e) => drop(e, column.id, index)}
                  />
                </li>
              ))}
            </ul>
            {inColumn.length === 0 && <p className="empty-column">Déposer ici</p>}
          </div>
        );
      })}
    </section>
  );
}

function TaskCard({
  task,
  entries,
  editing,
  onEdit,
  onEditDone,
  onOpenDocument,
  onChanged,
  onDrop,
}: {
  task: Task;
  entries: EntrySummary[];
  editing: boolean;
  onEdit: () => void;
  onEditDone: () => void;
  onOpenDocument: (entryId: string) => void;
  onChanged: () => void;
  onDrop: (event: React.DragEvent) => void;
}) {
  const [form, setForm] = useState({ title: task.title, due_date: task.due_date ?? '', priority: (task.priority ?? 'normal') as Priority });
  const [linking, setLinking] = useState(false);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const linkedDocuments = task.documents ?? [];
  const linkedIds = new Set(linkedDocuments.map((document) => document.id));
  const availableDocuments = entries.filter((entry) => !linkedIds.has(entry.id));
  const query = filter.trim().toLowerCase();
  const visibleDocuments = query
    ? availableDocuments.filter((entry) => entry.title.toLowerCase().includes(query))
    : availableDocuments;
  const done = task.status === 'done';
  const late = isOverdue(task);

  const patch = async (body: Partial<Task>) => {
    await api.updateTask(task.id, body);
    onChanged();
  };

  const saveEdit = async () => {
    if (!form.title.trim()) return;
    onEditDone();
    await patch({ title: form.title.trim(), due_date: form.due_date || null, priority: form.priority });
  };

  const startLinking = () => {
    setFilter('');
    setSelected([]);
    setLinking(true);
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((candidate) => candidate !== id) : [...prev, id]));
  };

  const linkSelected = async () => {
    if (selected.length === 0 || busy) return;
    setBusy(true);
    try {
      await Promise.all(selected.map((id) => api.linkTaskDocument(task.id, id)));
      setLinking(false);
      setSelected([]);
      setFilter('');
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const unlinkDocument = async (entryId: string) => {
    await api.unlinkTaskDocument(task.id, entryId);
    onChanged();
  };

  const documentControls = (
    <div className="card-documents">
      {linkedDocuments.length > 0 && (
        <div className="task-documents" aria-label={`Documents liés à ${task.title}`}>
          <p className="task-documents-title" aria-hidden="true">
            <span>📎 {linkedDocuments.length} document{linkedDocuments.length > 1 ? 's' : ''}</span>
          </p>
          {linkedDocuments.map((document) => {
            const google = isGoogleDocument(document);
            return (
              <div className="task-document" key={document.id}>
                <span className={'task-document-icon' + (google ? ' is-google' : '')} aria-hidden="true">
                  {google ? 'G' : '📄'}
                </span>
                <button
                  className="task-document-open"
                  type="button"
                  aria-label={`Ouvrir ${document.title}`}
                  title={`${document.title} — ${dayLabel(document.entry_date)}`}
                  onClick={() => onOpenDocument(document.id)}
                >
                  <span className="task-document-title">{document.title}</span>
                  <span className="task-document-meta">
                    <span className="task-document-source">{google ? 'Google' : 'local'}</span>
                    {' · '}
                    {dayLabel(document.entry_date)}
                  </span>
                </button>
                <button
                  className="icon"
                  type="button"
                  aria-label={`Retirer ${document.title} de ${task.title}`}
                  title={`Retirer ${document.title}`}
                  onClick={() => void unlinkDocument(document.id)}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
      {linking ? (
        <div className="document-linker" aria-label={`Lier des documents à ${task.title}`}>
          <div className="document-linker-head">
            <strong>Lier des documents</strong>
            <span className="document-linker-count">
              {selected.length > 0 ? `${selected.length} sélectionné${selected.length > 1 ? 's' : ''}` : `${availableDocuments.length} disponible${availableDocuments.length > 1 ? 's' : ''}`}
            </span>
          </div>
          {availableDocuments.length > 0 && (
            <input
              type="search"
              aria-label={`Rechercher un document à lier à ${task.title}`}
              placeholder="Rechercher…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          )}
          {availableDocuments.length === 0 ? (
            <p className="empty">Tous les documents sont déjà liés.</p>
          ) : visibleDocuments.length === 0 ? (
            <p className="empty">Aucun document ne correspond à « {filter.trim()} ».</p>
          ) : (
            <ul className="document-picker">
              {visibleDocuments.map((entry) => {
                const checked = selected.includes(entry.id);
                const google = isGoogleDocument(entry);
                return (
                  <li key={entry.id}>
                    <label className={'picker-row' + (checked ? ' is-checked' : '')}>
                      <input
                        type="checkbox"
                        checked={checked}
                        aria-label={`Lier ${entry.title} à ${task.title}`}
                        onChange={() => toggleSelected(entry.id)}
                      />
                      <span className="picker-title">{entry.title}</span>
                      <span className={'picker-source' + (google ? ' is-google' : '')}>
                        {google ? 'Google' : 'local'}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="document-linker-actions">
            {visibleDocuments.length > 1 && (
              <>
                <button
                  className="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => setSelected(visibleDocuments.map((entry) => entry.id))}
                >
                  Tout sélectionner
                </button>
                <button className="ghost" type="button" disabled={busy || selected.length === 0} onClick={() => setSelected([])}>
                  Effacer
                </button>
              </>
            )}
          </div>
          <div className="card-actions">
            <button
              className="ghost primary"
              type="button"
              disabled={selected.length === 0 || busy}
              onClick={() => void linkSelected()}
            >
              {busy ? 'Liaison…' : selected.length > 0 ? `Relier la sélection (${selected.length})` : 'Relier la sélection'}
            </button>
            <button className="ghost" type="button" disabled={busy} onClick={() => setLinking(false)}>
              Annuler
            </button>
          </div>
        </div>
      ) : (
        <button className="link-document" type="button" onClick={startLinking}>
          ＋ Lier des documents
        </button>
      )}
    </div>
  );

  if (editing) {
    return (
      <div className="card is-editing">
        <input
          aria-label="Titre de la tâche"
          autoFocus
          value={form.title}
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void saveEdit();
            if (e.key === 'Escape') onEditDone();
          }}
        />
        <input
          type="date"
          aria-label="Échéance"
          value={form.due_date}
          onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value }))}
        />
        <label className="priority-field">
          Priorité
          <select
            aria-label="Priorité"
            value={form.priority}
            onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value as Priority }))}
          >
            {PRIORITIES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <div className="card-actions">
          <button className="ghost" type="button" onClick={() => void saveEdit()}>
            Enregistrer
          </button>
          <button className="ghost" type="button" onClick={onEditDone}>
            Annuler
          </button>
        </div>
        {documentControls}
      </div>
    );
  }

  return (
    <div
      className={'card' + (task.pinned ? ' is-pinned' : '') + (done ? ' is-done' : '')}
      draggable
      onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, task.id)}
      onDrop={onDrop}
    >
      <div className="card-top">
        <input
          className="card-check"
          type="checkbox"
          checked={done}
          aria-label={done ? `Rouvrir ${task.title}` : `Terminer ${task.title}`}
          onChange={() => void patch({ status: done ? 'todo' : 'done' })}
        />
        <button className="card-title" type="button" onClick={onEdit} title="Modifier">
          {task.title}
        </button>
        <span className="card-top-actions">
          <button
            className={'icon pin' + (task.pinned ? ' is-on' : '')}
            type="button"
            aria-label={task.pinned ? `Désépingler ${task.title}` : `Épingler ${task.title}`}
            aria-pressed={!!task.pinned}
            title={task.pinned ? 'Désépingler' : 'Épingler'}
            onClick={() => void patch({ pinned: task.pinned ? 0 : 1 })}
          >
            ★
          </button>
          <button
            className="icon"
            type="button"
            aria-label={`Supprimer ${task.title}`}
            title="Supprimer"
            onClick={async () => {
              if (!confirm(`Supprimer « ${task.title} » ?`)) return;
              await api.deleteTask(task.id);
              onChanged();
            }}
          >
            ✕
          </button>
        </span>
      </div>
      <div className="card-meta">
        <span
          className={'priority is-' + (task.priority ?? 'normal')}
          title={`Priorité ${priorityLabel(task.priority ?? 'normal').toLowerCase()}`}
        >
          <span aria-hidden="true">{task.priority === 'high' ? '▲ ' : task.priority === 'low' ? '▼ ' : '● '}</span>
          {priorityLabel(task.priority ?? 'normal')}
        </span>
        {task.due_date && (
          <span className={'due' + (late ? ' is-late' : '')} title={late ? 'En retard' : 'Échéance'}>
            <span aria-hidden="true">📅 </span>
            {dayLabel(task.due_date)}
          </span>
        )}
        {linkedDocuments.length > 0 && (
          <span className="docs-count" title={`${linkedDocuments.length} document${linkedDocuments.length > 1 ? 's' : ''} lié${linkedDocuments.length > 1 ? 's' : ''}`}>
            📎 {linkedDocuments.length}
          </span>
        )}
      </div>
      {documentControls}
    </div>
  );
}

function isGoogleDocument(entry: EntrySummary) {
  return Boolean(entry.google_document_id || entry.google_tab_id);
}
