import { describe, expect, it } from 'vitest';
import { crc32, readZip, readZipEntry, readZipText, writeZip, ZipError } from './zip';
import { attrNS, elements, findChild, scanXml, XmlScanError } from './xml-scan';
import { buildZip } from './test/docx-fixture';

const text = (value: string) => new TextEncoder().encode(value);

describe('zip', () => {
  it('CRC-32 de référence', () => {
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
  });

  it('rien de modifié : les octets d’origine ; une entrée remplacée : les autres recopiées telles quelles', async () => {
    const bytes = buildZip([
      { name: 'a.xml', data: '<a>première</a>' },
      { name: 'b.bin', data: new Uint8Array([1, 2, 3]), deflate: false },
      { name: 'c.xml', data: '<c/>', descriptor: true },
    ]);
    const archive = readZip(bytes);
    expect(await writeZip(archive, new Map())).toBe(bytes);

    const out = await writeZip(archive, new Map([['a.xml', text('<a>seconde, plus longue</a>')], ['c.xml', text('<c>remplacée</c>')]]));
    const again = readZip(out);
    expect(again.entries.map((entry) => entry.name)).toEqual(['a.xml', 'b.bin', 'c.xml']);
    expect(await readZipText(again, 'a.xml')).toBe('<a>seconde, plus longue</a>');
    expect(await readZipText(again, 'c.xml')).toBe('<c>remplacée</c>');
    const b0 = archive.byName.get('b.bin')!;
    const b1 = again.byName.get('b.bin')!;
    expect(Buffer.from(out.subarray(b1.localOffset, b1.recordEnd)).equals(Buffer.from(bytes.subarray(b0.localOffset, b0.recordEnd)))).toBe(true);
    // Le descripteur de l'entrée remplacée disparaît : tailles et CRC dans l'en-tête.
    expect(again.byName.get('c.xml')!.flags & 8).toBe(0);
    expect(again.byName.get('a.xml')!.crc).toBe(crc32(text('<a>seconde, plus longue</a>')));
    expect(Array.from(await readZipEntry(again, b1))).toEqual([1, 2, 3]);
  });

  it('refuse ancien format Office, archive chiffrée, zip64 et entrées en double', () => {
    expect(() => readZip(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toThrow(/ancien format/);
    const encrypted = buildZip([{ name: 'a', data: 'x' }]);
    const central = Buffer.from(encrypted).lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    encrypted[central + 8] |= 1;
    expect(() => readZip(encrypted)).toThrow(/chiffré/);
    const doubled = buildZip([{ name: 'a', data: 'x' }, { name: 'a', data: 'y' }]);
    expect(() => readZip(doubled)).toThrow(/double/);
    const zip64 = buildZip([{ name: 'a', data: 'x' }]);
    new DataView(zip64.buffer).setUint32(zip64.length - 6, 0xffffffff, true);
    expect(() => readZip(zip64)).toThrow(ZipError);
  });
});

describe('analyseur XML à positions', () => {
  const xml = '<?xml version="1.0"?>\r\n<!-- note --><w:document xmlns:w="urn:w" xmlns:x="urn:x"><w:body><w:p x:id="1"><w:t xml:space="preserve">a &amp; b &#233;</w:t></w:p><w:p/><![CDATA[<brut>]]></w:body></w:document>';

  it('garde les positions exactes de chaque élément', () => {
    const root = scanXml(xml);
    const body = findChild(root, 'urn:w', 'body')!;
    const [p1, p2] = elements(body);
    expect(xml.slice(p1.start, p1.end)).toBe('<w:p x:id="1"><w:t xml:space="preserve">a &amp; b &#233;</w:t></w:p>');
    expect(xml.slice(p2.start, p2.end)).toBe('<w:p/>');
    expect(p2.selfClosing).toBe(true);
    expect(xml.slice(body.openEnd, body.closeStart)).toContain('<![CDATA[<brut>]]>');
  });

  it('résout les espaces de noms des éléments et des attributs, décode les entités', () => {
    const root = scanXml(xml);
    const p1 = elements(findChild(root, 'urn:w', 'body')!)[0];
    expect(p1.ns).toBe('urn:w');
    expect(attrNS(p1, 'urn:x', 'id')).toBe('1');
    const t = findChild(p1, 'urn:w', 't')!;
    expect(t.children[0]).toMatchObject({ kind: 'text', value: 'a & b é' });
  });

  it('refuse DOCTYPE, balises mal fermées et plusieurs racines', () => {
    expect(() => scanXml('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x/>')).toThrow(XmlScanError);
    expect(() => scanXml('<a><b></a>')).toThrow(/inattendue/);
    expect(() => scanXml('<a/><b/>')).toThrow(/racine/);
    expect(() => scanXml('<a>')).toThrow(/non fermé/);
  });
});
