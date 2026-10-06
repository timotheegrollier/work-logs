import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { columnName, SheetGrid, type CellEdit } from './SheetGrid';

function Harness({ initial, readOnly = false }: { initial: string[][]; readOnly?: boolean }) {
  const [rows, setRows] = useState(initial);
  const set = (edits: CellEdit[]) => setRows((current) => {
    const next = current.map((row) => row.slice());
    for (const { row, col, value } of edits) {
      while (next.length <= row) next.push([]);
      next[row][col] = value;
    }
    return next;
  });
  return (
    <SheetGrid
      label="Tableau test"
      rowCount={rows.length}
      colCount={Math.max(1, ...rows.map((row) => row.length))}
      getCell={(row, col) => rows[row]?.[col] ?? ''}
      readOnly={readOnly}
      onBeginEdit={() => {}}
      onSetCells={set}
    />
  );
}

const grid = () => screen.getByRole('grid', { name: 'Tableau test' });
const cell = (name: string) => within(grid()).getByRole('gridcell', { name });
const bar = () => screen.getByLabelText('Contenu de la cellule');

describe('grille', () => {
  it('nomme les colonnes comme un tableur', () => {
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  });

  it('taper sur une cellule la remplace et continue dans la barre', () => {
    render(<Harness initial={[['a', 'b'], ['c', 'd']]} />);
    fireEvent.click(cell('B2 : d'));
    fireEvent.keyDown(cell('B2 : d'), { key: 'x' });
    expect(cell('B2 : x')).toBeInTheDocument();
    expect(bar()).toHaveFocus();
    fireEvent.change(bar(), { target: { value: 'xyz' } });
    expect(cell('B2 : xyz')).toBeInTheDocument();
  });

  it('une touche morte (« ^ » avant « e ») ouvre la barre sans perdre le caractère composé', () => {
    render(<Harness initial={[['a']]} />);
    fireEvent.click(cell('A1 : a'));
    const dead = fireEvent.keyDown(cell('A1 : a'), { key: 'Dead' });
    expect(dead).toBe(true);
    expect(bar()).toHaveFocus();
    expect(cell('A1 : vide')).toBeInTheDocument();
  });

  it('Échap rend la valeur d’avant l’édition', () => {
    render(<Harness initial={[['avant']]} />);
    fireEvent.click(cell('A1 : avant'));
    fireEvent.keyDown(cell('A1 : avant'), { key: 'Enter' });
    fireEvent.focus(bar());
    fireEvent.change(bar(), { target: { value: 'après' } });
    fireEvent.keyDown(bar(), { key: 'Escape' });
    expect(cell('A1 : avant')).toBeInTheDocument();
  });

  it('les flèches déplacent la cellule active', () => {
    render(<Harness initial={[['a', 'b'], ['c', 'd']]} />);
    fireEvent.click(cell('A1 : a'));
    fireEvent.keyDown(cell('A1 : a'), { key: 'ArrowRight' });
    expect(screen.getByLabelText('Cellule active')).toHaveTextContent('B1');
    fireEvent.keyDown(cell('B1 : b'), { key: 'ArrowDown' });
    expect(screen.getByLabelText('Cellule active')).toHaveTextContent('B2');
    expect(cell('B2 : d')).toHaveAttribute('aria-selected', 'true');
  });

  it('coller un bloc venu d’un tableur remplit à partir de la cellule active, en agrandissant', () => {
    render(<Harness initial={[['a']]} />);
    fireEvent.click(cell('A1 : a'));
    fireEvent.paste(grid(), { clipboardData: { getData: () => '1\t2\n3\t4\n' } });
    expect(cell('B2 : 4')).toBeInTheDocument();
  });

  it('lecture seule : ni frappe, ni effacement', () => {
    render(<Harness initial={[['a']]} readOnly />);
    fireEvent.click(cell('A1 : a'));
    fireEvent.keyDown(cell('A1 : a'), { key: 'x' });
    fireEvent.keyDown(cell('A1 : a'), { key: 'Delete' });
    expect(cell('A1 : a')).toBeInTheDocument();
    expect(grid()).toHaveAttribute('aria-readonly', 'true');
  });

  it('classeur : la barre montre la saisie (formule), une cellule protégée dit pourquoi et ne se modifie pas', () => {
    function Workbook() {
      const [values, setValues] = useState<Record<string, string>>({ '0:0': '=SOMME(B1:B2)', '0:1': '12' });
      return (
        <SheetGrid
          label="Tableau test"
          rowCount={2}
          colCount={2}
          getCell={(row, col) => (row === 0 && col === 0 ? '24' : values[`${row}:${col}`] ?? '')}
          getInput={(row, col) => values[`${row}:${col}`] ?? ''}
          cellReadOnly={(row, col) => (row === 1 && col === 1 ? 'Cellule fusionnée avec B1 : seule B1 se modifie.' : null)}
          readOnly={false}
          onBeginEdit={() => {}}
          onSetCells={(edits) => setValues((current) => ({ ...current, ...Object.fromEntries(edits.map((edit) => [`${edit.row}:${edit.col}`, edit.value])) }))}
        />
      );
    }
    render(<Workbook />);
    fireEvent.click(cell('A1 : 24'));
    expect(bar()).toHaveValue('=SOMME(B1:B2)');
    fireEvent.click(cell('B2 : vide'));
    expect(cell('B2 : vide')).toHaveAttribute('aria-readonly', 'true');
    expect(screen.getByText('B2 : Cellule fusionnée avec B1 : seule B1 se modifie.')).toHaveAttribute('role', 'status');
    fireEvent.keyDown(cell('B2 : vide'), { key: 'x' });
    expect(bar()).toHaveAttribute('readonly');
    expect(cell('B2 : vide')).toBeInTheDocument();
    // Coller un bloc par-dessus : la cellule fusionnée garde sa valeur, le reste se colle.
    fireEvent.click(cell('A2 : vide'));
    fireEvent.paste(grid(), { clipboardData: { getData: () => 'a\tb' } });
    expect(cell('A2 : a')).toBeInTheDocument();
    expect(cell('B2 : vide')).toBeInTheDocument();
  });
});
