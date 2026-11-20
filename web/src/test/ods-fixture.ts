import { buildZip } from './docx-fixture';

const OFFICE = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
const TABLE = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
const TEXT = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const META = 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0';

export function odsWorkbook() {
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="${OFFICE}" xmlns:table="${TABLE}" xmlns:text="${TEXT}" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2">
  <office:body><office:spreadsheet>
    <table:table table:name="Données">
      <table:table-row>
        <table:table-cell office:value-type="string"><text:p>Libellé</text:p></table:table-cell>
        <table:table-cell office:value-type="float" office:value="12.5"><text:p>12,5</text:p></table:table-cell>
        <table:table-cell office:value-type="float" office:value="30" table:formula="of:=SUM([.B1:.B2])"><text:p>30</text:p></table:table-cell>
        <table:table-cell office:value-type="date" office:date-value="2026-11-20T00:00:00"><text:p>20/11/2026</text:p></table:table-cell>
      </table:table-row>
      <table:table-row-group>
        <table:table-row>
          <table:table-cell office:value-type="string"><text:p>Deuxième</text:p></table:table-cell>
          <table:table-cell office:value-type="float" office:value="17.5"><text:p>17,5</text:p></table:table-cell>
        </table:table-row>
      </table:table-row-group>
    </table:table>
    <table:table table:name="Résumé" table:is-hidden="true">
      <table:table-row><table:table-cell office:value-type="string"><text:p>Résumé initial</text:p></table:table-cell></table:table-row>
    </table:table>
  </office:spreadsheet></office:body>
</office:document-content>`;
  const meta = `<?xml version="1.0" encoding="UTF-8"?><office:document-meta xmlns:office="${OFFICE}" xmlns:meta="${META}"><office:meta><meta:initial-creator>Camille</meta:initial-creator><meta:creator>Camille</meta:creator><meta:date>2026-01-01T00:00:00Z</meta:date></office:meta></office:document-meta>`;
  return buildZip([
    { name: 'mimetype', data: 'application/vnd.oasis.opendocument.spreadsheet', deflate: false },
    { name: 'content.xml', data: content },
    { name: 'meta.xml', data: meta },
  ]);
}
