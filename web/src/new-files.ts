import { createZip } from './zip';
import { escapeText } from './xml-scan';

/**
 * Fichiers neufs du dossier partagé : un document Word, un classeur Excel, une
 * note, un texte ou un CSV, prêts à s'ouvrir dans Word et Excel sur le TSE comme
 * dans les éditeurs de WorkLogs. Les modèles sont minimaux mais complets (types de
 * contenu, relations, styles, propriétés) : Office ne propose pas de réparation.
 */

export interface NewFileType {
  ext: 'docx' | 'xlsx' | 'md' | 'txt' | 'csv';
  label: string;
}

export const NEW_FILE_TYPES: NewFileType[] = [
  { ext: 'docx', label: 'Document Word (.docx)' },
  { ext: 'xlsx', label: 'Classeur Excel (.xlsx)' },
  { ext: 'md', label: 'Note Markdown (.md)' },
  { ext: 'txt', label: 'Texte (.txt)' },
  { ext: 'csv', label: 'Tableau CSV (.csv)' },
];

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Ce qui empêcherait Windows (le TSE) d'accepter ce nom, ou `null`. */
export function fileNameProblem(name: string): string | null {
  const value = name.trim();
  if (!value) return 'Donne un nom au fichier.';
  // eslint-disable-next-line no-control-regex
  const forbidden = /[<>:"/\\|?*\u0000-\u001f]/.exec(value);
  if (forbidden) return `Caractère refusé par Windows dans un nom de fichier : « ${forbidden[0] < ' ' ? '?' : forbidden[0]} ».`;
  if (/[. ]$/.test(name)) return 'Un nom de fichier ne peut pas finir par un point ou une espace sous Windows.';
  if (RESERVED.test(value)) return `« ${value} » est un nom réservé par Windows.`;
  if (value.startsWith('.') || value.startsWith('~')) return 'Ce nom est celui d’un fichier technique (point ou ~ au début) : choisis-en un autre.';
  if (value.length > 200) return 'Nom trop long (200 caractères au plus).';
  return null;
}

/** « Procédure sauvegarde » + docx → « Procédure sauvegarde.docx » (extension déjà là : gardée). */
export function withExtension(name: string, ext: string): string {
  const value = name.trim();
  return value.toLowerCase().endsWith(`.${ext}`) ? value : `${value}.${ext}`;
}

const encoder = new TextEncoder();
const xml = (body: string) => encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n${body}`);
const BOM = [0xef, 0xbb, 0xbf];

const pad = (n: number) => String(n).padStart(2, '0');
const w3cdtf = (date: Date) =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;

const PKG_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function coreProperties(title: string, author: string, now: Date) {
  const who = escapeText(author || 'WorkLogs');
  return xml('<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `<dc:title>${escapeText(title)}</dc:title><dc:creator>${who}</dc:creator><cp:lastModifiedBy>${who}</cp:lastModifiedBy><cp:revision>1</cp:revision>`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${w3cdtf(now)}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${w3cdtf(now)}</dcterms:modified>`
    + '</cp:coreProperties>');
}

const appProperties = (application: string) =>
  xml(`<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>${application}</Application></Properties>`);

const packageRels = (main: string) => xml(`<Relationships xmlns="${PKG_RELS}">`
  + `<Relationship Id="rId1" Type="${OFFICE_RELS}/officeDocument" Target="${main}"/>`
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
  + `<Relationship Id="rId3" Type="${OFFICE_RELS}/extended-properties" Target="docProps/app.xml"/>`
  + '</Relationships>');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** Titre de niveau `level` : style « heading N » (identifiant français de Word, « Titre1 »). */
const heading = (level: number, size: number, before: number) =>
  `<w:style w:type="paragraph" w:styleId="Titre${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>`
  + `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="80"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>`
  + `<w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;

async function newDocx(title: string, author: string, now: Date): Promise<Uint8Array> {
  return createZip([
    {
      name: '[Content_Types].xml',
      data: xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        + '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
        + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
        + '</Types>'),
    },
    { name: '_rels/.rels', data: packageRels('word/document.xml') },
    {
      name: 'word/document.xml',
      data: xml(`<w:document xmlns:w="${W}" xmlns:r="${OFFICE_RELS}"><w:body>`
        + `<w:p><w:pPr><w:pStyle w:val="Titre1"/></w:pPr><w:r><w:t xml:space="preserve">${escapeText(title)}</w:t></w:r></w:p>`
        + '<w:p/>'
        + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="708"/></w:sectPr>'
        + '</w:body></w:document>'),
    },
    {
      name: 'word/_rels/document.xml.rels',
      data: xml(`<Relationships xmlns="${PKG_RELS}">`
        + `<Relationship Id="rId1" Type="${OFFICE_RELS}/styles" Target="styles.xml"/>`
        + `<Relationship Id="rId2" Type="${OFFICE_RELS}/settings" Target="settings.xml"/>`
        + '</Relationships>'),
    },
    {
      name: 'word/styles.xml',
      data: xml(`<w:styles xmlns:w="${W}">`
        + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="fr-FR" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>'
        + '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
        + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
        + '<w:style w:type="character" w:default="1" w:styleId="Policepardfaut"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>'
        + '<w:style w:type="paragraph" w:styleId="Titre"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/><w:pPr><w:spacing w:after="80"/></w:pPr><w:rPr><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>'
        + heading(1, 32, 360) + heading(2, 26, 240) + heading(3, 24, 160)
        + '</w:styles>'),
    },
    { name: 'word/settings.xml', data: xml(`<w:settings xmlns:w="${W}"><w:defaultTabStop w:val="708"/><w:characterSpacingControl w:val="doNotCompress"/></w:settings>`) },
    { name: 'docProps/core.xml', data: coreProperties(title, author, now) },
    { name: 'docProps/app.xml', data: appProperties('WorkLogs') },
  ], now);
}

const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

async function newXlsx(title: string, author: string, now: Date): Promise<Uint8Array> {
  return createZip([
    {
      name: '[Content_Types].xml',
      data: xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
        + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
        + '</Types>'),
    },
    { name: '_rels/.rels', data: packageRels('xl/workbook.xml') },
    {
      name: 'xl/workbook.xml',
      data: xml(`<workbook xmlns="${S}" xmlns:r="${OFFICE_RELS}"><workbookPr/>`
        + '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="15600"/></bookViews>'
        + '<sheets><sheet name="Feuil1" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029"/></workbook>'),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: xml(`<Relationships xmlns="${PKG_RELS}">`
        + `<Relationship Id="rId1" Type="${OFFICE_RELS}/worksheet" Target="worksheets/sheet1.xml"/>`
        + `<Relationship Id="rId2" Type="${OFFICE_RELS}/styles" Target="styles.xml"/>`
        + `<Relationship Id="rId3" Type="${OFFICE_RELS}/sharedStrings" Target="sharedStrings.xml"/>`
        + '</Relationships>'),
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: xml(`<worksheet xmlns="${S}" xmlns:r="${OFFICE_RELS}"><dimension ref="A1"/>`
        + '<sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>'
        + '<sheetData/><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>'),
    },
    {
      name: 'xl/styles.xml',
      data: xml(`<styleSheet xmlns="${S}">`
        + '<fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>'
        + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
        + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        + '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
        + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        + '<dxfs count="0"/><tableStyles count="0"/></styleSheet>'),
    },
    { name: 'xl/sharedStrings.xml', data: xml(`<sst xmlns="${S}" count="0" uniqueCount="0"/>`) },
    { name: 'docProps/core.xml', data: coreProperties(title, author, now) },
    { name: 'docProps/app.xml', data: appProperties('WorkLogs') },
  ], now);
}

/** Les octets d'un fichier neuf de ce type ; `title` : son nom sans extension. */
export async function newFileBytes(ext: NewFileType['ext'], { title, author, now = new Date() }: { title: string; author: string; now?: Date }): Promise<Uint8Array> {
  switch (ext) {
    case 'docx': return newDocx(title, author, now);
    case 'xlsx': return newXlsx(title, author, now);
    // Markdown : le titre, en UTF-8 (les outils Markdown n'aiment pas le BOM).
    case 'md': return encoder.encode(`# ${title}\n\n`);
    // Texte et CSV : UTF-8 avec BOM, pour que le Bloc-notes et Excel du TSE lisent les accents.
    case 'txt':
    case 'csv': return new Uint8Array(BOM);
  }
}
