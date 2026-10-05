import { useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import { docxProblems, normalizeDocx, readDocxDocument, writeDocx, type DocxDocument, type DocxDraft } from '../docx';
import { docxExtensions } from '../docx-extensions';
import type { FileEditorProps } from '../file-formats';

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
 * l'alignement, le niveau des listes, le gras/italique/souligné/barré ; tout le
 * reste du document Word est conservé tel quel. À l'envoi, seuls les paragraphes
 * modifiés sont réécrits (`docx.ts`).
 */
export function DocxFileEditor({ bytes, initialDraft, readOnly, onEdit, handleRef, author }: FileEditorProps) {
  const [document, setDocument] = useState<DocxDocument | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    readDocxDocument(bytes).then((loaded) => { if (alive) setDocument(loaded); }, (e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [bytes]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!document) return <p className="empty">Lecture du document…</p>;
  return <DocxEditorBody document={document} bytes={bytes} initialDraft={initialDraft} readOnly={readOnly} onEdit={onEdit} handleRef={handleRef} author={author} />;
}

function DocxEditorBody({ document, bytes, initialDraft, readOnly, onEdit, handleRef, author }: Omit<FileEditorProps, 'name'> & { document: DocxDocument }) {
  const saved = initialDraft as DocxDraft | null;
  const extensions = useMemo(() => docxExtensions(document.numbering), [document]);
  const lockedReason = document.readOnly ?? readOnly;
  const editor = useEditor({
    extensions,
    content: saved?.format === 'docx' && saved.doc ? saved.doc : document.doc,
    editable: !lockedReason,
    immediatelyRender: true,
    editorProps: { attributes: { class: 'docx-page', 'aria-label': 'Contenu du document Word', role: 'textbox', 'aria-multiline': 'true' } },
    // Seule une transaction qui change le document est une modification.
    onUpdate: ({ transaction }) => { if (transaction.docChanged) onEdit(); },
  }, [extensions]);

  useEffect(() => {
    // `false` : basculer en lecture seule n'est pas une modification (Tiptap en émettrait une).
    editor?.setEditable(!lockedReason, false);
  }, [editor, lockedReason]);

  useImperativeHandle(handleRef, () => ({
    isDirty: () => Boolean(editor) && JSON.stringify(normalizeDocx(editor!.getJSON())) !== JSON.stringify(document.doc),
    draft: (): DocxDraft => ({ format: 'docx', v: 1, doc: editor!.getJSON() as JSONContent }),
    problems: () => (document.readOnly ? [document.readOnly] : editor ? docxProblems(document, editor.getJSON()) : []),
    serialize: () => writeDocx(bytes, editor!.getJSON(), { author: author || 'WorkLogs' }),
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
        <span className="grow" />
        <span className="docx-group">
          <button type="button" aria-label="Annuler" disabled={disabled || !state?.canUndo} onClick={() => editor.chain().focus().undo().run()}>↶</button>
          <button type="button" aria-label="Rétablir" disabled={disabled || !state?.canRedo} onClick={() => editor.chain().focus().redo().run()}>↷</button>
        </span>
      </div>
      {document.readOnly && <p className="notice">{document.readOnly}</p>}
      <p className="docx-hint no-print">Seuls les paragraphes modifiés seront réécrits ; images, champs, tables des matières, en-têtes et pieds de page restent ceux du fichier.</p>
      <EditorContent editor={editor} className="docx-content prose" />
    </div>
  );
}
