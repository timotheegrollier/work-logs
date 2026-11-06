/** Contrat pur de fusion, partagé entre SQLite et le navigateur. */
const error = (message, status = 400, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
const stale = () => error('Une entrée a changé ou a déjà été remplacée. Relance la fusion.', 409, 'ENTRY_MERGE_STALE');
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])])) : value;
const decoded = (value) => typeof value === 'string' ? JSON.parse(value) : value ?? null;

/** Instantané local : ne doit jamais être envoyé au fournisseur IA. */
export function entryMergeSourceKey(entry) {
  return JSON.stringify(canonical([
    'entry-merge-v1', entry.id, entry.title, entry.entry_date, entry.project_id ?? null, entry.category_id ?? null,
    entry.archived ?? 0, entry.kind ?? 'note', entry.created_at, entry.updated_at,
    entry.content_md ?? '', decoded(entry.content_json),
  ]));
}

export function validateEntryMerge(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || typeof body.request_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.request_id)
    || typeof body.title !== 'string' || !body.title.trim()
    || typeof body.content_md !== 'string' || !body.content_md.trim()
    || !Array.isArray(body.sources) || body.sources.length < 2 || body.sources.length > 8) {
    throw error('Fusion invalide : titre, texte, identifiant de demande et deux à huit entrées requis.');
  }
  const ids = new Set();
  for (const source of body.sources) {
    if (!source || typeof source.id !== 'string' || !source.id || typeof source.source_key !== 'string' || !source.source_key || ids.has(source.id)) {
      throw error('Sources de fusion invalides ou répétées.');
    }
    ids.add(source.id);
  }
  return { request_id: body.request_id.toLowerCase(), title: body.title.trim(), content_md: body.content_md,
    sources: body.sources.map(({ id, source_key }) => ({ id, source_key })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
}

/** L'identifiant atteste le payload complet sans ajouter de schéma de provenance. */
export async function entryMergeTargetId(body) {
  const normalized = validateEntryMerge(body);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(normalized)));
  return 'en_merge_' + [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function assertEntryMergeSources(body, entries) {
  for (const source of body.sources) {
    const entry = entries.find((item) => item?.id === source.id);
    if (!entry) throw stale();
    if (entry.google_sync || entry.google_document_id || entry.google_tab_id) throw error('Les documents Google ne peuvent pas être fusionnés.');
    if (entryMergeSourceKey(entry) !== source.source_key) throw stale();
  }
}

export function assertEntryMergeReplay(body, entry) {
  if (entry.title !== body.title || entry.content_md !== body.content_md || entry.content_json) throw stale();
}

export function entryMergeClassification(entries) {
  const common = (key) => entries.every((entry) => (entry[key] ?? null) === (entries[0][key] ?? null)) ? entries[0][key] ?? null : null;
  const project_id = common('project_id');
  return { project_id, category_id: project_id ? common('category_id') : null, kind: common('kind') === 'procedure' ? 'procedure' : 'note' };
}
