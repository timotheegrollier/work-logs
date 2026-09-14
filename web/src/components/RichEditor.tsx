import { useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyleKit } from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import { api, type RichDocument } from '../lib';

export function RichEditor({ content, entryId, onChange }: {
  content: RichDocument; entryId: string; onChange: (document: RichDocument) => void;
}) {
  const change = useRef(onChange);
  change.current = onChange;
  const [error, setError] = useState('');
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' } } }),
      TableKit.configure({ table: { resizable: false } }), Image.configure({ allowBase64: false }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TextStyleKit.configure({ lineHeight: false }), Highlight.configure({ multicolor: true }),
    ],
    content,
    shouldRerenderOnTransaction: true,
    editorProps: { attributes: { class: 'prose rich-content', role: 'textbox', 'aria-label': 'Contenu du document', 'aria-multiline': 'true' } },
    onUpdate: ({ editor: current }) => change.current(current.getJSON()),
  });
  if (!editor) return null;

  const action = (label: string, run: () => void, active = false, disabled = false) => (
    <button type="button" title={label} aria-label={label} aria-pressed={active}
      disabled={disabled} className={active ? 'is-on' : ''}
      onMouseDown={(event) => event.preventDefault()} onClick={run}>{label}</button>
  );
  const setLink = () => {
    const href = window.prompt('Adresse du lien (https://…)', editor.getAttributes('link').href || '');
    if (href === null) return;
    if (!href.trim()) { editor.chain().focus().extendMarkRange('link').unsetLink().run(); return; }
    if (!/^(https?:\/\/|mailto:)/i.test(href.trim())) { setError('Utilise un lien http, https ou mailto.'); return; }
    setError('');
    editor.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run();
  };
  const addImage = async (file?: File) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) { setError('Choisis une image PNG, JPEG, WebP ou GIF.'); return; }
    try {
      const saved = await api.upload(file, entryId);
      if (!editor.isDestroyed) editor.chain().focus().setImage({ src: api.fileUrl(saved.stored), alt: file.name }).run();
      setError('');
    } catch (e) { setError((e as Error).message); }
  };

  return <div className="rich-document">
    <div className="rich-toolbar no-print" role="toolbar" aria-label="Mise en forme du document">
      <select aria-label="Style du paragraphe" value={editor.isActive('heading') ? editor.getAttributes('heading').level : 'paragraph'}
        onChange={(e) => e.target.value === 'paragraph' ? editor.chain().focus().setParagraph().run()
          : editor.chain().focus().setHeading({ level: Number(e.target.value) as 1 | 2 | 3 }).run()}>
        <option value="paragraph">Texte normal</option><option value="1">Titre 1</option><option value="2">Titre 2</option><option value="3">Titre 3</option>
      </select>
      <select aria-label="Police" value={editor.getAttributes('textStyle').fontFamily || ''}
        onChange={(e) => e.target.value ? editor.chain().focus().setFontFamily(e.target.value).run() : editor.chain().focus().unsetFontFamily().run()}>
        <option value="">Police par défaut</option><option value="Arial">Arial</option><option value="Georgia">Georgia</option><option value="monospace">Monospace</option>
      </select>
      <select aria-label="Taille du texte" value={editor.getAttributes('textStyle').fontSize || ''}
        onChange={(e) => e.target.value ? editor.chain().focus().setFontSize(e.target.value).run() : editor.chain().focus().unsetFontSize().run()}>
        <option value="">Taille</option>{[10, 12, 14, 18, 24, 32].map(size => <option key={size} value={`${size}pt`}>{size}</option>)}
      </select>
      {action('Gras', () => { editor.chain().focus().toggleBold().run(); }, editor.isActive('bold'))}
      {action('Italique', () => { editor.chain().focus().toggleItalic().run(); }, editor.isActive('italic'))}
      {action('Souligné', () => { editor.chain().focus().toggleUnderline().run(); }, editor.isActive('underline'))}
      {action('Barré', () => { editor.chain().focus().toggleStrike().run(); }, editor.isActive('strike'))}
      <label className="rich-color" title="Couleur du texte">A<input type="color" aria-label="Couleur du texte"
        value={editor.getAttributes('textStyle').color || '#222222'} onChange={(e) => editor.chain().focus().setColor(e.target.value).run()} /></label>
      {action('Surligner', () => { editor.chain().focus().toggleHighlight({ color: '#fff59d' }).run(); }, editor.isActive('highlight'))}
      {action('Lien', setLink, editor.isActive('link'))}
      {action('Liste à puces', () => { editor.chain().focus().toggleBulletList().run(); }, editor.isActive('bulletList'))}
      {action('Liste numérotée', () => { editor.chain().focus().toggleOrderedList().run(); }, editor.isActive('orderedList'))}
      {(['left', 'center', 'right', 'justify'] as const).map((align, i) => <span key={align}>{action(['Gauche', 'Centrer', 'Droite', 'Justifier'][i], () => { editor.chain().focus().setTextAlign(align).run(); }, editor.isActive({ textAlign: align }))}</span>)}
      {action('Tableau', () => { editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); })}
      {editor.isActive('table') && <>
        {action('Ajouter une ligne', () => { editor.chain().focus().addRowAfter().run(); })}
        {action('Ajouter une colonne', () => { editor.chain().focus().addColumnAfter().run(); })}
        {action('Supprimer le tableau', () => { editor.chain().focus().deleteTable().run(); })}
      </>}
      <label className="ghost file-button">Image<input type="file" aria-label="Insérer une image" accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={(e) => { void addImage(e.target.files?.[0]); e.target.value = ''; }} /></label>
      {action('Annuler', () => { editor.chain().focus().undo().run(); }, false, !editor.can().undo())}
      {action('Rétablir', () => { editor.chain().focus().redo().run(); }, false, !editor.can().redo())}
    </div>
    {error && <p className="error no-print" role="alert">{error}</p>}
    <EditorContent editor={editor} />
    <p className="rich-count no-print">{editor.getText().trim().split(/\s+/).filter(Boolean).length} mot(s) · sauvegarde locale automatique</p>
  </div>;
}
