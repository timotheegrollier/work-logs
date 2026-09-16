import { useState } from 'react';
import { COLUMNS, api, dayLabel, isOverdue, type EntrySummary, type Status, type Task } from '../lib';

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
  const [form, setForm] = useState({ title: task.title, due_date: task.due_date ?? '' });
  const [linking, setLinking] = useState(false);
  const [selectedDocumentId, setSelectedDocumentId] = useState('');
  const linkedDocuments = task.documents ?? [];
  const linkedIds = new Set(linkedDocuments.map((document) => document.id));
  const availableDocuments = entries.filter((entry) => !linkedIds.has(entry.id));
  const done = task.status === 'done';
  const late = isOverdue(task);

  const patch = async (body: Partial<Task>) => {
    await api.updateTask(task.id, body);
    onChanged();
  };

  const saveEdit = async () => {
    if (!form.title.trim()) return;
    onEditDone();
    await patch({ title: form.title.trim(), due_date: form.due_date || null });
  };

  const startLinking = () => {
    setSelectedDocumentId(availableDocuments[0]?.id ?? '');
    setLinking(true);
  };

  const linkDocument = async () => {
    if (!selectedDocumentId) return;
    await api.linkTaskDocument(task.id, selectedDocumentId);
    setLinking(false);
    onChanged();
  };

  const unlinkDocument = async (entryId: string) => {
    await api.unlinkTaskDocument(task.id, entryId);
    onChanged();
  };

  const documentControls = (
    <>
      {linkedDocuments.length > 0 && (
        <div className="task-documents" aria-label={`Documents liés à ${task.title}`}>
          {linkedDocuments.map((document) => {
            const source = isGoogleDocument(document) ? 'Google' : 'local';
            return (
              <div className="task-document" key={document.id}>
                <button
                  className="task-document-open"
                  type="button"
                  aria-label={`Ouvrir ${document.title}`}
                  onClick={() => onOpenDocument(document.id)}
                >
                  {document.title}
                </button>
                <span className="task-document-source">{source}</span>
                <button
                  className="icon"
                  type="button"
                  aria-label={`Retirer ${document.title} de ${task.title}`}
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
        <div className="document-linker" aria-label={`Relier un document à ${task.title}`}>
          <label>
            Document à relier
            <select
              aria-label={`Document à relier à ${task.title}`}
              value={selectedDocumentId}
              disabled={availableDocuments.length === 0}
              onChange={(event) => setSelectedDocumentId(event.target.value)}
            >
              {availableDocuments.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.title} — {isGoogleDocument(entry) ? 'Google' : 'local'}
                </option>
              ))}
            </select>
          </label>
          {availableDocuments.length === 0 && <p className="empty">Tous les documents sont déjà liés.</p>}
          <div className="card-actions">
            <button className="ghost" type="button" disabled={!selectedDocumentId} onClick={() => void linkDocument()}>
              Relier
            </button>
            <button className="ghost" type="button" onClick={() => setLinking(false)}>
              Annuler
            </button>
          </div>
        </div>
      ) : (
        <button className="link-document" type="button" onClick={startLinking}>
          Relier un document
        </button>
      )}
    </>
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
      <input
        type="checkbox"
        checked={done}
        aria-label={done ? `Rouvrir ${task.title}` : `Terminer ${task.title}`}
        onChange={() => void patch({ status: done ? 'todo' : 'done' })}
      />
      <button className="card-title" type="button" onClick={onEdit} title="Modifier">
        {task.title}
      </button>
      {task.due_date && (
        <span className={'due' + (late ? ' is-late' : '')}>{dayLabel(task.due_date)}</span>
      )}
      <button
        className={'icon pin' + (task.pinned ? ' is-on' : '')}
        type="button"
        aria-label={task.pinned ? `Désépingler ${task.title}` : `Épingler ${task.title}`}
        aria-pressed={!!task.pinned}
        onClick={() => void patch({ pinned: task.pinned ? 0 : 1 })}
      >
        ★
      </button>
      <button
        className="icon"
        type="button"
        aria-label={`Supprimer ${task.title}`}
        onClick={async () => {
          if (!confirm(`Supprimer « ${task.title} » ?`)) return;
          await api.deleteTask(task.id);
          onChanged();
        }}
      >
        ✕
      </button>
      {documentControls}
    </div>
  );
}

function isGoogleDocument(entry: EntrySummary) {
  return Boolean(entry.google_document_id || entry.google_tab_id);
}
