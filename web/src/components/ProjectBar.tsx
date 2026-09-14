import { useRef, useState } from 'react';
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
  const [error, setError] = useState('');
  const field = useRef<HTMLInputElement>(null);

  // Le bouton n'est plus désactivé : grisé et sans explication, il se lisait
  // comme « cassé » — surtout quand il ne reste aucun projet et que le panneau
  // est vide. Un clic à vide dit maintenant ce qui manque et rend la main au champ.
  const create = async () => {
    if (!name.trim()) {
      setError('Donne un nom au projet.');
      field.current?.focus();
      return;
    }
    await api.createProject({ name: name.trim(), color: nextColor(projects.length) });
    setName('');
    setError('');
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
        <summary>
          <span aria-hidden="true">＋</span>
          <span>Gérer les projets</span>
        </summary>
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
                // Entrée est le geste attendu pour valider ; sans ça le renommage
                // ne partait qu'en cliquant ailleurs, et paraissait donc cassé.
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') {
                    e.currentTarget.value = project.name;
                    e.currentTarget.blur();
                  }
                }}
              />
              <button className="icon" aria-label={`Supprimer ${project.name}`} onClick={() => remove(project)}>
                ✕
              </button>
            </li>
          ))}
        </ul>
        {projects.length === 0 && (
          <p className="empty">Aucun projet. Donne-lui un nom ci-dessous pour le créer.</p>
        )}
        <div className="add-project">
          <input
            ref={field}
            aria-label="Nom du nouveau projet"
            placeholder="Nouveau projet…"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError('');
            }}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
          <button className="ghost" onClick={create}>
            Créer
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </details>
    </nav>
  );
}

const PALETTE = ['#8b5cf6', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#64748b'];
const nextColor = (index: number) => PALETTE[index % PALETTE.length];
