import { useImperativeHandle, useMemo, useState } from 'react';
import { renderMarkdown } from '../markdown';
import { parseTextFile, serializeTextFile, type TextDraft } from '../text-file';
import { ENCODING_LABELS, encodingProblem, type TextEncodingName } from '../text-codec';
import type { FileEditorHandle, FileEditorProps } from '../file-formats';

/**
 * `.txt` et `.md` du dossier partagé. Le texte s'édite avec des `\n` ; le fichier
 * garde son encodage et ses fins de ligne. Un `.md` se relit comme une entrée.
 */
export function TextFileEditor({ name, bytes, initialDraft, readOnly, onEdit, handleRef, markdown }: FileEditorProps & { markdown: boolean }) {
  const parsed = useMemo(() => parseTextFile(bytes), [bytes]);
  const saved = initialDraft as TextDraft | null;
  const [text, setText] = useState(() => (saved?.format === 'text' && typeof saved.text === 'string' ? saved.text : parsed.text));
  const [encoding, setEncoding] = useState<TextEncodingName>(() => (saved?.format === 'text' && saved.encoding in ENCODING_LABELS ? saved.encoding : parsed.encoding));
  const [reading, setReading] = useState(false);

  const change = (next: string) => {
    setText(next);
    onEdit();
  };

  useImperativeHandle(handleRef, (): FileEditorHandle => ({
    isDirty: () => text !== parsed.text || encoding !== parsed.encoding,
    draft: (): TextDraft => ({ format: 'text', text, encoding }),
    problems: () => {
      const problem = encodingProblem(text, encoding);
      return problem ? [problem] : [];
    },
    serialize: async () => serializeTextFile(parsed, text, encoding),
    ai: {
      format: markdown ? 'markdown' : 'text',
      begin: (mode) => {
        // Suggestion dans un `.md` titré (`# Titre` en tête) : le titre reste, l'IA écrit la suite.
        const heading = markdown && mode === 'procedure' ? /^\s*#[ \t]+([^\n]*\S)[ \t]*(?:\n|$)/.exec(text) : null;
        const head = heading ? heading[0].trimEnd() : '';
        return {
          text: (heading ? text.slice(heading[0].length) : text).trim(),
          title: heading ? heading[1].trim() : '',
          prepare: (answer) => {
            const next = (head ? `${head}\n\n${answer.trim()}` : answer.trim()) + (text.endsWith('\n') ? '\n' : '');
            return {
              preview: next,
              previewFormat: markdown ? 'markdown' : 'text',
              warning: encodingProblem(next, encoding) ?? '',
              apply: () => change(next),
            };
          },
        };
      },
    },
  }), [parsed, text, encoding, markdown, onEdit]);

  return (
    <div className="shared-text">
      <div className="shared-tools no-print">
        {markdown && (
          <div className="modes" role="group" aria-label="Mode d’affichage">
            <button className={reading ? '' : 'is-on'} aria-pressed={!reading} onClick={() => setReading(false)}>Écrire</button>
            <button className={reading ? 'is-on' : ''} aria-pressed={reading} onClick={() => setReading(true)}>Lire</button>
          </div>
        )}
        <label className="shared-encoding">
          Encodage
          <select
            aria-label="Encodage du fichier"
            value={encoding}
            disabled={Boolean(readOnly)}
            onChange={(event) => {
              setEncoding(event.target.value as TextEncodingName);
              onEdit();
            }}
          >
            {Object.entries(ENCODING_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
      {markdown && reading ? (
        // `renderMarkdown` passe par DOMPurify, comme l'aperçu des entrées.
        <article className="prose" aria-label="Aperçu" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
      ) : (
        <textarea
          className="source"
          aria-label={`Contenu de ${name}`}
          value={text}
          readOnly={Boolean(readOnly)}
          spellCheck={markdown}
          onChange={(event) => change(event.target.value)}
        />
      )}
    </div>
  );
}
