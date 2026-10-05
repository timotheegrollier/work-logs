import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  cellRef, cellView, effectiveEdits, gridSize, GRID_LIMITS, readXlsxWorkbook, writeXlsx, xlsxProblems,
  type XlsxDraft, type XlsxEdits, type XlsxWorkbook,
} from '../xlsx';
import type { FileEditorProps } from '../file-formats';
import { SheetGrid, type CellEdit } from './SheetGrid';

const MAX_UNDO = 100;

/**
 * `.xlsx` du dossier partagé : une feuille à la fois dans la grille, choisie
 * dans une liste (pas d'onglets). Le brouillon ne garde que ce qui a été tapé,
 * cellule par cellule ; à l'envoi, seules ces cellules sont réécrites (`xlsx.ts`).
 */
export function XlsxFileEditor({ name, bytes, initialDraft, readOnly, onEdit, handleRef, author }: FileEditorProps) {
  const [workbook, setWorkbook] = useState<XlsxWorkbook | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    readXlsxWorkbook(bytes).then((loaded) => { if (alive) setWorkbook(loaded); }, (e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [bytes]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!workbook) return <p className="empty">Lecture du classeur…</p>;
  return <XlsxEditorBody workbook={workbook} name={name} bytes={bytes} initialDraft={initialDraft} readOnly={readOnly} onEdit={onEdit} handleRef={handleRef} author={author} />;
}

function XlsxEditorBody({ workbook, bytes, initialDraft, readOnly, onEdit, handleRef, author }: FileEditorProps & { workbook: XlsxWorkbook }) {
  const saved = initialDraft as XlsxDraft | null;
  const [edits, setEdits] = useState<XlsxEdits>(() => (saved?.format === 'xlsx' && saved.edits ? saved.edits : {}));
  const [sheetIndex, setSheetIndex] = useState(workbook.activeSheet);
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const undo = useRef<XlsxEdits[]>([]);
  const redo = useRef<XlsxEdits[]>([]);
  const sheet = workbook.sheets[sheetIndex] ?? workbook.sheets[0];
  const sheetEdits = edits[sheet.name];
  const size = gridSize(sheet, sheetEdits);
  const locked = workbook.readOnly ?? readOnly;

  useImperativeHandle(handleRef, () => ({
    isDirty: () => Object.keys(effectiveEdits(workbook, edits)).length > 0,
    draft: (): XlsxDraft => ({ format: 'xlsx', v: 1, edits: effectiveEdits(workbook, edits) }),
    problems: () => xlsxProblems(workbook, edits),
    serialize: () => writeXlsx(bytes, edits, { author: author || 'WorkLogs' }),
  }), [workbook, edits, bytes, author]);

  const problems = useMemo(() => (workbook.readOnly ? [] : xlsxProblems(workbook, edits)), [workbook, edits]);

  const change = useCallback((next: XlsxEdits) => {
    editsRef.current = next;
    setEdits(next);
    onEdit();
  }, [onEdit]);

  /** Un état par geste : la barre de saisie n'en garde qu'un pour toute sa frappe. */
  const remember = useCallback(() => {
    const current = editsRef.current;
    if (undo.current[undo.current.length - 1] === current) return;
    undo.current.push(current);
    if (undo.current.length > MAX_UNDO) undo.current.shift();
    redo.current = [];
  }, []);

  const setCells = (cells: CellEdit[]) => {
    const current = editsRef.current;
    const mine = { ...(current[sheet.name] ?? {}) };
    let changed = false;
    for (const { row, col, value } of cells) {
      if (row >= GRID_LIMITS.rows || col >= GRID_LIMITS.columns) continue;
      const view = cellView(workbook, sheet, row, col);
      if (view.readOnly) continue;
      const ref = cellRef(row, col);
      // Revenir à la valeur d'origine efface la modification : rien ne sera réécrit.
      if (value === view.input) {
        if (ref in mine) { delete mine[ref]; changed = true; }
      } else if (mine[ref] !== value) {
        mine[ref] = value;
        changed = true;
      }
    }
    if (!changed) return;
    const next = { ...current };
    if (Object.keys(mine).length) next[sheet.name] = mine;
    else delete next[sheet.name];
    change(next);
  };

  const travel = (from: { current: XlsxEdits[] }, to: { current: XlsxEdits[] }) => {
    const previous = from.current.pop();
    if (!previous) return;
    to.current.push(editsRef.current);
    change(previous);
  };

  const label = (index: number) => {
    const candidate = workbook.sheets[index];
    const notes = [candidate.hidden ? 'masquée' : '', candidate.kind === 'chartsheet' ? 'graphique' : '', edits[candidate.name] ? 'modifiée' : ''].filter(Boolean);
    return notes.length ? `${candidate.name} (${notes.join(', ')})` : candidate.name;
  };

  return (
    <div className="shared-sheet">
      <div className="shared-tools no-print">
        <span className="shared-meta">
          Classeur Excel · {workbook.sheets.length} feuille{workbook.sheets.length > 1 ? 's' : ''}
        </span>
        <label className="shared-encoding">
          Feuille
          <select aria-label="Feuille" value={sheetIndex} onChange={(event) => setSheetIndex(Number(event.target.value))}>
            {workbook.sheets.map((_sheet, index) => <option key={index} value={index}>{label(index)}</option>)}
          </select>
        </label>
      </div>
      {workbook.readOnly && <p className="notice">{workbook.readOnly}</p>}
      {sheet.kind !== 'worksheet' || !sheet.sheetData ? (
        <p className="notice">{sheet.readOnly ?? 'Feuille sans cellules.'}</p>
      ) : (
        <>
          {sheet.readOnly && <p className="notice">{sheet.readOnly}</p>}
          {size.truncated && <p className="notice">Feuille très grande : WorkLogs n’en montre que les {GRID_LIMITS.rows.toLocaleString('fr-FR')} premières lignes et {GRID_LIMITS.columns} premières colonnes.</p>}
          <SheetGrid
            key={sheet.name}
            label={`Feuille ${sheet.name}`}
            rowCount={size.rows}
            colCount={size.cols}
            getCell={(row, col) => cellView(workbook, sheet, row, col, sheetEdits).display}
            getInput={(row, col) => cellView(workbook, sheet, row, col, sheetEdits).input}
            cellReadOnly={(row, col) => (locked ? null : cellView(workbook, sheet, row, col).readOnly)}
            cellClass={(row, col) => (cellView(workbook, sheet, row, col, sheetEdits).numeric ? 'is-numeric' : '')}
            readOnly={Boolean(locked || sheet.readOnly)}
            onBeginEdit={remember}
            onSetCells={setCells}
            onUndo={() => travel(undo, redo)}
            onRedo={() => travel(redo, undo)}
          />
        </>
      )}
      {problems.length > 0 && (
        <ul className="sheet-problems no-print" role="alert" aria-label="À corriger avant l’envoi">
          {problems.map((problem) => <li key={problem}>{problem}</li>)}
        </ul>
      )}
      <p className="docx-hint no-print">
        Seules les cellules modifiées seront réécrites ; les formules qui en dépendent seront recalculées à l’ouverture dans Excel ou LibreOffice.
        Formules en français (=SOMME(A1:A3)) ou en anglais. Graphiques, mises en forme, validations et tableaux restent ceux du classeur.
      </p>
    </div>
  );
}
