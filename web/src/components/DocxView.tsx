import { useEffect, useState, type ReactNode } from 'react';
import { readDocx, type DocxBlock, type DocxListItem, type DocxRun } from '../docx-preview';

/** Rendu d'un .docx dans l'aperçu : éléments React seulement, jamais de HTML brut. */
export function DocxView({ url, filename }: { url: string; filename: string }) {
  const [blocks, setBlocks] = useState<DocxBlock[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setBlocks(null);
    setError('');
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error('fichier local absent — récupère-le depuis Drive');
        return res.arrayBuffer();
      })
      .then(readDocx)
      .then((result) => { if (alive) setBlocks(result); })
      .catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [url]);

  if (error) return <p role="alert">{error}</p>;
  if (!blocks) return <p>Lecture du document…</p>;
  return (
    <article className="docx-view prose" aria-label={`Contenu de ${filename}`}>
      <p className="viewer-notice">Aperçu simplifié : texte, titres, listes, tableaux et images. Pour la mise en page exacte, « Ouvrir avec… ».</p>
      {blocks.length ? blocks.map(renderBlock) : <p className="empty">Document vide.</p>}
    </article>
  );
}

function renderRuns(runs: DocxRun[]): ReactNode {
  return runs.map((run, index) => {
    if (run.image) return <img key={index} src={run.image.src} alt={run.image.alt} />;
    let node: ReactNode = run.text.includes('\n')
      ? run.text.split('\n').flatMap((part, i) => (i ? [<br key={`br${i}`} />, part] : [part]))
      : run.text;
    if (run.bold) node = <strong>{node}</strong>;
    if (run.italic) node = <em>{node}</em>;
    if (run.underline) node = <u>{node}</u>;
    if (run.strike) node = <s>{node}</s>;
    if (run.href) node = <a href={run.href} target="_blank" rel="noopener noreferrer">{node}</a>;
    return <span key={index}>{node}</span>;
  });
}

/**
 * Imbrication par profondeur : une sous-liste va dans l'élément qui la précède,
 * pour que la numérotation du niveau parent continue après elle (1, 2, 3).
 */
function renderList(items: DocxListItem[], key: number | string): ReactNode {
  const build = (start: number, depth: number): [ReactNode, number] => {
    const entries: { runs: DocxRun[]; nested: ReactNode[]; index: number }[] = [];
    let i = start;
    while (i < items.length && items[i].depth >= depth) {
      if (items[i].depth > depth) {
        const [nested, next] = build(i, items[i].depth);
        if (entries.length) entries[entries.length - 1].nested.push(nested);
        else entries.push({ runs: [], nested: [nested], index: i });
        i = next;
        continue;
      }
      entries.push({ runs: items[i].runs, nested: [], index: i });
      i++;
    }
    const List = items[start].ordered ? 'ol' : 'ul';
    return [
      <List key={`${key}-${start}`}>
        {entries.map((entry) => <li key={entry.index}>{renderRuns(entry.runs)}{entry.nested}</li>)}
      </List>,
      i,
    ];
  };
  return build(0, Math.min(...items.map((item) => item.depth)))[0];
}

function renderBlock(block: DocxBlock, key: number): ReactNode {
  if (block.kind === 'list') return renderList(block.items, key);
  if (block.kind === 'table') {
    return (
      <div className="docx-table" key={key}>
        <table>
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={r}>{row.map((cell, c) => <td key={c}>{cell.map(renderBlock)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const style = block.align ? { textAlign: block.align } : undefined;
  const content = renderRuns(block.runs);
  switch (block.level) {
    case 1: return <h1 key={key} style={style}>{content}</h1>;
    case 2: return <h2 key={key} style={style}>{content}</h2>;
    case 3: return <h3 key={key} style={style}>{content}</h3>;
    case 4: return <h4 key={key} style={style}>{content}</h4>;
    case 5: return <h5 key={key} style={style}>{content}</h5>;
    case 6: return <h6 key={key} style={style}>{content}</h6>;
    default: return block.runs.length ? <p key={key} style={style}>{content}</p> : <p key={key} className="docx-blank" aria-hidden="true" />;
  }
}
