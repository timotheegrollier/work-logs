import { describe, expect, it } from 'vitest';
import {
  dateToSerial, formatNumber, formatText, generalNumber, isDateFormat, numberInput, parseFrenchNumber, parseInput, serialToDate,
} from './xlsx-format';

const nb = (text: string) => text.replace(/ /g, ' ');

describe('formats de nombre d’Excel, affichés à la française', () => {
  it('Standard : virgule décimale, dix chiffres significatifs, notation scientifique au-delà', () => {
    expect(generalNumber(1234.5)).toBe('1234,5');
    expect(generalNumber(0.1 + 0.2)).toBe('0,3');
    expect(generalNumber(1 / 3)).toBe('0,3333333333');
    expect(generalNumber(-42)).toBe('-42');
    expect(generalNumber(123456789012)).toBe('1,23457E+11');
  });

  it('nombres, milliers, pourcentages, monnaie, négatifs', () => {
    expect(formatNumber(1234.567, '#,##0.00')).toBe(nb('1 234,57'));
    expect(formatNumber(1234567, '#,##0')).toBe(nb('1 234 567'));
    expect(formatNumber(0.125, '0%')).toBe('13%');
    expect(formatNumber(0.125, '0.00%')).toBe('12,50%');
    expect(formatNumber(2.675, '0.00')).toBe('2,68');
    expect(formatNumber(1234.5, '#,##0.00\\ "€"')).toBe(nb('1 234,50') + ' €');
    expect(formatNumber(1234.5, '#,##0.00\\ [$€-40C]')).toBe(nb('1 234,50') + ' €');
    expect(formatNumber(-5, '#,##0.00 "€";-#,##0.00 "€"')).toBe('-5,00 €');
    expect(formatNumber(-5, '#,##0;[Red](#,##0)')).toBe('(5)');
    expect(formatNumber(-5, '0.0')).toBe('-5,0');
    expect(formatNumber(0, '0.00;-0.00;"néant"')).toBe('néant');
    expect(formatNumber(12345, '0.00E+00')).toBe('1,23E+04');
    expect(formatNumber(0.5, '#.##')).toBe(',5');
    expect(formatNumber(42, '000000')).toBe('000042');
    expect(formatNumber(1.5, '# ?/?')).toBe('1,5');
  });

  it('dates et heures, système 1900 (et son faux 29 février) ou 1904', () => {
    expect(serialToDate(45000)?.toISOString()).toBe('2023-03-15T00:00:00.000Z');
    expect(serialToDate(1)?.toISOString()).toBe('1900-01-01T00:00:00.000Z');
    expect(serialToDate(61)?.toISOString()).toBe('1900-03-01T00:00:00.000Z');
    expect(serialToDate(0, true)?.toISOString()).toBe('1904-01-01T00:00:00.000Z');
    expect(dateToSerial(new Date(Date.UTC(2026, 9, 5)))).toBe(46300);
    expect(dateToSerial(new Date(Date.UTC(1900, 0, 1)))).toBe(1);
    expect(formatNumber(46300, 'dd/mm/yyyy')).toBe('05/10/2026');
    expect(formatNumber(46300.6041666667, 'dd/mm/yyyy h:mm')).toBe('05/10/2026 14:30');
    expect(formatNumber(46300, 'dddd d mmmm yyyy')).toBe('lundi 5 octobre 2026');
    expect(formatNumber(46300, 'd-mmm-yy')).toBe('5-oct.-26');
    expect(formatNumber(0.6041666667, 'h:mm:ss')).toBe('14:30:00');
    expect(formatNumber(1.5, '[h]:mm')).toBe('36:00');
    expect(formatNumber(0.75, 'h:mm AM/PM')).toBe('6:00 PM');
    expect(formatNumber(46300, '[$-F800]dddd\\,\\ mmmm\\ dd\\,\\ yyyy')).toBe('lundi, octobre 05, 2026');
    expect(isDateFormat('General')).toBe(false);
    expect(isDateFormat('#,##0.00\\ "€"')).toBe(false);
    expect(isDateFormat('[Red]0.00')).toBe(false);
    expect(isDateFormat('mm:ss')).toBe(true);
  });

  it('texte : quatrième section ou « @ »', () => {
    expect(formatText('A12', '"Réf. "@')).toBe('Réf. A12');
    expect(formatText('A12', '0;-0;0;"<"@">"')).toBe('<A12>');
    expect(formatText('A12', 'General')).toBe('A12');
  });
});

describe('saisie dans une cellule', () => {
  it('nombres à la française, sans deviner contre l’utilisateur', () => {
    expect(parseFrenchNumber('1 234,5')).toBe(1234.5);
    expect(parseFrenchNumber('1 234,5')).toBe(1234.5);
    expect(parseFrenchNumber('12,5 %')).toBe(0.125);
    expect(parseFrenchNumber('12,50 €')).toBe(12.5);
    expect(parseFrenchNumber('-3.25')).toBe(-3.25);
    expect(parseFrenchNumber('1,5E3')).toBe(1500);
    expect(parseFrenchNumber('0,5')).toBe(0.5);
    expect(parseFrenchNumber('0123')).toBeNull();
    expect(parseFrenchNumber('1234567890123456')).toBeNull();
    expect(parseFrenchNumber('12 34')).toBeNull();
    expect(parseFrenchNumber('A1')).toBeNull();
  });

  it('texte forcé, formules, booléens, dates seulement dans une cellule au format date', () => {
    const now = new Date(Date.UTC(2026, 9, 5));
    expect(parseInput('', 'General')).toEqual({ kind: 'empty' });
    expect(parseInput("'0123", 'General')).toEqual({ kind: 'text', value: '0123' });
    expect(parseInput('0123', 'General')).toEqual({ kind: 'text', value: '0123' });
    expect(parseInput('42', '@')).toEqual({ kind: 'text', value: '42' });
    expect(parseInput('=SUM(A1:A3)', 'General')).toEqual({ kind: 'formula', value: 'SUM(A1:A3)' });
    expect(parseInput('=', 'General')).toEqual({ kind: 'text', value: '=' });
    expect(parseInput('vrai', 'General')).toEqual({ kind: 'boolean', value: true });
    expect(parseInput('05/10/2026', 'General')).toEqual({ kind: 'text', value: '05/10/2026' });
    expect(parseInput('05/10/2026', 'dd/mm/yyyy', { now })).toEqual({ kind: 'number', value: 46300 });
    expect(parseInput('5/10', 'dd/mm/yyyy', { now })).toEqual({ kind: 'number', value: 46300 });
    expect(parseInput('31/02/2026', 'dd/mm/yyyy', { now })).toEqual({ kind: 'text', value: '31/02/2026' });
    expect(parseInput('14:30', 'h:mm')).toEqual({ kind: 'number', value: 0.604166666666667 });
    expect(parseInput('12,5', 'dd/mm/yyyy')).toEqual({ kind: 'number', value: 12.5 });
  });

  it('la saisie proposée redonne la même valeur', () => {
    for (const [value, format] of [[46300, 'dd/mm/yyyy'], [46300.6041666667, 'dd/mm/yyyy hh:mm'], [0.125, '0.0%'], [1234.5, '#,##0.00'], [1.5e-7, 'General'], [0.6041666666666666, 'h:mm']] as const) {
      const input = numberInput(value, format);
      const parsed = parseInput(input, format);
      expect(parsed.kind).toBe('number');
      expect((parsed as { value: number }).value).toBeCloseTo(value, 6);
    }
    expect(numberInput(46300, 'dd/mm/yyyy')).toBe('05/10/2026');
    expect(numberInput(0.125, '0%')).toBe('12,5%');
    expect(numberInput(1234.5, '#,##0.00')).toBe('1234,5');
  });
});
