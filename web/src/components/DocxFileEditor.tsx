import { useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import { docxImages, docxProblems, normalizeDocx, readDocxDocument, writeDocx, type DocxDocument, type DocxDraft } from '../docx';
import { docxExtensions } from '../docx-extensions';
import { docxFromAi, docxPreview, docxToAi } from '../docx-markdown';
import { toBase64 } from '../docx-preview';
import { FormatError, type FileEditorHandle, type FileEditorProps } from '../file-formats';
import { imageMime } from '../file-preview';
import { imageSize } from '../image-size';

const ALIGNMENTS: { value: string | null; label: string; icon: string }[] = [
  { value: null, label: 'Aligner à gauche', icon: '⯇' },
  { value: 'center', label: 'Centrer', icon: '≡' },
  { value: 'right', label: 'Aligner à droite', icon: '⯈' },
  { value: 'justify', label: 'Justifier', icon: '☰' },
];

/** Le paragraphe Word sous le curseur, et sa position. */
function currentParagraph(editor: Editor) {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === 'docxParagraph') return { node, pos: $from.before(depth) };
  }
  return null;
}

// Le brouillon garde les images insérées : il doit tenir sous `MAX_DRAFT` (api/src/shared-service.js).
const DRAFT_BUDGET = 4 * 1024 * 1024;
const WORD_IMAGES = ['image/png', 'image/jpeg', 'image/gif'];

/** Insère une image (fichier choisi ou collé) à la place de la sélection ; renvoie l'erreur à afficher, ou `''`. */
async function insertImage(view: EditorView, file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = imageMime(bytes);
  if (!mime || !WORD_IMAGES.includes(mime)) return `« ${file.name} » : seules les images PNG, JPEG ou GIF s’insèrent dans un document Word.`;
  if (!imageSize(bytes)) return `« ${file.name} » : image illisible.`;
  const src = `data:${mime};base64,${toBase64(bytes)}`;
  if (JSON.stringify(view.state.doc.toJSON()).length + src.length > DRAFT_BUDGET) {
    return 'Image trop lourde pour le brouillon (3 Mo d’images en attente au plus) : enregistre sur le partage avant d’en ajouter une autre, ou réduis-la.';
  }
  const node = view.state.schema.nodes.docxImage.create({ src, name: file.name });
  view.dispatch(view.state.tr.replaceSelectionWith(node));
  view.focus();
  return '';
}

function setParagraphAttrs(editor: Editor, attrs: Record<string, unknown>) {
  const { from, to } = editor.state.selection;
  let tr = editor.state.tr;
  let changed = false;
  editor.state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name !== 'docxParagraph') return true;
    tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs });
    changed = true;
    return false;
  });
  if (changed) editor.view.dispatch(tr);
}

/**
 * `.docx` du dossier partagé. On édite le texte, les styles de paragraphe,
 * l'alignement, le niveau des listes, le gras/italique/souligné/barré, on insère
 * des images ; tout le reste du document Word est conservé tel quel (ses images
 * affichées). À l'envoi, seuls les paragraphes modifiés sont réécrits (`docx.ts`).
 */
export function DocxFileEditor({ bytes, initialDraft, readOnly, onEdit, handleRef, author }: FileEditorProps) {
  const [loaded, setLoaded] = useState<{ document: DocxDocument; images: Map<string, string[]> } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    readDocxDocument(bytes)
      .then(async (document) => ({ document, images: await docxImages(document) }))
      .then((result) => { if (alive) setLoaded(result); }, (e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [bytes]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!loaded) return <p className="empty">Lecture du document…</p>;
  return <DocxEditorBody document={loaded.document} images={loaded.images} bytes={bytes} initialDraft={initialDraft} readOnly={readOnly} onEdit={onEdit} handleRef={handleRef} author={author} />;
}

function DocxEditorBody({ document, images, bytes, initialDraft, readOnly, onEdit, handleRef, author }: Omit<FileEditorProps, 'name'> & { document: DocxDocument; images: Map<string, string[]> }) {
  const saved = initialDraft as DocxDraft | null;
  const extensions = useMemo(() => docxExtensions(document.numbering, images), [document, images]);
  const lockedReason = document.readOnly ?? readOnly;
  const [imageError, setImageError] = useState('');
  const editor = useEditor({
    extensions,
    content: saved?.format === 'docx' && saved.doc ? saved.doc : document.doc,
    editable: !lockedReason,
    immediatelyRender: true,
    editorProps: {
      attributes: { class: 'docx-page', 'aria-label': 'Contenu du document Word', role: 'textbox', 'aria-multiline': 'true' },
      // Une capture d'écran collée devient une image du document. Du texte copié depuis
      // Word ou Excel arrive avec une image de la sélection : c'est alors le texte qui se colle.
      handlePaste: (view, event) => {
        const file = Array.from(event.clipboardData?.files ?? []).find((candidate) => candidate.type.startsWith('image/'));
        if (!file || event.clipboardData?.getData('text/plain') || !view.editable) return false;
        void insertImage(view, file).then(setImageError);
        return true;
      },
    },
    // Seule une transaction qui change le document est une modification.
    onUpdate: ({ transaction }) => { if (transaction.docChanged) onEdit(); },
  }, [extensions]);

  useEffect(() => {
    // `false` : basculer en lecture seule n'est pas une modification (Tiptap en émettrait une).
    editor?.setEditable(!lockedReason, false);
  }, [editor, lockedReason]);

  useImperativeHandle(handleRef, (): FileEditorHandle => ({
    isDirty: () => Boolean(editor) && JSON.stringify(normalizeDocx(editor!.getJSON())) !== JSON.stringify(document.doc),
    draft: (): DocxDraft => ({ format: 'docx', v: 1, doc: editor!.getJSON() as JSONContent }),
    problems: () => (document.readOnly ? [document.readOnly] : editor ? docxProblems(document, editor.getJSON()) : []),
    serialize: () => writeDocx(bytes, editor!.getJSON(), { author: author || 'WorkLogs' }),
    ai: {
      format: 'word',
      begin: (mode) => {
        if (document.readOnly) throw new FormatError(document.readOnly);
        const source = docxToAi(editor!.getJSON(), document, { procedure: mode === 'procedure' });
        return {
          text: source.markdown,
          title: source.title,
          prepare: (answer) => {
            const doc = docxFromAi(answer, source);
            // Une transaction de l'éditeur : comptée comme une frappe (brouillon, verrou), annulable par ↶.
            return { preview: docxPreview(doc, document), previewFormat: 'markdown', warning: '', apply: () => { editor!.commands.setContent(doc); } };
          },
        };
      },
    },
  }), [editor, document, bytes, author]);

  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      if (!current) return null;
      const paragraph = currentParagraph(current);
      return {
        bold: current.isActive('bold'),
        italic: current.isActive('italic'),
        underline: current.isActive('underline'),
        strike: current.isActive('strike'),
        styleId: (paragraph?.node.attrs.styleId as string | null) ?? '',
        align: (paragraph?.node.attrs.align as string | null) ?? null,
        list: Boolean(paragraph?.node.attrs.numId),
        ilvl: Number(paragraph?.node.attrs.ilvl ?? 0),
        canUndo: current.can().undo(),
        canRedo: current.can().redo(),
      };
    },
  });

  // Styles proposés : ceux du document (titres, normal, ceux déjà utilisés).
  const used = useMemo(() => {
    const ids = new Set<string>();
    document.doc.content?.forEach((node) => { if (node.attrs?.styleId) ids.add(String(node.attrs.styleId)); });
    return document.styles.filter((style) => style.level > 0 || ids.has(style.id) || style.label === 'Normal');
  }, [document]);
  const levelOf = (styleId: string) => document.styles.find((style) => style.id === styleId)?.level ?? 0;

  if (!editor) return null;
  const disabled = Boolean(lockedReason);
  const toggle = (mark: 'bold' | 'italic' | 'underline' | 'strike') => editor.chain().focus().toggleMark(mark).run();
  const indent = (delta: number) => {
    const paragraph = currentParagraph(editor);
    if (!paragraph?.node.attrs.numId) return;
    setParagraphAttrs(editor, { ilvl: Math.max(0, Math.min(8, Number(paragraph.node.attrs.ilvl ?? 0) + delta)) });
  };

  return (
    <div className="docx-editor">
      <div className="docx-toolbar no-print" role="toolbar" aria-label="Mise en forme du document Word">
        <select
          aria-label="Style du paragraphe"
          disabled={disabled}
          value={state?.styleId ?? ''}
          onChange={(event) => setParagraphAttrs(editor, { styleId: event.target.value || null, level: levelOf(event.target.value) })}
        >
          <option value="">Normal</option>
          {used.filter((style) => style.label !== 'Normal').map((style) => <option key={style.id} value={style.id}>{style.label}</option>)}
          {state?.styleId && !used.some((style) => style.id === state.styleId) && <option value={state.styleId}>{state.styleId}</option>}
        </select>
        <span className="docx-group">
          <button type="button" className={state?.bold ? 'is-on' : ''} aria-pressed={Boolean(state?.bold)} aria-label="Gras" disabled={disabled} onClick={() => toggle('bold')}><b>G</b></button>
          <button type="button" className={state?.italic ? 'is-on' : ''} aria-pressed={Boolean(state?.italic)} aria-label="Italique" disabled={disabled} onClick={() => toggle('italic')}><i>I</i></button>
          <button type="button" className={state?.underline ? 'is-on' : ''} aria-pressed={Boolean(state?.underline)} aria-label="Souligné" disabled={disabled} onClick={() => toggle('underline')}><u>S</u></button>
          <button type="button" className={state?.strike ? 'is-on' : ''} aria-pressed={Boolean(state?.strike)} aria-label="Barré" disabled={disabled} onClick={() => toggle('strike')}><s>B</s></button>
        </span>
        <span className="docx-group">
          {ALIGNMENTS.map((alignment) => (
            <button
              key={alignment.label}
              type="button"
              className={(state?.align ?? null) === alignment.value ? 'is-on' : ''}
              aria-pressed={(state?.align ?? null) === alignment.value}
              aria-label={alignment.label}
              disabled={disabled}
              onClick={() => setParagraphAttrs(editor, { align: alignment.value })}
            >
              {alignment.icon}
            </button>
          ))}
        </span>
        {state?.list && (
          <span className="docx-group">
            <button type="button" aria-label="Diminuer le niveau de liste" disabled={disabled || !state.ilvl} onClick={() => indent(-1)}>⇤</button>
            <button type="button" aria-label="Augmenter le niveau de liste" disabled={disabled || state.ilvl >= 8} onClick={() => indent(1)}>⇥</button>
          </span>
        )}
        <label className="ghost file-button" title="Insérer une image (PNG, JPEG ou GIF) à la place du curseur ; une capture collée s’insère aussi">
          Image
          <input
            type="file"
            aria-label="Insérer une image"
            accept="image/png,image/jpeg,image/gif"
            disabled={disabled}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void insertImage(editor.view, file).then(setImageError);
            }}
          />
        </label>
        <span className="grow" />
        <span className="docx-group">
          <button type="button" aria-label="Annuler" disabled={disabled || !state?.canUndo} onClick={() => editor.chain().focus().undo().run()}>↶</button>
          <button type="button" aria-label="Rétablir" disabled={disabled || !state?.canRedo} onClick={() => editor.chain().focus().redo().run()}>↷</button>
        </span>
      </div>
      {document.readOnly && <p className="notice">{document.readOnly}</p>}
      {imageError && <p className="error no-print" role="alert">{imageError}</p>}
      <p className="docx-hint no-print">Seuls les paragraphes modifiés seront réécrits ; images d’origine, champs, tables des matières, en-têtes et pieds de page restent ceux du fichier.</p>
      <EditorContent editor={editor} className="docx-content prose" />
    </div>
  );
}
