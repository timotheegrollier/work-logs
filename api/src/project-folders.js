const invalid = () => {
  throw Object.assign(new Error('dossier relié invalide'), { status: 400 });
};

function folder(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 2000 || /[\x00-\x1f]/.test(value)) invalid();
  return value.trim() || null;
}

/** La liste ordonnée fait foi ; le premier dossier reste compatible avec les anciens clients. */
export function projectFolders(project = {}) {
  if (project.shared_dirs !== undefined && (!Array.isArray(project.shared_dirs) || project.shared_dirs.some((value) => typeof value !== 'string'))) invalid();
  const values = project.shared_dirs === undefined ? [project.shared_dir] : project.shared_dirs;
  const shared_dirs = [...new Set(values.map(folder).filter((value) => value !== null))];
  return { shared_dirs, shared_dir: shared_dirs[0] ?? null };
}

/** Une ancienne écriture du seul champ singulier remplace toujours son lien unique. */
export function nextProjectFolders(patch, current = {}) {
  return projectFolders(patch.shared_dirs !== undefined || patch.shared_dir !== undefined ? patch : current);
}

/** Un ancien client qui renomme un projet ignore les autres dossiers, mais sait changer son lien. */
export function mergeProjectFolders(winner, previous = {}) {
  const wanted = projectFolders(winner);
  return winner.shared_dirs === undefined && wanted.shared_dir !== null && wanted.shared_dir === previous.shared_dir
    ? projectFolders(previous) : wanted;
}

/** SQLite garde la liste sous forme JSON ; les instantanés et IndexedDB exposent un tableau. */
export function decodeProject(row) {
  if (!row) return row;
  const { shared_dirs, ...fields } = row;
  const values = typeof shared_dirs === 'string' ? JSON.parse(shared_dirs) : shared_dirs;
  return { ...fields, ...projectFolders({ ...fields, ...(values == null ? {} : { shared_dirs: values }) }) };
}
