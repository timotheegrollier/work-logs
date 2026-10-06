import zlib from 'node:zlib';

/**
 * Archives zip et documents Word **construits pour les tests**, à la manière de
 * Word : espaces de noms `w14`/`mc`, signets autour des titres, `w14:paraId`,
 * runs à propriétés riches, numérotation, lien externe, image, table des
 * matières (sdt), tableau, section finale. À confronter, sur le TSE, aux vrais
 * documents de l'équipe (`docs/00-HANDOVER.md`, lot 0).
 */

export interface ZipFile {
  name: string;
  data: string | Uint8Array;
  /** Méthode 8 (deflate) par défaut ; `false` = stockée. */
  deflate?: boolean;
  /** Descripteur de données après l'entrée (comme LibreOffice ou Java). */
  descriptor?: boolean;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildZip(files: ZipFile[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const raw = typeof file.data === 'string' ? Buffer.from(file.data, 'utf8') : Buffer.from(file.data);
    const deflate = file.deflate !== false;
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(raw);
    const flags = file.descriptor ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags | 0x800, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt16LE(0x6000, 10);
    local.writeUInt16LE(0x5945, 12);
    local.writeUInt32LE(file.descriptor ? 0 : crc, 14);
    local.writeUInt32LE(file.descriptor ? 0 : data.length, 18);
    local.writeUInt32LE(file.descriptor ? 0 : raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const parts = [local, name, data];
    if (file.descriptor) {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(data.length, 8);
      descriptor.writeUInt32LE(raw.length, 12);
      parts.push(descriptor);
    }
    const record = Buffer.concat(parts);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags | 0x800, 8);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt16LE(0x6000, 12);
    central.writeUInt16LE(0x5945, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    locals.push(record);
    offset += record.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

const NS = 'xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" '
  + 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
  + 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
  + 'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="w14"';

/** Corps par défaut : un échantillon de ce que Word écrit pour une procédure. */
export const WORD_BODY = [
  // b0 — titre entouré d'un signet de table des matières.
  '<w:p w14:paraId="1A2B3C4D" w14:textId="77777777" w:rsidR="00A1"><w:pPr><w:pStyle w:val="Titre1"/><w:spacing w:after="120"/></w:pPr>'
    + '<w:bookmarkStart w:id="0" w:name="_Toc1"/><w:r><w:t>Filtration</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>',
  // b1 — paragraphe aux runs riches.
  '<w:p w14:paraId="2B3C4D5E" w14:textId="77777777"><w:pPr><w:spacing w:before="60"/><w:ind w:left="0"/></w:pPr>'
    + '<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:i/><w:color w:val="FF0000"/><w:lang w:val="fr-FR"/></w:rPr><w:t xml:space="preserve">Laver </w:t></w:r>'
    + '<w:proofErr w:type="spellStart"/><w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t>le filtre</w:t></w:r><w:proofErr w:type="spellEnd"/>'
    + '<w:r><w:t xml:space="preserve"> chaque lundi.</w:t></w:r></w:p>',
  // b2 — lien externe.
  '<w:p><w:r><w:t xml:space="preserve">Voir </w:t></w:r><w:hyperlink r:id="rId9" w:history="1"><w:r><w:rPr><w:rStyle w:val="Lienhypertexte"/></w:rPr><w:t>le guide</w:t></w:r></w:hyperlink><w:r><w:t>.</w:t></w:r></w:p>',
  // b3, b4 — liste numérotée sur deux niveaux.
  '<w:p><w:pPr><w:pStyle w:val="Paragraphedeliste"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Arrêter la pompe</w:t></w:r></w:p>',
  '<w:p><w:pPr><w:pStyle w:val="Paragraphedeliste"/><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Vanne fermée</w:t></w:r></w:p>',
  // b5 — image (objet conservé).
  '<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Image 1"/></wp:inline></w:drawing></w:r><w:r><w:t xml:space="preserve"> schéma</w:t></w:r></w:p>',
  // b6 — tableau simple 2 × 2.
  '<w:tbl><w:tblPr><w:tblStyle w:val="Grilledutableau"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4531"/><w:gridCol w:w="4531"/></w:tblGrid>'
    + '<w:tr><w:tc><w:tcPr><w:tcW w:w="4531" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>Mesure</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="4531" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>Valeur</w:t></w:r></w:p></w:tc></w:tr>'
    + '<w:tr><w:tc><w:tcPr><w:tcW w:w="4531" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>pH</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="4531" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>7,2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
  // b7 — table des matières (contrôle de contenu).
  '<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/><w:docPartUnique/></w:docPartObj></w:sdtPr><w:sdtContent><w:p><w:r><w:t>Table des matières</w:t></w:r></w:p></w:sdtContent></w:sdt>',
  // b8 — paragraphe vide, auto-fermant.
  '<w:p/>',
].join('');

export function wordDocx({ body = WORD_BODY, trackRevisions = false, author = 'Jean Dupont', descriptor = false } = {}): Uint8Array {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:document ${NS}><w:body>${body}`
    + '<w:sectPr w:rsidR="00A1"><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417"/></w:sectPr></w:body></w:document>';
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Titre1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Titre2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Paragraphedeliste"><w:name w:val="List Paragraph"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="TM1"><w:name w:val="toc 1"/><w:semiHidden/></w:style>'
    + '<w:style w:type="character" w:styleId="Lienhypertexte"><w:name w:val="Hyperlink"/></w:style></w:styles>';
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
    + '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>'
    + '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/></w:lvl></w:abstractNum>'
    + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>';
  const settings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
    + `${trackRevisions ? '<w:trackRevisions/>' : ''}<w:defaultTabStop w:val="708"/></w:settings>`;
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" `
    + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `<dc:creator>Hélène Martin</dc:creator><cp:lastModifiedBy>${author}</cp:lastModifiedBy><cp:revision>3</cp:revision>`
    + '<dcterms:created xsi:type="dcterms:W3CDTF">2026-09-01T08:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-10-01T09:14:00Z</dcterms:modified></cp:coreProperties>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  const documentRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
    + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>'
    + '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://exemple.fr/guide" TargetMode="External"/></Relationships>';
  const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  return buildZip([
    { name: '[Content_Types].xml', data: types },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: document, descriptor },
    { name: 'word/_rels/document.xml.rels', data: documentRels },
    { name: 'word/styles.xml', data: styles, descriptor },
    { name: 'word/numbering.xml', data: numbering },
    { name: 'word/settings.xml', data: settings },
    { name: 'word/media/image1.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), deflate: false },
    { name: 'docProps/core.xml', data: core },
  ]);
}
