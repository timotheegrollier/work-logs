import { useRef, useState } from 'react';
import type { EntrySummary } from '../lib';

export function DocumentTabs({ tabs, selectedId, onSelect }: { tabs: EntrySummary[]; selectedId: string; onSelect: (id: string) => void }) {
  const [filter, setFilter] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const visible = tabs.filter(tab => (tab.google_tab_title || tab.title).toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  return <aside className="document-navigation no-print" aria-label="Navigation du document">
    <div className="document-navigation-heading"><strong>Onglets</strong><span>{tabs.length}</span></div>
    {tabs.length > 5 && <input type="search" aria-label="Rechercher un onglet" placeholder="Rechercher un onglet…" value={filter} onChange={e => setFilter(e.target.value)} />}
    <div ref={list} className="doc-tabs" role="tablist" aria-label="Onglets du document" aria-orientation="vertical" onKeyDown={event => {
      const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') || [])];
      const index = buttons.indexOf(event.target as HTMLButtonElement);
      if (index < 0 || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}>
      {visible.map(tab => <button key={tab.id} id={`tab-${tab.id}`} role="tab" aria-selected={tab.id === selectedId}
        aria-controls="document-tab-panel" tabIndex={tab.id === selectedId || (!visible.some(t => t.id === selectedId) && tab === visible[0]) ? 0 : -1}
        className={'doc-tab' + (tab.id === selectedId ? ' is-on' : '')} data-depth={Math.min(tab.google_tab_depth || 0, 3)}
        title={tab.google_tab_title || tab.title} onClick={() => onSelect(tab.id)}>
        <span className="doc-tab-symbol" aria-hidden="true">▤</span>
        <span className="doc-tab-title">{tab.google_tab_title || 'Onglet'}</span>
        {tab.google_dirty ? <span className="doc-tab-dirty" aria-label="Modifications à envoyer">●</span> : null}
      </button>)}
    </div>
    {!visible.length && <p className="empty">Aucun onglet trouvé.</p>}
    <p className="document-navigation-hint">Un brouillon enregistré par onglet.</p>
  </aside>;
}
