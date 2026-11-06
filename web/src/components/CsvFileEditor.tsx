import { useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { csvDraft, gridFromCsv, isCsvUnchanged, parseCsvFile, serializeCsv, type CsvDraft, type CsvGridRow } from '../csv-file';
import { ENCODING_LABELS, encodingProblem, type TextEncodingName } from '../text-codec';
import type { FileEditorProps } from '../file-formats';
import { SheetGrid, type CellEdit } from './SheetGrid';

const DELIMITERS: Record<string, string> = { ';': 'point-virgule', ',': 'virgule', '\t': 'tabulation', '|': 'barre verticale' };
const MAX_UNDO = 100;

/**
 * `.csv` et `.tsv` du dossier partagé, dans la grille. Chaque ligne garde son
 * origine : une ligne intacte ressort à l'identique, une ligne modifiée est
 * réécrite avec le séparateur et les guillemets du fichier.
 */
export function CsvFileEditor({ name, bytes, initialDraft, readOnly, onEdit, handleRef }: FileEditorProps) {
  const parsed = useMemo(() => parseCsvFile(bytes, name), [bytes, name]);
  const saved = initialDraft as CsvDraft | null;
  const [rows, setRows] = useState<CsvGridRow[]>(() => gridFromCsv(parsed, saved));
  const [encoding, setEncoding] = useState<TextEncodingName>(() => (saved?.format === 'csv' && saved.encoding in ENCODING_LABELS ? saved.encoding : parsed.encoding));
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const undo = useRef<CsvGridRow[][]>([]);
  const redo = useRef<CsvGridRow[][]>([]);

  useImperativeHandle(handleRef, () => ({
    isDirty: () => encoding !== parsed.encoding || !isCsvUnchanged(parsed, rows),
    draft: () => csvDraft(parsed, rows, encoding),
    problems: () => {
      const problem = encodingProblem(rows.map((row) => row.fields.join('\t')).join('\n'), encoding);
      return problem ? [problem] : [];
    },
    serialize: async () => serializeCsv(parsed, rows, encoding),
  }), [parsed, rows, encoding]);

  const colCount = useMemo(() => {
    let widest = 1;
    for (const row of rows) if (row.fields.length > widest) widest = row.fields.length;
    return widest;
  }, [rows]);

  const change = useCallback((next: CsvGridRow[]) => {
    rowsRef.current = next;
    setRows(next);
    onEdit();
  }, [onEdit]);

  /** Un état par geste : la barre de saisie n'en garde qu'un pour toute sa frappe. */
  const remember = useCallback(() => {
    const current = rowsRef.current;
    if (undo.current[undo.current.length - 1] === current) return;
    undo.current.push(current);
    if (undo.current.length > MAX_UNDO) undo.current.shift();
    redo.current = [];
  }, []);

  const setCells = (edits: CellEdit[]) => {
    const next = rowsRef.current.slice();
    let changed = false;
    for (const { row, col, value } of edits) {
      while (next.length <= row) next.push({ src: null, fields: [] });
      const current = next[row];
      if ((current.fields[col] ?? '') === value) continue;
      const fields = current.fields.slice();
      while (fields.length <= col) fields.push('');
      fields[col] = value;
      next[row] = { ...current, fields };
      changed = true;
    }
    if (changed) change(next);
  };

  const travel = (from: { current: CsvGridRow[][] }, to: { current: CsvGridRow[][] }) => {
    const previous = from.current.pop();
    if (!previous) return;
    to.current.push(rowsRef.current);
    change(previous);
  };

  return (
    <div className="shared-sheet">
      <div className="shared-tools no-print">
        <span className="shared-meta">
          Séparateur : {DELIMITERS[parsed.delimiter] ?? parsed.delimiter} · {rows.length} ligne{rows.length > 1 ? 's' : ''}
        </span>
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
      <SheetGrid
        label={`Tableau ${name}`}
        rowCount={rows.length}
        colCount={colCount}
        getCell={(row, col) => rows[row]?.fields[col] ?? ''}
        readOnly={Boolean(readOnly)}
        onBeginEdit={remember}
        onSetCells={setCells}
        onInsertRow={(after) => {
          const next = rowsRef.current.slice();
          next.splice(after + 1, 0, { src: null, fields: [] });
          change(next);
        }}
        onDeleteRow={(row) => {
          const next = rowsRef.current.slice();
          next.splice(row, 1);
          change(next);
        }}
        onInsertColumn={(after) => change(rowsRef.current.map((row) => {
          if (row.fields.length <= after) return row;
          const fields = row.fields.slice();
          fields.splice(after + 1, 0, '');
          return { ...row, fields };
        }))}
        onDeleteColumn={(col) => change(rowsRef.current.map((row) => {
          if (row.fields.length <= col) return row;
          const fields = row.fields.slice();
          fields.splice(col, 1);
          return { ...row, fields };
        }))}
        onUndo={() => travel(undo, redo)}
        onRedo={() => travel(redo, undo)}
      />
    </div>
  );
}
