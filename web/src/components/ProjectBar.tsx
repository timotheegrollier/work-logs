import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { api, type Project } from '../lib';

/** À partir de là, la liste de gestion propose de retrouver un projet par son nom. */
const FILTER_FROM = 8;

/**
 * Bandeau des projets : **une seule rangée**, quel que soit leur nombre.
 * Les pastilles défilent (molette comprise) ; la gestion s'ouvre par-dessus —
 * fenêtre sous le bouton sur desktop, feuille montant du bas sur mobile —
 * au lieu de déplier une liste qui poussait les colonnes hors de l'écran.
 * Sur téléphone (`compact`), un seul bouton nomme le projet courant et ouvre la
 * liste complète, où un toucher choisit (§54).
 */
export function ProjectBar({
  projects,
  selected,
  onSelect,
  onChanged,
  compact = false,
  children,
}: {
  projects: Project[];
  selected: string;
  onSelect: (id: string) => void;
  onChanged: () => void;
  compact?: boolean;
  /** Le filtre de catégorie, entre les pastilles et « Gérer ». */
  children?: ReactNode;
}) {
  const [sheet, setSheet] = useState<'pick' | 'manage' | null>(null);
  const current = projects.find((project) => project.id === selected);
  const [edges, setEdges] = useState({ start: false, end: false });
  const rail = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  // Fondu seulement du côté où il reste des projets à faire défiler.
  const measure = useCallback(() => {
    const el = rail.current;
    if (!el) return;
    const start = el.scrollLeft > 2;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdges((current) => (current.start === start && current.end === end ? current : { start, end }));
  }, []);

  useEffect(() => {
    measure();
    const el = rail.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, projects]);

  // Le filtre actif reste en vue : restauré au démarrage, ou choisi depuis une carte.
  useEffect(() => {
    rail.current
      ?.querySelector<HTMLElement>('[aria-pressed="true"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [selected, projects.length]);

  // Le focus revient au bouton une fois la fenêtre retirée : tant qu'elle est
  // ouverte, le reste de la page est inerte et refuserait le focus.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !sheet) trigger.current?.focus();
    wasOpen.current = sheet !== null;
  }, [sheet]);

  return (
    <nav className="projects" aria-label="Projets">
      {compact ? (
        <button
          ref={trigger}
          type="button"
          className={'project-switcher' + (current ? ' is-on' : '')}
          style={current ? ({ '--project': current.color } as CSSProperties) : undefined}
          aria-label={`Projet : ${current?.name ?? 'Tous les projets'}`}
          aria-haspopup="dialog"
          aria-expanded={sheet !== null}
          onClick={() => setSheet('pick')}
        >
          <span className="dot" aria-hidden="true" />
          <span className="project-switcher-name">{current?.name ?? 'Tous les projets'}</span>
        </button>
      ) : (
      <div
        ref={rail}
        className={'chips' + (edges.start ? ' fade-start' : '') + (edges.end ? ' fade-end' : '')}
        role="group"
        aria-label="Filtrer par projet"
        onScroll={measure}
        // Molette verticale → défilement horizontal : sans ça, une souris sans
        // molette latérale n'atteignait jamais les projets hors champ.
        onWheel={(event) => {
          const el = event.currentTarget;
          if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || el.scrollWidth <= el.clientWidth) return;
          el.scrollLeft += event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
        }}
      >
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
            style={{ '--project': project.color } as CSSProperties}
            aria-pressed={selected === project.id}
            onClick={() => onSelect(selected === project.id ? '' : project.id)}
          >
            <span className="dot" aria-hidden="true" />
            {project.name}
            {project.open_tasks > 0 && <span className="count">{project.open_tasks}</span>}
          </button>
        ))}
      </div>
      )}

      {children}

      {!compact && <button
        ref={trigger}
        type="button"
        className={'manage-btn' + (sheet ? ' is-on' : '')}
        aria-label="Gérer les projets"
        aria-haspopup="dialog"
        aria-expanded={sheet !== null}
        title="Créer, renommer, recolorer ou supprimer des projets"
        onClick={() => setSheet('manage')}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10.6 2.6a1.6 1.6 0 0 1 2.3 2.3L5.6 12.2 2.5 13l.8-3.1z" />
          <path d="m9.4 3.8 2.3 2.3" />
        </svg>
        <span>
          Gérer<span className="manage-more"> les projets</span>
        </span>
      </button>}

      {sheet && (
        <ProjectManager
          projects={projects}
          selected={selected}
          picking={sheet === 'pick'}
          anchor={trigger}
          onSelect={onSelect}
          onChanged={onChanged}
          onClose={() => setSheet(null)}
        />
      )}
    </nav>
  );
}

function ProjectManager({
  projects,
  selected,
  picking = false,
  anchor,
  onSelect,
  onChanged,
  onClose,
}: {
  projects: Project[];
  selected: string;
  /** Ouverte pour choisir (téléphone) : une liste à toucher, « Gérer les projets » en pied. */
  picking?: boolean;
  anchor: RefObject<HTMLButtonElement | null>;
  onSelect: (id: string) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [choosing, setChoosing] = useState(picking);

  useLayoutEffect(() => {
    const el = dialog.current;
    if (!el) return;
    // Desktop : la fenêtre tombe sous son bouton, calée sur son bord droit.
    // Sur mobile, la feuille ignore ces repères et se pose en bas de l'écran.
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
    // Choisir : le focus sur le projet courant. Gérer au clavier physique : on écrit le
    // nom tout de suite ; écran tactile : pas de clavier qui masque la liste ouverte.
    if (picking) el.querySelector<HTMLElement>('.project-choice[aria-pressed="true"]')?.focus();
    else if (window.matchMedia?.('(pointer: fine)').matches) field.current?.focus();
    return () => window.removeEventListener('resize', place);
  }, [anchor, picking]);

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
    setFilter('');
    onChanged();
  };

  const remove = async (project: Project) => {
    if (!confirm(`Supprimer « ${project.name} » ? Les entrées et tâches sont conservées.`)) return;
    if (selected === project.id) onSelect('');
    await api.deleteProject(project.id);
    onChanged();
  };

  // Fermer, c'est aussi valider le renommage en cours : le champ perd le focus
  // (et enregistre) avant que la fenêtre ne disparaisse avec lui.
  const close = () => {
    if (dialog.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    onClose();
  };

  const query = filter.trim().toLocaleLowerCase('fr');
  const shown = query ? projects.filter((project) => project.name.toLocaleLowerCase('fr').includes(query)) : projects;
  const choose = (id: string) => {
    onSelect(id);
    onClose();
  };

  return createPortal(
    <dialog
      ref={dialog}
      className="project-sheet no-print"
      aria-labelledby="project-sheet-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      // Clic sur le voile : le contenu remplit toute la fenêtre, seul le voile
      // a donc la fenêtre elle-même pour cible.
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="project-sheet-body">
        <div className="project-sheet-head">
          <h2 id="project-sheet-title">
            Projets <span className="count">{projects.length}</span>
          </h2>
          <button className="ghost" type="button" onClick={close}>
            Fermer
          </button>
        </div>

        {!choosing && <div className="add-project">
          <input
            ref={field}
            aria-label="Nom du nouveau projet"
            placeholder="Nouveau projet…"
            enterKeyHint="done"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError('');
            }}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
          <button className="task-primary" type="button" onClick={create}>
            Créer
          </button>
        </div>}
        {error && <p className="error">{error}</p>}

        {projects.length >= FILTER_FROM && (
          <input
            className="project-filter"
            type="search"
            aria-label="Retrouver un projet"
            placeholder={`Retrouver un projet parmi ${projects.length}…`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            enterKeyHint={choosing ? 'go' : undefined}
            onKeyDown={(e) => {
              // Échap vide d'abord le champ ; un second Échap ferme la fenêtre.
              if (e.key === 'Escape' && filter) {
                e.preventDefault();
                setFilter('');
              }
              // Pour choisir, Entrée prend le premier projet trouvé. Sans preventDefault, la
              // touche finissait sur le bouton qui reprend le focus et rouvrait la liste.
              if (e.key === 'Enter' && choosing && query && shown[0]) {
                e.preventDefault();
                choose(shown[0].id);
              }
            }}
          />
        )}

        {choosing ? (
          <>
            {shown.length === 0 ? (
              <p className="empty">Aucun projet ne s’appelle « {filter.trim()} ».</p>
            ) : (
              <ul className="project-choices" aria-label="Choisir un projet">
                {!query && (
                  <li>
                    <button type="button" className="project-choice is-all" aria-pressed={selected === ''} onClick={() => choose('')}>
                      <span className="dot" aria-hidden="true" />
                      <span className="project-choice-name">Tous les projets</span>
                    </button>
                  </li>
                )}
                {shown.map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      className="project-choice"
                      style={{ '--project': project.color } as CSSProperties}
                      aria-pressed={selected === project.id}
                      onClick={() => choose(project.id)}
                    >
                      <span className="dot" aria-hidden="true" />
                      <span className="project-choice-name">{project.name}</span>
                      {project.open_tasks > 0 && <span className="count">{project.open_tasks}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button className="ghost project-manage" type="button" onClick={() => setChoosing(false)}>
              Gérer les projets
            </button>
          </>
        ) : projects.length === 0 ? (
          <p className="empty">Aucun projet. Donne-lui un nom ci-dessus pour le créer.</p>
        ) : shown.length === 0 ? (
          <p className="empty">Aucun projet ne s’appelle « {filter.trim()} ».</p>
        ) : (
          <ul className="project-list" aria-label="Projets existants">
            {shown.map((project) => (
              <li key={project.id} style={{ '--project': project.color } as CSSProperties}>
                <input
                  type="color"
                  className="swatch"
                  aria-label={`Couleur de ${project.name}`}
                  value={project.color}
                  onChange={(e) => api.updateProject(project.id, { color: e.target.value }).then(onChanged)}
                />
                <input
                  className="project-name"
                  aria-label={`Nom de ${project.name}`}
                  defaultValue={project.name}
                  enterKeyHint="done"
                  onBlur={(e) => {
                    const value = e.target.value.trim();
                    if (value && value !== project.name)
                      api.updateProject(project.id, { name: value }).then(onChanged);
                  }}
                  // Entrée est le geste attendu pour valider ; sans ça le renommage
                  // ne partait qu'en cliquant ailleurs, et paraissait donc cassé.
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape' && e.currentTarget.value !== project.name) {
                      // Annule la saisie sans fermer la fenêtre ; un second Échap la ferme.
                      e.preventDefault();
                      e.currentTarget.value = project.name;
                      e.currentTarget.blur();
                    }
                  }}
                />
                {project.entries > 0 && (
                  <span className="project-usage">
                    {project.entries} entrée{project.entries > 1 ? 's' : ''}
                  </span>
                )}
                <button className="icon project-delete" aria-label={`Supprimer ${project.name}`} onClick={() => remove(project)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </dialog>,
    document.body
  );
}

const PALETTE = ['#8b5cf6', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#64748b'];
const nextColor = (index: number) => PALETTE[index % PALETTE.length];
