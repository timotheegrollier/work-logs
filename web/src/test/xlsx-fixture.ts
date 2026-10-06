import { buildZip, type ZipFile } from './docx-fixture';

/**
 * Classeur Excel **construit pour les tests**, à la manière d'Excel : chaînes
 * partagées (dont une mise en forme), styles avec formats monétaire, date,
 * pourcentage et texte, formule recopiée (partagée), formule inter-feuilles,
 * cellules fusionnées, tableau, feuille masquée et protégée, chaîne de calcul,
 * mise en forme conditionnelle et validation à recopier telles quelles. À
 * confronter, sur le TSE, aux vrais classeurs de l'équipe (`docs/00-HANDOVER.md`).
 */

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const X14AC = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac';

export interface WorkbookOptions {
  /** Pas de `sharedStrings.xml` : les textes nouveaux seront en ligne. */
  sharedStrings?: boolean;
  macro?: boolean;
  strict?: boolean;
  date1904?: boolean;
  /** Mot de passe de modification (`fileSharing`). */
  reservation?: boolean;
  calcPr?: boolean;
  calcChain?: boolean;
  author?: string;
}

const STRINGS = ['Tâche', 'Montant', 'Échéance', 'Achat', 'Total', 'Note fusionnée', '0123', 'Taux', 'Formule'];

export function excelWorkbook(options: WorkbookOptions = {}): Uint8Array {
  const { sharedStrings = true, calcPr = true, calcChain = true, author = 'Jean Dupont' } = options;
  const main = options.strict ? 'http://purl.oclc.org/ooxml/spreadsheetml/main' : MAIN;
  const str = (index: number, ref: string, style = 0) => sharedStrings
    ? `<c r="${ref}"${style ? ` s="${style}"` : ''} t="s"><v>${index}</v></c>`
    : `<c r="${ref}"${style ? ` s="${style}"` : ''} t="inlineStr"><is><t>${STRINGS[index]}</t></is></c>`;
  const contentType = options.macro ? 'application/vnd.ms-excel.sheet.macroEnabled.main+xml' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
  const files: ZipFile[] = [
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
        + `<Override PartName="/xl/workbook.xml" ContentType="${contentType}"/>`
        + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        + '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        + '<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + (sharedStrings ? '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' : '')
        + (calcChain ? '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>' : '')
        + '<Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>'
        + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        + '</Types>',
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="${PKG}">`
        + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
        + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        + '</Relationships>',
    },
    {
      name: 'docProps/core.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        + `<dc:creator>Jean Dupont</dc:creator><cp:lastModifiedBy>${author}</cp:lastModifiedBy>`
        + '<dcterms:created xsi:type="dcterms:W3CDTF">2026-09-01T08:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-10-01T09:00:00Z</dcterms:modified></cp:coreProperties>',
    },
    { name: 'docProps/app.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel</Application></Properties>' },
    {
      name: 'xl/workbook.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
        + `<workbook xmlns="${main}" xmlns:r="${REL}" xmlns:mc="${MC}" mc:Ignorable="x15" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main">`
        + '<fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="28526"/>'
        + (options.reservation ? '<fileSharing userName="Jean Dupont" algorithmName="SHA-512" hashValue="abc=" saltValue="def=" spinCount="100000"/>' : '')
        + `<workbookPr${options.date1904 ? ' date1904="1"' : ''} defaultThemeVersion="202300"/>`
        + '<bookViews><workbookView xWindow="-120" yWindow="-120" windowWidth="29040" windowHeight="15720" activeTab="0"/></bookViews>'
        + '<sheets><sheet name="Suivi" sheetId="1" r:id="rId1"/><sheet name="Paramètres" sheetId="2" state="hidden" r:id="rId2"/><sheet name="Résumé" sheetId="3" r:id="rId3"/></sheets>'
        + '<definedNames><definedName name="Taux">Paramètres!$B$1</definedName></definedNames>'
        + (calcPr ? '<calcPr calcId="191029"/>' : '')
        + '<extLst><ext uri="{140A7094-0E35-4892-8432-C4D2E57EDEB5}" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main"><x15:workbookPr chartTrackingRefBase="1"/></ext></extLst>'
        + '</workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="${PKG}">`
        + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>'
        + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        + (calcChain ? '<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/>' : '')
        + (sharedStrings ? '<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' : '')
        + '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        + '</Relationships>',
    },
    {
      name: 'xl/styles.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<styleSheet xmlns="${MAIN}" xmlns:mc="${MC}" mc:Ignorable="x14ac" xmlns:x14ac="${X14AC}">`
        + '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00\\ &quot;€&quot;"/></numFmts>'
        + '<fonts count="1"><font><sz val="11"/><name val="Aptos Narrow"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
        + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        + '<cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        + '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        + '<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        + '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyProtection="1"><protection locked="0"/></xf></cellXfs>'
        + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
        + `<worksheet xmlns="${MAIN}" xmlns:r="${REL}" xmlns:mc="${MC}" mc:Ignorable="x14ac" xmlns:x14ac="${X14AC}">`
        + '<dimension ref="A1:D6"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"><selection activeCell="B2" sqref="B2"/></sheetView></sheetViews>'
        + '<sheetFormatPr defaultRowHeight="14.4" x14ac:dyDescent="0.3"/><cols><col min="3" max="3" width="12" style="1" customWidth="1"/></cols>'
        + '<sheetData>'
        + `<row r="1" spans="1:4" x14ac:dyDescent="0.3">${str(0, 'A1')}${str(1, 'B1')}${str(2, 'C1')}${str(8, 'D1')}</row>`
        + `<row r="2" spans="1:4" x14ac:dyDescent="0.3">${str(3, 'A2')}<c r="B2" s="2"><v>1234.5</v></c><c r="C2" s="1"><v>46300</v></c><c r="D2" s="2"><f t="shared" ref="D2:D3" si="0">B2*2</f><v>2469</v></c></row>`
        + '<row r="3" spans="1:4" x14ac:dyDescent="0.3"><c r="A3" t="inlineStr"><is><t>Location</t></is></c><c r="B3" s="2"><v>100</v></c><c r="C3" s="1"/><c r="D3" s="2"><f t="shared" si="0"/><v>200</v></c></row>'
        + `<row r="4" spans="1:4" x14ac:dyDescent="0.3">${str(4, 'A4')}<c r="B4" s="2"><f>SUM(B2:B3)</f><v>1334.5</v></c></row>`
        + `<row r="5" spans="1:4" x14ac:dyDescent="0.3">${str(5, 'A5')}<c r="B5"/></row>`
        + `<row r="6" spans="1:4" x14ac:dyDescent="0.3"><c r="A6" t="b"><v>1</v></c><c r="B6" t="e"><v>#DIV/0!</v></c><c r="C6" s="3"><v>0.125</v></c>${str(6, 'D6', 4)}</row>`
        + '</sheetData>'
        + '<mergeCells count="1"><mergeCell ref="A5:B5"/></mergeCells>'
        + '<conditionalFormatting sqref="B2:B3"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>1000</formula></cfRule></conditionalFormatting>'
        + '<dataValidations count="1"><dataValidation type="decimal" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="B2:B3"><formula1>0</formula1></dataValidation></dataValidations>'
        + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
        + '<tableParts count="1"><tablePart r:id="rId1"/></tableParts>'
        + '</worksheet>',
    },
    {
      name: 'xl/worksheets/_rels/sheet1.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/></Relationships>`,
    },
    {
      name: 'xl/tables/table1.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<table xmlns="${MAIN}" id="1" name="Achats" displayName="Achats" ref="A1:C3" totalsRowShown="0">`
        + '<autoFilter ref="A1:C3"/><tableColumns count="3"><tableColumn id="1" name="Tâche"/><tableColumn id="2" name="Montant"/><tableColumn id="3" name="Échéance"/></tableColumns>'
        + '<tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>',
    },
    {
      name: 'xl/worksheets/sheet2.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
        + `<worksheet xmlns="${MAIN}" xmlns:r="${REL}"><dimension ref="A1:B1"/><sheetData>`
        + `<row r="1">${str(7, 'A1')}<c r="B1" s="5"><v>0.2</v></c></row>`
        + '</sheetData><sheetProtection algorithmName="SHA-512" hashValue="x" saltValue="y" spinCount="100000" sheet="1" objects="1" scenarios="1"/>'
        + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>',
    },
    {
      name: 'xl/worksheets/sheet3.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
        + `<worksheet xmlns="${MAIN}" xmlns:r="${REL}"><dimension ref="A1"/><sheetData>`
        + '<row r="1"><c r="A1" s="2"><f>SUM(Suivi!B2:B3)*(1+Taux)</f><v>1601.4</v></c></row>'
        + '<row r="3" ht="20" customHeight="1"/>'
        + '</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>',
    },
  ];
  if (sharedStrings) {
    files.push({
      name: 'xl/sharedStrings.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<sst xmlns="${MAIN}" count="10" uniqueCount="${STRINGS.length}">`
        + STRINGS.map((text, index) => (index === 5
          ? '<si><r><rPr><b/><sz val="11"/></rPr><t>Note</t></r><r><rPr><sz val="11"/></rPr><t xml:space="preserve"> fusionnée</t></r></si>'
          : `<si><t>${text}</t></si>`)).join('')
        + '</sst>',
    });
  }
  if (calcChain) files.push({ name: 'xl/calcChain.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<calcChain xmlns="${MAIN}"><c r="D2" i="1"/><c r="D3"/><c r="B4"/><c r="A1" i="3"/></calcChain>` });
  if (options.macro) files.push({ name: 'xl/vbaProject.bin', data: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]) });
  return buildZip(files);
}

/** Classeur minimal d'une feuille (« Feuil1 »), sans chaînes partagées : pour les cas limites. */
export function miniWorkbook(sheetData: string): Uint8Array {
  return buildZip([
    { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>' },
    { name: '_rels/.rels', data: `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="Feuil1" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>` },
    { name: 'xl/worksheets/sheet1.xml', data: `<worksheet xmlns="${MAIN}"><sheetData>${sheetData}</sheetData></worksheet>` },
  ]);
}
