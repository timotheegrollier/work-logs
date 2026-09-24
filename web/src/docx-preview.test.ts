import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DocxError, readDocx } from './docx-preview';

const bytes = (buffer: Buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
// Document produit par LibreOffice (`soffice --convert-to docx`) : le vrai format, pas une imitation.
const fixture = () => bytes(fs.readFileSync(path.resolve('src/__fixtures__/procedure.docx')));

/** Archive zip minimale : `deflate` compresse l'entrée, `size` permet de mentir sur sa taille. */
function zip(files: { name: string; data: string | Buffer; deflate?: boolean; size?: number }[]): ArrayBuffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const data = file.deflate ? zlib.deflateRawSync(raw) : raw;
    const name = Buffer.from(file.name);
    const header = (signature: number, central: boolean) => {
      const h = Buffer.alloc(central ? 46 : 30);
      h.writeUInt32LE(signature, 0);
      const o = central ? 2 : 0;
      h.writeUInt16LE(file.deflate ? 8 : 0, 8 + o);
      h.writeUInt32LE(data.length, 18 + o);
      h.writeUInt32LE(file.size ?? raw.length, 22 + o);
      h.writeUInt16LE(name.length, 26 + o);
      if (central) h.writeUInt32LE(offset, 42);
      return h;
    };
    const local = Buffer.concat([header(0x04034b50, false), name, data]);
    centrals.push(Buffer.concat([header(0x02014b50, true), name]));
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return bytes(Buffer.concat([...locals, central, end]));
}
const doc = (body: string) => `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}</w:body></w:document>`;

describe('aperçu .docx', () => {
  test('document LibreOffice : titres, styles, liste imbriquée d’un seul tenant, tableau, lien, image', async () => {
    const blocks = await readDocx(fixture());
    expect(blocks[0]).toMatchObject({ kind: 'paragraph', level: 1, runs: [{ text: 'Changer le format de la balance' }] });
    const intro = blocks[1];
    expect(intro.kind === 'paragraph' && intro.runs.find((run) => run.bold)?.text).toBe("couper l'alimentation");
    expect(intro.kind === 'paragraph' && intro.runs.find((run) => run.italic)?.text).toBe('vérifier');
    expect(blocks[2]).toMatchObject({ kind: 'paragraph', level: 2 });
    const list = blocks[3];
    expect(list.kind).toBe('list');
    if (list.kind !== 'list') return;
    expect(list.items.map((item) => [item.depth, item.ordered, item.runs.map((run) => run.text).join('')])).toEqual([
      [0, true, 'Ouvrir le menu'], [0, true, 'Choisir Format'], [1, false, '60 x 40 mm'], [1, false, '80 x 50 mm'], [0, true, 'Valider'],
    ]);
    const table = blocks.find((block) => block.kind === 'table');
    expect(table?.kind === 'table' && table.rows.map((row) => row.map((cell) => cell.map((b) => b.kind === 'paragraph' ? b.runs.map((r) => r.text).join('') : '').join('')))).toEqual([['Format', 'Rouleau'], ['60 x 40', 'R-12']]);
    const runs = blocks.flatMap((block) => (block.kind === 'paragraph' ? block.runs : []));
    expect(runs.find((run) => run.href)).toMatchObject({ text: 'notice du fabricant', href: 'https://exemple.fr/aide' });
    expect(runs.find((run) => run.strike)?.text).toBe('ancienne méthode');
    expect(runs.find((run) => run.image)?.image).toMatchObject({ alt: 'schéma', src: expect.stringMatching(/^data:image\/png;base64,iVBOR/) });
  });

  test('entrées stockées ou compressées, texte supprimé en révision ignoré, lien non web écarté', async () => {
    const body = '<w:p><w:r><w:t>gardé</w:t></w:r><w:del><w:r><w:delText>supprimé</w:delText></w:r></w:del><w:hyperlink r:id="rJs"><w:r><w:t>piège</w:t></w:r></w:hyperlink></w:p>';
    const rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rJs" Target="javascript:alert(1)" TargetMode="External"/></Relationships>';
    for (const deflate of [false, true]) {
      const blocks = await readDocx(zip([{ name: 'word/document.xml', data: doc(body), deflate }, { name: 'word/_rels/document.xml.rels', data: rels, deflate }]));
      expect(blocks).toEqual([{ kind: 'paragraph', level: 0, runs: [{ text: 'gardé' }, { text: 'piège', href: undefined }].map((run) => expect.objectContaining(run)) }]);
      expect(JSON.stringify(blocks)).not.toContain('javascript');
    }
  });

  test('erreurs lisibles : pas un zip, pas un Word, bombe de décompression', async () => {
    await expect(readDocx(bytes(Buffer.from('bonjour')))).rejects.toThrow(DocxError);
    await expect(readDocx(zip([{ name: 'autre.txt', data: 'x' }]))).rejects.toThrow(/contenu principal absent/);
    // 60 Mo de zéros annoncés comme 1 Ko : coupé pendant la décompression.
    const bomb = zip([{ name: 'word/document.xml', data: Buffer.alloc(60 * 1024 * 1024), deflate: true, size: 1024 }]);
    await expect(readDocx(bomb)).rejects.toThrow(/trop volumineux/);
  });
});
