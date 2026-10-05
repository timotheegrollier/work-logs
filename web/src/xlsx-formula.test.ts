import { describe, expect, it } from 'vitest';
import { formulaDependencies, formulaToFrench, FormulaError, normalizeFormula } from './xlsx-formula';

describe('formules tapées dans une cellule', () => {
  it('anglais : gardé tel quel, fonctions récentes préfixées comme Excel les enregistre', () => {
    expect(normalizeFormula('SUM(A1:A3)')).toBe('SUM(A1:A3)');
    expect(normalizeFormula('ROUND(B2*1.2, 2)')).toBe('ROUND(B2*1.2, 2)');
    expect(normalizeFormula("SUM('Mes chiffres'!A1:A3,Feuil2!$B$1)")).toBe("SUM('Mes chiffres'!A1:A3,Feuil2!$B$1)");
    expect(normalizeFormula('IF(A1>=10,"ok;pas ok",FALSE)')).toBe('IF(A1>=10,"ok;pas ok",FALSE)');
    expect(normalizeFormula('CONCAT(A1,B1)')).toBe('_xlfn.CONCAT(A1,B1)');
    expect(normalizeFormula('SUM(Tableau1[Montant])')).toBe('SUM(Tableau1[Montant])');
    expect(normalizeFormula('A1*10%')).toBe('A1*10%');
    expect(normalizeFormula('SUM({1,2;3,4})')).toBe('SUM({1,2;3,4})');
    expect(normalizeFormula('IF(A1,,1)')).toBe('IF(A1,,1)');
    expect(normalizeFormula('LOG10(100)')).toBe('LOG10(100)');
  });

  it('français : fonctions traduites, « ; » entre arguments, virgule décimale', () => {
    expect(normalizeFormula('SOMME(A1:A3)')).toBe('SUM(A1:A3)');
    expect(normalizeFormula('SI(A1>0,5;"oui";"non")')).toBe('IF(A1>0.5,"oui","non")');
    expect(normalizeFormula('ARRONDI(B2*1,2;2)')).toBe('ROUND(B2*1.2,2)');
    expect(normalizeFormula('A1*1,5')).toBe('A1*1.5');
    expect(normalizeFormula('NB.SI(A:A;"x")+SIERREUR(1/0;FAUX)')).toBe('COUNTIF(A:A,"x")+IFERROR(1/0,FALSE)');
    expect(normalizeFormula('RECHERCHEX(A1;B:B;C:C)')).toBe('_xlfn.XLOOKUP(A1,B:B,C:C)');
    expect(normalizeFormula('SI(ESTERREUR(A1);#N/A;#VALEUR!)')).toBe('IF(ISERROR(A1),#N/A,#VALUE!)');
  });

  it('syntaxe fautive : refusée avant d’arriver dans le fichier', () => {
    for (const bad of ['SUM(A1:A3', 'SUM(A1))', '1+', '"abc', 'A1 B1', '(A1,B1)', '#BIDULE', "'Feuil 1'A1", 'SI(A1;', '*2']) {
      expect(() => normalizeFormula(bad), bad).toThrow(FormulaError);
    }
  });

  it('affichage en français de la formule enregistrée, et retour à l’identique', () => {
    expect(formulaToFrench('SUM(A1:A3,2.5)')).toBe('SOMME(A1:A3;2,5)');
    expect(formulaToFrench('_xlfn.XLOOKUP(A1,B:B,C:C)')).toBe('RECHERCHEX(A1;B:B;C:C)');
    expect(formulaToFrench('IF(A1,TRUE,#NAME?)')).toBe('SI(A1;VRAI;#NOM?)');
    expect(formulaToFrench('NETWORKDAYS.INTL(A1,B1,1)')).toBe('NETWORKDAYS.INTL(A1;B1;1)');
    expect(formulaToFrench('SUM({1,2})')).toBe('SUM({1,2})');
    for (const stored of ['SUM(A1:A3,2.5)', 'IF(A1>0.5,"a;b",FALSE)', '_xlfn.CONCAT(A1,"x")', 'ROUND(Feuil2!B2*1.2,2)']) {
      expect(normalizeFormula(formulaToFrench(stored))).toBe(stored);
    }
  });

  it('ce qu’une formule lit : plages, feuilles, noms ; prudente quand le texte ne le dit pas', () => {
    expect(formulaDependencies("SUM('Mes chiffres'!A1:B$3,Feuil2!C:C)+Taux")).toEqual({
      kind: 'ranges',
      ranges: [
        { sheet: 'Mes chiffres', r1: 0, c1: 0, r2: 2, c2: 1, abs: { r1: false, c1: false, r2: true, c2: false } },
        { sheet: 'Feuil2', r1: 0, c1: 2, r2: 1048575, c2: 2, abs: { r1: true, c1: false, r2: true, c2: false } },
      ],
      names: ['Taux'],
    });
    expect(formulaDependencies('$A$1*2')).toMatchObject({ kind: 'ranges', ranges: [{ sheet: null, r1: 0, c1: 0, abs: { r1: true, c1: true } }] });
    expect(formulaDependencies('INDIRECT("A"&B1)')).toEqual({ kind: 'unknown' });
    expect(formulaDependencies('SUM(Tableau1[Montant])')).toEqual({ kind: 'unknown' });
    expect(formulaDependencies('[1]Feuil1!A1*2')).toEqual({ kind: 'external' });
    expect(formulaDependencies('"[1]"&A1')).toMatchObject({ kind: 'ranges' });
  });
});
