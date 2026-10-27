import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { api, type Category, type Project } from '../lib';
import { categoryDescendants, categoryOptions, categoryPath, UNCATEGORIZED } from '../categories';
import { flushPendingSaves } from '../autosave';

type Props = {
  categories: Category[]; projects: Project[]; projectId: string; selected: string; grouped: boolean;
  onSelect: (id: string) => void; onGrouped: (value: boolean) => void; onChanged: () => void;
};
type Form = { editing: string | null; name: string; color: string; parentId: string; projectId: string };

/**
 * Catégories : un seul bouton dans le bandeau des projets. Filtre, regroupement et
 * rangement s'ouvrent par-dessus, comme la gestion des projets (§35) : aucune rangée
 * de plus à l'écran, rien ne pousse le contenu (§48).
 */
export function CategoryBar(props: Props) {
  const { categories, selected } = props;
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = categories.find((category) => category.id === selected);
  const label = selected === UNCATEGORIZED ? 'Sans catégorie' : current ? categoryPath(categories, selected) : '';

  // Le focus revient au bouton une fois la fenêtre retirée (le reste de la page était inerte).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);

  return <>
    <button
      ref={trigger}
      type="button"
      className={'chip category-trigger' + (selected ? ' is-on' : '')}
      style={current ? { '--project': current.color } as CSSProperties : undefined}
      aria-label={label ? `Catégories : ${label}` : 'Catégories'}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={label ? `Filtré par ${label}` : 'Filtrer, regrouper et ranger par catégorie'}
      onClick={() => setOpen(true)}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
        <path d="M2.5 2.5h5.2l5.8 5.8-5.2 5.2-5.8-5.8z" /><circle cx="5.6" cy="5.6" r="1" fill="currentColor" stroke="none" />
      </svg>
      <span className="category-trigger-label">{current?.name ?? (label || 'Catégories')}</span>
    </button>
    {open && <CategorySheet {...props} anchor={trigger} onClose={() => setOpen(false)} />}
  </>;
}

function CategorySheet({ categories, projects, projectId, selected, grouped, onSelect, onGrouped, onChanged, anchor, onClose }: Props & {
  anchor: RefObject<HTMLButtonElement | null>; onClose: () => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const currentProject = projects.find((project) => project.id === projectId);
  const groups = projects
    .filter((project) => !projectId || project.id === projectId)
    .map((project) => ({ project, options: categoryOptions(categories, project.id) }))
    .filter(({ options }) => options.length > 0);
  const forbidden = form?.editing ? categoryDescendants(categories, form.editing) : new Set<string>();

  useLayoutEffect(() => {
    const el = dialog.current;
    if (!el) return;
    // Même placement que la gestion des projets : sous le bouton sur desktop, feuille du bas sur mobile.
    const place = () => {
      const box = anchor.current?.getBoundingClientRect();
      if (!box) return;
      el.style.setProperty('--anchor-top', `${Math.round(box.bottom + 8)}px`);
      el.style.setProperty('--anchor-right', `${Math.max(12, Math.round(window.innerWidth - box.right))}px`);
    };
    place();
    window.addEventListener('resize', place);
    if (!el.open) {
      try { el.showModal(); } catch { el.setAttribute('open', ''); }
    }
    el.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
    return () => window.removeEventListener('resize', place);
  }, [anchor]);

  // Le champ prend le focus à l'ouverture du formulaire ; à sa fermeture, le bouton qui l'avait ouvert le reprend.
  useLayoutEffect(() => {
    if (form) nameField.current?.focus();
    else if (opener.current) (opener.current.isConnected ? opener.current : addButton.current)?.focus();
  }, [form?.editing, form === null]);

  const choose = (id: string) => { onSelect(id); onClose(); };
  const start = (from: HTMLElement, category?: Category, parent?: Category) => {
    opener.current = from;
    setError('');
    setForm({
      editing: category?.id ?? null,
      name: category?.name ?? '',
      color: category?.color ?? parent?.color ?? currentProject?.color ?? '#64748b',
      parentId: category?.parent_id ?? parent?.id ?? '',
      projectId: category?.project_id ?? parent?.project_id ?? (projectId || projects[0]?.id || ''),
    });
  };
  const save = async () => {
    if (!form || !form.name.trim() || !form.projectId || busy) return;
    setBusy(true); setError('');
    try {
      const body = { name: form.name.trim(), color: form.color, parent_id: form.parentId || null };
      if (form.editing) await api.updateCategory(form.editing, body);
      else await api.createCategory({ ...body, project_id: form.projectId });
      setForm(null);
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
      if (form?.editing === category.id) setForm(null);
      onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return createPortal(
    <dialog
      ref={dialog}
      className="project-sheet category-sheet no-print"
      aria-labelledby={titleId}
      // Échap ferme d'abord le formulaire commencé, puis la fenêtre.
      onCancel={(event) => {
        event.preventDefault();
        if (busy) return;
        if (form) setForm(null);
        else onClose();
      }}
      onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
    >
      <div className="project-sheet-body">
        <div className="project-sheet-head">
          <h2 id={titleId}>Catégories{currentProject && <span className="category-sheet-project"> · {currentProject.name}</span>}</h2>
          <button className="ghost" type="button" disabled={busy} onClick={onClose}>Fermer</button>
        </div>

        <div className="category-sheet-filters">
          <div className="chips" role="group" aria-label="Filtrer par catégorie">
            <button type="button" className={'chip' + (!selected ? ' is-on' : '')} aria-pressed={!selected} onClick={() => choose('')}>Toutes les catégories</button>
            <button type="button" className={'chip' + (selected === UNCATEGORIZED ? ' is-on' : '')} aria-pressed={selected === UNCATEGORIZED} onClick={() => choose(UNCATEGORIZED)}>Sans catégorie</button>
          </div>
          <label className="category-group-toggle"><input type="checkbox" checked={grouped} onChange={(event) => onGrouped(event.target.checked)} />Regrouper par catégorie</label>
        </div>

        {form ? (
          <form className="category-form" aria-label={form.editing ? 'Modifier une catégorie' : 'Créer une catégorie'} onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <input ref={nameField} aria-label="Nom de la catégorie" placeholder="Nom de la catégorie…" enterKeyHint="done" maxLength={100} required disabled={busy} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            <input type="color" aria-label="Couleur de la catégorie" disabled={busy} value={form.color} onChange={(event) => setForm({ ...form, color: event.target.value })} />
            {!form.editing && !projectId && <select aria-label="Projet de la catégorie" disabled={busy} value={form.projectId} onChange={(event) => setForm({ ...form, projectId: event.target.value, parentId: '' })}>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>}
            <select aria-label="Catégorie parente" disabled={busy} value={form.parentId} onChange={(event) => setForm({ ...form, parentId: event.target.value })}>
              <option value="">À la racine du projet</option>
              {categoryOptions(categories, form.projectId).filter(({ category }) => !forbidden.has(category.id)).map(({ category, label }) => <option key={category.id} value={category.id}>{label}</option>)}
            </select>
            <div className="category-form-actions">
              <button className="task-primary" type="submit" disabled={busy || !form.name.trim() || !form.projectId}>{busy ? 'Enregistrement…' : 'Enregistrer la catégorie'}</button>
              <button className="ghost" type="button" disabled={busy} onClick={() => setForm(null)}>Annuler</button>
            </div>
          </form>
        ) : (
          <button ref={addButton} className="ghost category-add" type="button" disabled={busy || projects.length === 0} onClick={(event) => start(event.currentTarget)}>＋ Catégorie</button>
        )}
        {error && <p className="error" role="alert">{error}</p>}

        {groups.length > 0 ? <div className="category-list">
          {groups.map(({ project, options }) => <section key={project.id} aria-label={`Catégories de ${project.name}`}>
            {!projectId && <h3><span className="dot" style={{ background: project.color }} aria-hidden="true" />{project.name}</h3>}
            <ul className="category-tree">
              {options.map(({ category, depth }) => {
                const subtree = categories.filter((row) => categoryDescendants(categories, category.id).has(row.id));
                const entries = subtree.reduce((sum, row) => sum + (row.entries || 0), 0);
                const tasks = subtree.reduce((sum, row) => sum + (row.open_tasks || 0), 0);
                return <li key={category.id} className={'category-node' + (selected === category.id ? ' is-selected' : '')} style={{ '--depth': Math.min(depth, 4) } as CSSProperties}>
                  <button className="category-filter" type="button" aria-label={`Afficher la catégorie ${category.name}`} aria-pressed={selected === category.id} title={`${categoryPath(categories, category.id)} · sous-catégories comprises`} onClick={() => choose(category.id)}>
                    <span className="dot" style={{ background: category.color }} aria-hidden="true" />
                    <span className="category-name">{category.name}<small className="category-count">{entries} entrée{entries > 1 ? 's' : ''} · {tasks} tâche{tasks > 1 ? 's' : ''}</small></span>
                  </button>
                  <span className="category-node-actions">
                    <button className="icon" type="button" disabled={busy} aria-label={`Ajouter une sous-catégorie à ${category.name}`} title="Ajouter une sous-catégorie" onClick={(event) => start(event.currentTarget, undefined, category)}>＋</button>
                    <button className="icon" type="button" disabled={busy} aria-label={`Modifier la catégorie ${category.name}`} title="Renommer, déplacer ou recolorer" onClick={(event) => start(event.currentTarget, category)}>✎</button>
                    <button className="icon category-delete" type="button" disabled={busy} aria-label={`Supprimer la catégorie ${category.name}`} title="Supprimer la catégorie" onClick={() => void remove(category)}>✕</button>
                  </span>
                </li>;
              })}
            </ul>
          </section>)}
        </div> : <p className="empty">Aucune catégorie{currentProject ? ` dans ${currentProject.name}` : ''}. Crée la première pour ranger notes et tâches.</p>}
      </div>
    </dialog>,
    document.body,
  );
}
