import { useState } from 'react';
import { api, type Project } from '../lib';

export function ProjectBar({
  projects,
  selected,
  onSelect,
  onChanged,
}: {
  projects: Project[];
  selected: string;
  onSelect: (id: string) => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState('');

  const create = async () => {
    if (!name.trim()) return;
    await api.createProject({ name: name.trim(), color: nextColor(projects.length) });
    setName('');
    onChanged();
  };

  const remove = async (project: Project) => {
    if (!confirm(`Supprimer « ${project.name} » ? Les entrées et tâches sont conservées.`)) return;
    if (selected === project.id) onSelect('');
    await api.deleteProject(project.id);
    onChanged();
  };

  return (
    <nav className="projects" aria-label="Projets">
      <div className="chips" role="group" aria-label="Filtrer par projet">
        <button
          className={'chip' + (selected === '' ? ' is-on' : '')}
          aria-pressed={selected === ''}
          onClick={() => onSelect('')}
        >
          Tout
        </button>
        {projects.map((project) => (
          <button
            key={project.id}
            className={'chip' + (selected === project.id ? ' is-on' : '')}
            aria-pressed={selected === project.id}
            onClick={() => onSelect(selected === project.id ? '' : project.id)}
          >
            <span className="dot" style={{ background: project.color }} aria-hidden="true" />
            {project.name}
            {project.open_tasks > 0 && <span className="count">{project.open_tasks}</span>}
          </button>
        ))}
      </div>

      <details className="manage">
        <summary>Gérer les projets</summary>
        <ul>
          {projects.map((project) => (
            <li key={project.id}>
              <input
                type="color"
                aria-label={`Couleur de ${project.name}`}
                value={project.color}
                onChange={(e) => api.updateProject(project.id, { color: e.target.value }).then(onChanged)}
              />
              <input
                aria-label={`Nom de ${project.name}`}
                defaultValue={project.name}
                onBlur={(e) => {
                  const value = e.target.value.trim();
                  if (value && value !== project.name)
                    api.updateProject(project.id, { name: value }).then(onChanged);
                }}
              />
              <button className="icon" aria-label={`Supprimer ${project.name}`} onClick={() => remove(project)}>
                ✕
              </button>
            </li>
          ))}
        </ul>
        <div className="add-project">
          <input
            aria-label="Nom du nouveau projet"
            placeholder="Nouveau projet…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
          <button className="ghost" onClick={create} disabled={!name.trim()}>
            Créer
          </button>
        </div>
      </details>
    </nav>
  );
}

const PALETTE = ['#8b5cf6', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#64748b'];
const nextColor = (index: number) => PALETTE[index % PALETTE.length];
