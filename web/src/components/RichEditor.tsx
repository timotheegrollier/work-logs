import { useEffect, useRef, useState, type ReactNode } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyleKit } from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import { api, type RichDocument } from '../lib';
import { RichSearch, replaceMatches, searchKey, setSearch } from '../rich-search';
import { GoogleBlock, GoogleFormatting, GoogleInline, PreserveGoogleObjects } from '../google-content';

export function RichEditor({ content, entryId, onChange, googleLinked = false, disabled = false }: {
  disabled?: boolean; googleLinked?: boolean; content: RichDocument; entryId: string; onChange: (document: RichDocument) => void;
}) {
  const change = useRef(onChange);
  change.current = onChange;
  const [error, setError] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState('');
  const [highlight, setHighlight] = useState('#fff59d');
  const [outline, setOutline] = useState(false);
  const [uploading, setUploading] = useState(false);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' } } }),
      TableKit.configure({ table: { resizable: true } }), Image.configure({ allowBase64: false }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TextStyleKit.configure({ lineHeight: false }), Highlight.configure({ multicolor: true }), RichSearch,
      GoogleFormatting, GoogleInline, GoogleBlock, PreserveGoogleObjects.configure({ enabled: googleLinked, onBlocked: () => setError('Cet élément est conservé dans Google. Pour le modifier ou le supprimer, utilise « Ouvrir dans Google Docs ».') }),
    ],
    content,
    shouldRerenderOnTransaction: true,
    editorProps: { attributes: { class: 'prose rich-content', role: 'textbox', 'aria-label': 'Contenu du document', 'aria-multiline': 'true', spellcheck: 'true' } },
    onUpdate: ({ editor: current }) => change.current(current.getJSON()),
  });
  useEffect(() => { editor?.setEditable(!disabled, false); }, [editor, disabled]);
  useEffect(() => {
    if (editor) setSearch(editor, { query: searchOpen ? query : '', caseSensitive, active: 0 });
  }, [editor, searchOpen, query, caseSensitive]);
  useEffect(() => { if (searchOpen) searchInput.current?.focus(); }, [searchOpen]);
  if (!editor) return null;

  const action = (label: string, run: () => void, active = false, disabled = false, face: ReactNode = label) => (
    <button type="button" title={label} aria-label={label} aria-pressed={active}
      disabled={disabled} className={active ? 'is-on' : ''}
      onMouseDown={event => event.preventDefault()} onClick={run}>{face}</button>
  );
  const applyLink = () => {
    if (!href.trim()) { editor.chain().focus().extendMarkRange('link').unsetLink().run(); setLinkOpen(false); return; }
    if (!/^(https?:\/\/|mailto:)/i.test(href.trim()) || /[\x00-\x20\x7f]/.test(href.trim())) { setError('Utilise un lien http, https ou mailto sans espace.'); return; }
    setError(''); setLinkOpen(false);
    editor.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run();
  };
  const addImage = async (file?: File) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) { setError('Choisis une image PNG, JPEG, WebP ou GIF.'); return; }
    setUploading(true);
    try {
      const saved = await api.upload(file, entryId);
      if (!editor.isDestroyed) editor.chain().focus().setImage({ src: api.fileUrl(saved.stored), alt: file.name }).run();
      setError('');
    } catch (e) { setError((e as Error).message); } finally { setUploading(false); }
  };
  const search = searchKey.getState(editor.state)!;
  const navigateMatch = (direction: number) => {
    if (!search.matches.length) return;
    const active = (search.active + direction + search.matches.length) % search.matches.length;
    setSearch(editor, { active });
    editor.chain().focus().setTextSelection(search.matches[active]).scrollIntoView().run();
  };
  const headings: { title: string; pos: number; end: number; level: number }[] = [];
  if (outline) editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') headings.push({ title: node.textContent || 'Titre vide', pos, end: pos + node.nodeSize - 1, level: node.attrs.level });
  });
  const textStyle = editor.getAttributes('textStyle');
  const fonts = Array.from(new Set(['Arial', 'Georgia', 'Verdana', 'Times New Roman', 'Courier New', 'monospace', ...(textStyle.fontFamily ? [textStyle.fontFamily as string] : [])]));
  const sizes = Array.from(new Set([...[8, 10, 11, 12, 14, 16, 18, 24, 32, 48, 72].map(size => `${size}pt`), ...(textStyle.fontSize ? [textStyle.fontSize as string] : [])]));
  const text = editor.getText();

  return <div className="rich-document" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && ['f', 'h'].includes(event.key.toLowerCase())) {
      event.preventDefault(); event.stopPropagation(); setSearchOpen(true); searchInput.current?.focus();
    }
    if (event.key === 'Escape') { setSearchOpen(false); setLinkOpen(false); editor.commands.focus(); }
  }}>
    <fieldset className="rich-controls" disabled={disabled}>
    <div className="rich-toolbar no-print" role="toolbar" aria-label="Mise en forme du document">
      <div className="rich-tools" role="group" aria-label="Historique et navigation">
        {action('Annuler', () => { editor.chain().focus().undo().run(); }, false, !editor.can().undo(), '↶')}
        {action('Rétablir', () => { editor.chain().focus().redo().run(); }, false, !editor.can().redo(), '↷')}
        {action('Rechercher et remplacer', () => { setSearchOpen(!searchOpen); }, searchOpen, false, 'Rechercher')}
        {action('Plan du document', () => setOutline(!outline), outline, false, 'Plan')}
      </div>
      <div className="rich-tools" role="group" aria-label="Style du texte">
        <select aria-label="Style du paragraphe" value={editor.isActive('heading') ? editor.getAttributes('heading').level : editor.getAttributes('paragraph').googleNamedStyle || 'paragraph'}
          onChange={e => {
            const value = e.target.value;
            if (['paragraph', 'TITLE', 'SUBTITLE'].includes(value)) editor.chain().focus().setParagraph().updateAttributes('paragraph', { googleNamedStyle: value === 'paragraph' ? null : value }).run();
            else editor.chain().setHeading({ level: Number(value) as 1 | 2 | 3 | 4 | 5 | 6 }).updateAttributes('heading', { googleNamedStyle: null }).run();
          }}>
          <option value="paragraph">Texte normal</option><option value="TITLE">Titre du document</option><option value="SUBTITLE">Sous-titre</option>{[1, 2, 3, 4, 5, 6].map(level => <option key={level} value={level}>Titre {level}</option>)}
        </select>
        <select aria-label="Police" value={textStyle.fontFamily || ''}
          onChange={e => e.target.value ? editor.chain().focus().setFontFamily(e.target.value).run() : editor.chain().focus().unsetFontFamily().run()}>
          <option value="">Police par défaut</option>{fonts.map(font => <option key={font}>{font}</option>)}
        </select>
        <select aria-label="Taille du texte" value={textStyle.fontSize || ''}
          onChange={e => e.target.value ? editor.chain().focus().setFontSize(e.target.value).run() : editor.chain().focus().unsetFontSize().run()}>
          <option value="">Taille</option>{sizes.map(size => <option key={size} value={size}>{size}</option>)}
        </select>
      </div>
      <div className="rich-tools" role="group" aria-label="Caractères">
        {action('Gras', () => { editor.chain().focus().toggleBold().run(); }, editor.isActive('bold'), false, <strong>G</strong>)}
        {action('Italique', () => { editor.chain().focus().toggleItalic().run(); }, editor.isActive('italic'), false, <em>I</em>)}
        {action('Souligné', () => { editor.chain().focus().toggleUnderline().run(); }, editor.isActive('underline'), false, <u>S</u>)}
        {action('Barré', () => { editor.chain().focus().toggleStrike().run(); }, editor.isActive('strike'), false, <s>B</s>)}
        {action('Code en ligne', () => { editor.chain().focus().toggleCode().run(); }, editor.isActive('code'), false, '< >')}
        <label className="rich-color" title="Couleur du texte">A<input type="color" aria-label="Couleur du texte"
          value={/^#[\da-f]{6}$/i.test(textStyle.color || '') ? textStyle.color : '#222222'} onChange={e => editor.chain().focus().setColor(e.target.value).run()} /></label>
        {action('Surligner', () => { editor.chain().focus().toggleHighlight({ color: highlight }).run(); }, editor.isActive('highlight'), false, '▨')}
        <label className="rich-color" title="Couleur du surlignage"><input type="color" aria-label="Couleur du surlignage" value={highlight}
          onChange={e => { setHighlight(e.target.value); editor.chain().focus().setHighlight({ color: e.target.value }).run(); }} /></label>
        {action('Effacer la mise en forme', () => { editor.chain().focus().unsetAllMarks().clearNodes().unsetTextAlign().run(); }, false, false, '⌫')}
      </div>
      <div className="rich-tools" role="group" aria-label="Paragraphes et listes">
        {action('Liste à puces', () => { editor.chain().focus().toggleBulletList().run(); }, editor.isActive('bulletList'), false, '•')}
        {action('Liste numérotée', () => { editor.chain().focus().toggleOrderedList().run(); }, editor.isActive('orderedList'), false, '1.')}
        {action('Augmenter le retrait de liste', () => { editor.chain().focus().sinkListItem('listItem').run(); }, false, !editor.can().sinkListItem('listItem'), '→')}
        {action('Diminuer le retrait de liste', () => { editor.chain().focus().liftListItem('listItem').run(); }, false, !editor.can().liftListItem('listItem'), '←')}
        {(['left', 'center', 'right', 'justify'] as const).map((align, i) => <span key={align}>{action(['Gauche', 'Centrer', 'Droite', 'Justifier'][i], () => { editor.chain().focus().setTextAlign(align).run(); }, editor.isActive({ textAlign: align }), false, ['⇤', '↔', '⇥', '≡'][i])}</span>)}
      </div>
      <div className="rich-tools" role="group" aria-label="Insérer">
        {action('Lien', () => { setHref(editor.getAttributes('link').href || ''); setLinkOpen(!linkOpen); }, editor.isActive('link'), false, '🔗')}
        {action('Citation', () => { editor.chain().focus().toggleBlockquote().run(); }, editor.isActive('blockquote'), false, '❝')}
        {action('Bloc de code', () => { editor.chain().focus().toggleCodeBlock().run(); }, editor.isActive('codeBlock'), false, '{ }')}
        {action('Séparateur', () => { editor.chain().focus().setHorizontalRule().run(); }, false, false, '—')}
        {action('Tableau', () => { editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); }, false, false, '▦')}
        <label className="ghost file-button">{uploading ? 'Envoi…' : 'Image'}<input type="file" aria-label="Insérer une image" accept="image/png,image/jpeg,image/webp,image/gif" disabled={uploading}
          onChange={e => { void addImage(e.target.files?.[0]); e.target.value = ''; }} /></label>
      </div>
    </div>
    {editor.isActive('table') && <div className="rich-context no-print" role="toolbar" aria-label="Modifier le tableau">
      <strong>Tableau</strong>
      {action('Ligne avant', () => { editor.chain().focus().addRowBefore().run(); })}
      {action('Ajouter une ligne', () => { editor.chain().focus().addRowAfter().run(); }, false, false, 'Ligne après')}
      {action('Supprimer la ligne', () => { editor.chain().focus().deleteRow().run(); })}
      {action('Colonne avant', () => { editor.chain().focus().addColumnBefore().run(); })}
      {action('Ajouter une colonne', () => { editor.chain().focus().addColumnAfter().run(); }, false, false, 'Colonne après')}
      {action('Supprimer la colonne', () => { editor.chain().focus().deleteColumn().run(); })}
      {action('Fusionner les cellules', () => { editor.chain().focus().mergeCells().run(); }, false, !editor.can().mergeCells())}
      {action('Scinder la cellule', () => { editor.chain().focus().splitCell().run(); }, false, !editor.can().splitCell())}
      {action('En-tête de ligne', () => { editor.chain().focus().toggleHeaderRow().run(); })}
      {action('En-tête de colonne', () => { editor.chain().focus().toggleHeaderColumn().run(); })}
      {action('Supprimer le tableau', () => { editor.chain().focus().deleteTable().run(); })}
    </div>}
    {editor.isActive('image') && <div className="rich-context no-print" role="group" aria-label="Modifier l’image">
      <label>Description de l’image<input value={editor.getAttributes('image').alt || ''} maxLength={1000}
        onChange={e => editor.commands.updateAttributes('image', { alt: e.target.value })} /></label>
      <label>Largeur de l’image (px)<input type="number" min={1} max={10000} value={editor.getAttributes('image').width || ''}
        onChange={e => { const width = Number(e.target.value); if (!e.target.value || (Number.isInteger(width) && width > 0 && width <= 10000)) editor.commands.updateAttributes('image', { width: width || null, height: null }); }} /></label>
      {action('Taille originale', () => { editor.chain().focus().updateAttributes('image', { width: null, height: null }).run(); })}
    </div>}
    {linkOpen && <form className="rich-context no-print" aria-label="Insérer un lien" onSubmit={event => { event.preventDefault(); applyLink(); }}>
      <label>Adresse du lien<input autoFocus placeholder="https://… ou mailto:…" value={href} onChange={e => setHref(e.target.value)} /></label>
      <button type="submit">Appliquer le lien</button>
      <button type="button" onClick={() => { editor.chain().focus().extendMarkRange('link').unsetLink().run(); setLinkOpen(false); }}>Retirer le lien</button>
      <button type="button" onClick={() => { setLinkOpen(false); editor.commands.focus(); }}>Fermer</button>
    </form>}
    {searchOpen && <div className="rich-search no-print" role="search" aria-label="Rechercher dans le document">
      <div className="rich-context">
        <label>Rechercher<input ref={searchInput} value={query} onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); navigateMatch(e.shiftKey ? -1 : 1); } }} /></label>
        <label className="rich-checkbox"><input type="checkbox" checked={caseSensitive} onChange={e => setCaseSensitive(e.target.checked)} />Respecter la casse</label>
        <output aria-live="polite">{search.matches.length ? `${search.active + 1} / ${search.matches.length}` : '0 résultat'}{search.truncated ? ' — affine la recherche (plus de 2 000 résultats)' : ''}</output>
        {action('Résultat précédent', () => navigateMatch(-1), false, !search.matches.length, '↑')}
        {action('Résultat suivant', () => navigateMatch(1), false, !search.matches.length, '↓')}
        <button onClick={() => { setSearchOpen(false); editor.commands.focus(); }}>Fermer la recherche</button>
      </div>
      <div className="rich-context">
        <label>Remplacer par<input value={replacement} onChange={e => setReplacement(e.target.value)} /></label>
        <button disabled={!search.matches.length} onClick={() => replaceMatches(editor, replacement)}>Remplacer</button>
        <button disabled={!search.matches.length || search.truncated} onClick={() => replaceMatches(editor, replacement, true)}>Tout remplacer</button>
      </div>
    </div>}
    {outline && <nav className="rich-outline no-print" aria-label="Plan du document">
      <strong>Plan du document</strong>
      {!headings.length && <p>Applique un style Titre pour construire le plan.</p>}
      {headings.map(heading => <button key={heading.pos} data-level={heading.level}
        onClick={() => {
          // Synchroniser le focus avant la sélection : sinon une touche End peut
          // déplacer la sélection DOM sans que ProseMirror ne quitte l'ancien titre.
          editor.view.focus();
          // Placer directement le curseur en fin de titre rend un éventuel
          // `End` natif idempotent, même si selectionchange est retardé.
          editor.chain().setTextSelection(heading.end).scrollIntoView().run();
        }}>{heading.title}</button>)}
    </nav>}
    {error && <p className="error no-print" role="alert">{error}</p>}
    </fieldset>
    <EditorContent editor={editor} />
    <p className="rich-count no-print">{text.trim().split(/\s+/).filter(Boolean).length} mot(s) · {Array.from(text).length} caractère(s) · sauvegarde locale automatique</p>
  </div>;
}
