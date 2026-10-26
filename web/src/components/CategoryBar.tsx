import { useState } from 'react';
import { api, type Category, type Project } from '../lib';
import { categoryDescendants, categoryOptions, categoryPath, UNCATEGORIZED } from '../categories';
import { flushPendingSaves } from '../autosave';

export function CategoryBar({ categories, projects, projectId, selected, grouped, onSelect, onGrouped, onChanged }: {
  categories: Category[]; projects: Project[]; projectId: string; selected: string; grouped: boolean;
  onSelect: (id: string) => void; onGrouped: (value: boolean) => void; onChanged: () => void;
}) {
  const [managing, setManaging] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#64748b');
  const [parentId, setParentId] = useState('');
  const [formProject, setFormProject] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const visibleProjects = projectId ? projects.filter((project) => project.id === projectId) : projects;
  const currentProject = projects.find((project) => project.id === projectId);
  const selectedCategory = categories.find((category) => category.id === selected);
  const forbidden = editing ? categoryDescendants(categories, editing) : new Set<string>();

  const start = (category?: Category, parent?: Category) => {
    setEditing(category?.id || null);
    setName(category?.name || '');
    setColor(category?.color || parent?.color || currentProject?.color || '#64748b');
    setParentId(category?.parent_id || parent?.id || '');
    setFormProject(category?.project_id || parent?.project_id || projectId || projects[0]?.id || '');
    setError('');
    setManaging(true);
  };
  const save = async () => {
    if (!name.trim() || !formProject || busy) return;
    setBusy(true); setError('');
    try {
      const body = { name: name.trim(), color, parent_id: parentId || null };
      if (editing) await api.updateCategory(editing, body);
      else await api.createCategory({ ...body, project_id: formProject });
      setManaging(false);
      onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const remove = async (category: Category) => {
    if (!window.confirm(`Supprimer « ${category.name} » ? Ses entrées, tâches et sous-catégories seront rangées dans sa catégorie parente, ou sans catégorie.`)) return;
    setBusy(true); setError('');
    try {
      await flushPendingSaves();
      await api.deleteCategory(category.id);
      if (selected === category.id) onSelect(category.parent_id || '');
      if (editing === category.id) setManaging(false);
      onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return <section className="category-bar no-print" aria-label="Catégories">
    <div className="category-toolbar">
      <strong>Catégories{currentProject ? ` · ${currentProject.name}` : ''}</strong>
      <div className="category-filters" role="group" aria-label="Filtrer par catégorie">
        <button className={'chip' + (!selected ? ' is-on' : '')} aria-pressed={!selected} onClick={() => onSelect('')}>Toutes les catégories</button>
        <button className={'chip' + (selected === UNCATEGORIZED ? ' is-on' : '')} aria-pressed={selected === UNCATEGORIZED} onClick={() => onSelect(UNCATEGORIZED)}>Sans catégorie</button>
      </div>
      <span className="grow" />
      <label className="category-group-toggle"><input type="checkbox" checked={grouped} onChange={(event) => onGrouped(event.target.checked)} />Regrouper par catégorie</label>
      <button className="ghost" disabled={projects.length === 0} onClick={() => start()}>＋ Catégorie</button>
    </div>

    {categories.some((category) => !projectId || category.project_id === projectId) ? <div className="category-projects">
      {visibleProjects.map((project) => {
        const options = categoryOptions(categories, project.id);
        if (!options.length) return null;
        return <div key={project.id} className="category-project">
          {!projectId && <h2><span className="dot" style={{ background: project.color }} aria-hidden="true" />{project.name}</h2>}
          <ul className="category-tree">
            {options.map(({ category, depth }) => {
              const descendants = categoryDescendants(categories, category.id);
              const subtree = categories.filter((row) => descendants.has(row.id));
              const entries = subtree.reduce((sum, row) => sum + (row.entries || 0), 0);
              const tasks = subtree.reduce((sum, row) => sum + (row.open_tasks || 0), 0);
              return <li key={category.id} className={'category-node' + (selected === category.id ? ' is-selected' : '')}>
                <span className="category-indent" aria-hidden="true">{'↳ '.repeat(depth)}</span>
                <button className="category-filter" aria-label={`Afficher la catégorie ${category.name}`} aria-pressed={selected === category.id} title={`${categoryPath(categories, category.id)} · sous-catégories comprises`} onClick={() => onSelect(category.id)}>
                  <span className="dot" style={{ background: category.color }} aria-hidden="true" />
                  <span className="category-name">{category.name}</span>
                  <span className="category-count" aria-label={`${entries} entrée${entries > 1 ? 's' : ''}, ${tasks} tâche${tasks > 1 ? 's' : ''} ouverte${tasks > 1 ? 's' : ''}`}>{entries} entrée{entries > 1 ? 's' : ''} · {tasks} tâche{tasks > 1 ? 's' : ''}</span>
                </button>
                <button className="icon" aria-label={`Ajouter une sous-catégorie à ${category.name}`} title="Ajouter une sous-catégorie" onClick={() => start(undefined, category)}>＋</button>
                <button className="icon" aria-label={`Modifier la catégorie ${category.name}`} title="Renommer, déplacer ou recolorer" onClick={() => start(category)}>✎</button>
                <button className="icon" disabled={busy} aria-label={`Supprimer la catégorie ${category.name}`} title="Supprimer la catégorie" onClick={() => void remove(category)}>×</button>
              </li>;
            })}
          </ul>
        </div>;
      })}
    </div> : <p className="category-hint">Range les notes et les objectifs de tes projets dans des catégories et sous-catégories.</p>}

    {selectedCategory && <p className="category-hint">{categoryPath(categories, selected)} · sous-catégories comprises</p>}
    {managing && <form className="category-form" aria-label={editing ? 'Modifier une catégorie' : 'Créer une catégorie'} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>Nom<input aria-label="Nom de la catégorie" maxLength={100} required autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Projet<select aria-label="Projet de la catégorie" disabled={!!editing} value={formProject} onChange={(event) => { setFormProject(event.target.value); setParentId(''); }}>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>
      <label>Ranger dans<select aria-label="Catégorie parente" value={parentId} onChange={(event) => setParentId(event.target.value)}>
        <option value="">À la racine du projet</option>
        {categoryOptions(categories, formProject).filter(({ category }) => !forbidden.has(category.id)).map(({ category, label }) => <option key={category.id} value={category.id}>{label}</option>)}
      </select></label>
      <label>Couleur<input type="color" aria-label="Couleur de la catégorie" value={color} onChange={(event) => setColor(event.target.value)} /></label>
      <button className="ghost" type="submit" disabled={busy || !name.trim() || !formProject}>{busy ? 'Enregistrement…' : 'Enregistrer la catégorie'}</button>
      <button type="button" disabled={busy} onClick={() => setManaging(false)}>Annuler</button>
    </form>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
