import { useState } from 'react';
import { COLUMNS, api, dayLabel, isOverdue, type Status, type Task } from '../lib';

const DRAG_TYPE = 'text/plain';

export function TaskBoard({
  tasks,
  projectId,
  onChanged,
}: {
  tasks: Task[];
  projectId: string;
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
        <button className="ghost" onClick={add} disabled={!title.trim()}>
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
                    editing={editing === task.id}
                    onEdit={() => setEditing(task.id)}
                    onEditDone={() => setEditing(null)}
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
  editing,
  onEdit,
  onEditDone,
  onChanged,
  onDrop,
}: {
  task: Task;
  editing: boolean;
  onEdit: () => void;
  onEditDone: () => void;
  onChanged: () => void;
  onDrop: (event: React.DragEvent) => void;
}) {
  const [form, setForm] = useState({ title: task.title, due_date: task.due_date ?? '' });
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

  if (editing) {
    return (
      <div className="card is-editing">
        <input
          aria-label="Titre de la tâche"
          autoFocus
          value={form.title}
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveEdit();
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
          <button className="ghost" onClick={saveEdit}>
            Enregistrer
          </button>
          <button className="ghost" onClick={onEditDone}>
            Annuler
          </button>
        </div>
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
        onChange={() => patch({ status: done ? 'todo' : 'done' })}
      />
      <button className="card-title" onClick={onEdit} title="Modifier">
        {task.title}
      </button>
      {task.due_date && (
        <span className={'due' + (late ? ' is-late' : '')}>{dayLabel(task.due_date)}</span>
      )}
      <button
        className={'icon pin' + (task.pinned ? ' is-on' : '')}
        aria-label={task.pinned ? `Désépingler ${task.title}` : `Épingler ${task.title}`}
        aria-pressed={!!task.pinned}
        onClick={() => patch({ pinned: task.pinned ? 0 : 1 })}
      >
        ★
      </button>
      <button
        className="icon"
        aria-label={`Supprimer ${task.title}`}
        onClick={async () => {
          if (!confirm(`Supprimer « ${task.title} » ?`)) return;
          await api.deleteTask(task.id);
          onChanged();
        }}
      >
        ✕
      </button>
    </div>
  );
}
