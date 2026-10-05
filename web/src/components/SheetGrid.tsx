import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';

/** A, B, …, Z, AA, AB… */
export function columnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

export interface CellEdit {
  row: number;
  col: number;
  value: string;
}

export interface SheetGridProps {
  /** Nom accessible du tableau. */
  label: string;
  rowCount: number;
  colCount: number;
  getCell(row: number, col: number): string;
  /** Ce que montre la barre (formule, nombre sans format) ; par défaut, ce qu'affiche la cellule. */
  getInput?(row: number, col: number): string;
  /** Pourquoi cette cellule ne se modifie pas (fusionnée, protégée…), ou `null`. */
  cellReadOnly?(row: number, col: number): string | null;
  /** Classe d'affichage d'une cellule (nombres alignés à droite…). */
  cellClass?(row: number, col: number): string;
  readOnly: boolean;
  /** Une écriture (frappe, collage, effacement) ; peut dépasser la taille actuelle. */
  onSetCells(edits: CellEdit[]): void;
  /** Juste avant un changement : le parent garde de quoi annuler. */
  onBeginEdit(): void;
  onInsertRow?(after: number): void;
  onDeleteRow?(row: number): void;
  onInsertColumn?(after: number): void;
  onDeleteColumn?(col: number): void;
  onUndo?(): void;
  onRedo?(): void;
}

const ROW_HEIGHT = 30;
const OVERSCAN = 20;

/**
 * Grille éditable des fichiers tabulaires (CSV, puis tableurs). La cellule
 * active s'édite dans la barre « Contenu de la cellule », comme dans un
 * tableur ; les lignes hors de la vue ne sont pas rendues, pour tenir des
 * fichiers de plusieurs dizaines de milliers de lignes.
 */
export function SheetGrid({
  label, rowCount, colCount, getCell, getInput, cellReadOnly, cellClass, readOnly, onSetCells, onBeginEdit,
  onInsertRow, onDeleteRow, onInsertColumn, onDeleteColumn, onUndo, onRedo,
}: SheetGridProps) {
  const [active, setActive] = useState({ row: 0, col: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const [focusRequest, setFocusRequest] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLInputElement>(null);
  const editingFrom = useRef<string | null>(null);

  const row = Math.max(0, Math.min(active.row, rowCount - 1));
  const col = Math.max(0, Math.min(active.col, colCount - 1));
  const value = rowCount > 0 ? getCell(row, col) : '';
  const input = rowCount > 0 && getInput ? getInput(row, col) : value;
  const locked = rowCount > 0 && cellReadOnly ? cellReadOnly(row, col) : null;
  const blocked = readOnly || Boolean(locked);
  const reference = rowCount > 0 ? `${columnName(col)}${row + 1}` : '—';

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => setViewport(container.clientHeight || 600);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(container);
    return () => observer?.disconnect();
  }, []);

  // Après un déplacement au clavier : la cellule active reçoit le focus, visible.
  useEffect(() => {
    if (!focusRequest) return;
    const container = containerRef.current;
    if (!container) return;
    const top = row * ROW_HEIGHT;
    const header = ROW_HEIGHT;
    if (top < container.scrollTop) container.scrollTop = top;
    else if (top + ROW_HEIGHT > container.scrollTop + viewport - header) container.scrollTop = top + ROW_HEIGHT - viewport + header;
    container.querySelector<HTMLElement>(`[data-cell="${row}:${col}"]`)?.focus();
  }, [focusRequest, row, col, viewport]);

  const moveTo = (nextRow: number, nextCol: number) => {
    setActive({ row: Math.max(0, Math.min(nextRow, rowCount - 1)), col: Math.max(0, Math.min(nextCol, colCount - 1)) });
    setFocusRequest((n) => n + 1);
  };

  const startEdit = (initial?: string) => {
    if (blocked || rowCount === 0) return;
    onBeginEdit();
    editingFrom.current = input;
    if (initial !== undefined) onSetCells([{ row, col, value: initial }]);
    // Focus **tout de suite** : une frappe rapide (« 14,2 ») doit continuer dans
    // la barre, pas relancer une édition sur la cellule à chaque touche.
    barRef.current?.focus();
    setTimeout(() => {
      const bar = barRef.current;
      if (bar) bar.setSelectionRange(bar.value.length, bar.value.length);
    }, 0);
  };

  const onGridKey = (event: KeyboardEvent<HTMLTableElement>) => {
    const { key } = event;
    const command = event.ctrlKey || event.metaKey;
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (moves[key]) {
      event.preventDefault();
      moveTo(row + moves[key][0], col + moves[key][1]);
    } else if (key === 'Tab') {
      event.preventDefault();
      moveTo(row, col + (event.shiftKey ? -1 : 1));
    } else if (key === 'Home') {
      event.preventDefault();
      moveTo(command ? 0 : row, 0);
    } else if (key === 'End') {
      event.preventDefault();
      moveTo(command ? rowCount - 1 : row, colCount - 1);
    } else if (key === 'Enter' || key === 'F2') {
      event.preventDefault();
      startEdit();
    } else if ((key === 'Delete' || key === 'Backspace') && !blocked && input !== '') {
      event.preventDefault();
      onBeginEdit();
      onSetCells([{ row, col, value: '' }]);
    } else if (command && key.toLowerCase() === 'z') {
      event.preventDefault();
      (event.shiftKey ? onRedo : onUndo)?.();
    } else if (command && key.toLowerCase() === 'y') {
      event.preventDefault();
      onRedo?.();
    } else if (key.length === 1 && !command && !event.altKey) {
      // Taper sur une cellule la remplace, comme dans un tableur.
      event.preventDefault();
      startEdit(key);
    } else if ((key === 'Dead' || key === 'Process' || event.nativeEvent.isComposing) && !blocked) {
      // Touche morte (« ^ » puis « e » sur un clavier français) ou méthode de saisie :
      // on vide la cellule et on passe la main à la barre **sans** bloquer la touche,
      // pour que le caractère composé y arrive au lieu de se perdre sur la cellule.
      startEdit('');
    }
  };

  const onBarKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      editingFrom.current = null;
      moveTo(row + (event.shiftKey ? -1 : 1), col);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      editingFrom.current = null;
      moveTo(row, col + (event.shiftKey ? -1 : 1));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (editingFrom.current !== null && editingFrom.current !== input) onSetCells([{ row, col, value: editingFrom.current }]);
      editingFrom.current = null;
      setFocusRequest((n) => n + 1);
    }
  };

  const onCopy = (event: ClipboardEvent<HTMLTableElement>) => {
    event.preventDefault();
    event.clipboardData.setData('text/plain', value);
  };

  // Coller un bloc venu d'un tableur (TSV) à partir de la cellule active.
  const onPaste = (event: ClipboardEvent<HTMLTableElement>) => {
    if (readOnly) return;
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n').replace(/\n$/, '');
    const edits: CellEdit[] = [];
    text.split('\n').forEach((line, dr) => line.split('\t').forEach((cell, dc) => {
      // Une cellule fusionnée ou protégée garde sa valeur : le reste du bloc se colle.
      if (!cellReadOnly?.(row + dr, col + dc)) edits.push({ row: row + dr, col: col + dc, value: cell });
    }));
    if (!edits.length) return;
    onBeginEdit();
    onSetCells(edits);
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rowCount, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);
  const columns = Array.from({ length: colCount }, (_, i) => i);

  return (
    <div className="sheet-grid-wrap">
      <div className="sheet-bar no-print">
        <output className="sheet-ref" aria-label="Cellule active">{reference}</output>
        <input
          ref={barRef}
          className="sheet-input"
          aria-label="Contenu de la cellule"
          value={input}
          readOnly={blocked || rowCount === 0}
          title={locked ?? undefined}
          onFocus={() => {
            if (editingFrom.current === null && !blocked) {
              editingFrom.current = input;
              onBeginEdit();
            }
          }}
          onBlur={() => { editingFrom.current = null; }}
          onChange={(event) => onSetCells([{ row, col, value: event.target.value }])}
          onKeyDown={onBarKey}
        />
      </div>
      {locked && !readOnly && <p className="sheet-locked no-print" role="status">{reference} : {locked}</p>}
      {!readOnly && (onInsertRow || onUndo) && (
        <div className="sheet-actions no-print">
          {onInsertRow && <button className="ghost" aria-label={rowCount ? `Ajouter une ligne après la ligne ${row + 1}` : 'Ajouter une ligne'} onClick={() => { onBeginEdit(); onInsertRow(rowCount ? row : -1); setActive({ row: rowCount ? row + 1 : 0, col }); setFocusRequest((n) => n + 1); }}>＋ Ligne</button>}
          {onDeleteRow && rowCount > 0 && <button className="ghost" aria-label={`Supprimer la ligne ${row + 1}`} onClick={() => { onBeginEdit(); onDeleteRow(row); }}>− Ligne</button>}
          {onInsertColumn && <button className="ghost" aria-label={`Ajouter une colonne après la colonne ${columnName(col)}`} onClick={() => { onBeginEdit(); onInsertColumn(col); }}>＋ Colonne</button>}
          {onDeleteColumn && colCount > 1 && <button className="ghost" aria-label={`Supprimer la colonne ${columnName(col)}`} onClick={() => { onBeginEdit(); onDeleteColumn(col); }}>− Colonne</button>}
          <span className="grow" />
          {onUndo && <button className="ghost" aria-label="Annuler la dernière modification" onClick={onUndo}>↶</button>}
          {onRedo && <button className="ghost" aria-label="Rétablir la modification" onClick={onRedo}>↷</button>}
        </div>
      )}
      <div
        ref={containerRef}
        className="sheet-grid"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <table
          role="grid"
          aria-label={label}
          aria-rowcount={rowCount + 1}
          aria-colcount={colCount + 1}
          aria-readonly={readOnly || undefined}
          onKeyDown={onGridKey}
          onCopy={onCopy}
          onPaste={onPaste}
        >
          <thead>
            <tr role="row">
              <th className="sheet-corner" aria-hidden="true" />
              {columns.map((c) => <th key={c} role="columnheader" scope="col" className={c === col ? 'is-active' : ''}>{columnName(c)}</th>)}
            </tr>
          </thead>
          <tbody>
            {first > 0 && <tr aria-hidden="true" style={{ height: first * ROW_HEIGHT }} />}
            {Array.from({ length: last - first }, (_, i) => first + i).map((r) => (
              <tr key={r} role="row" aria-rowindex={r + 2}>
                <th role="rowheader" scope="row" className={r === row ? 'is-active' : ''}>{r + 1}</th>
                {columns.map((c) => {
                  const cell = getCell(r, c);
                  const current = r === row && c === col;
                  const lockedCell = cellReadOnly ? Boolean(cellReadOnly(r, c)) : false;
                  return (
                    <td
                      key={c}
                      role="gridcell"
                      data-cell={`${r}:${c}`}
                      tabIndex={current ? 0 : -1}
                      aria-selected={current}
                      aria-label={`${columnName(c)}${r + 1} : ${cell || 'vide'}`}
                      aria-readonly={lockedCell || undefined}
                      className={[current ? 'is-active' : '', lockedCell ? 'is-locked' : '', cellClass?.(r, c) ?? ''].filter(Boolean).join(' ') || undefined}
                      onClick={() => setActive({ row: r, col: c })}
                      onDoubleClick={() => { setActive({ row: r, col: c }); startEdit(); }}
                    >
                      {cell}
                    </td>
                  );
                })}
              </tr>
            ))}
            {last < rowCount && <tr aria-hidden="true" style={{ height: (rowCount - last) * ROW_HEIGHT }} />}
          </tbody>
        </table>
        {rowCount === 0 && <p className="empty">Tableau vide.</p>}
      </div>
    </div>
  );
}
