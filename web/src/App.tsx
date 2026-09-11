import { useEffect, useState } from 'react';
import './styles.css';
import { api, type Project } from './lib';
import { GlobalSearch } from './components/ui';
import Dashboard from './pages/Dashboard';
import Kanban from './pages/Kanban';
import Todos from './pages/Todos';
import Agenda from './pages/Agenda';
import Docs from './pages/Docs';
import { Files } from './pages/Projects';
import Projects from './pages/Projects';

type Tab = 'dash' | 'kanban' | 'todos' | 'agenda' | 'docs' | 'files' | 'projects';
const NAV: { id: Tab; label: string; icon: string }[] = [
  { id: 'dash', label: 'Dashboard', icon: '🏠' },
  { id: 'kanban', label: 'Kanban', icon: '📋' },
  { id: 'todos', label: 'Todos', icon: '✓' },
  { id: 'agenda', label: 'Agenda', icon: '📅' },
  { id: 'docs', label: 'Docs', icon: '📝' },
  { id: 'files', label: 'Fichiers', icon: '📎' },
  { id: 'projects', label: 'Projets', icon: '📁' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('dash');
  const [projects, setProjects] = useState<Project[]>([]);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    api.projects().then(setProjects).catch((e) => setErr(e.message + ' — API injoignable ? lance `npm run dev:api` (port 8410).'));
  }, [tick]);
  const reloadAll = () => setTick((t) => t + 1);

  return (
    <div className="app">
      <aside className="side">
        <div className="logo">Work<span>Logs</span></div>
        <nav className="nav">
          {NAV.map((n) => (
            <button key={n.id} className={tab === n.id ? 'on' : ''} onClick={() => setTab(n.id)}>
              <span>{n.icon}</span><span className="lbl">{n.label}</span>
            </button>
          ))}
        </nav>
        <div style={{ flex: 1 }} />
        <div className="lbl" style={{ color: '#93a0bb', fontSize: 12, padding: '0 8px' }}>
          {projects.length} projet(s)<br />100% local · SQLite
        </div>
      </aside>
      <main className="main">
        <div className="top">
          <GlobalSearch onGo={(t) => setTab(t as Tab)} />
          <div className="sp" />
          <small style={{ color: '#93a0bb' }}>cockpit perso · Trello × Jira × Todo × Agenda × Drive</small>
        </div>
        {err && <div className="err">{err}</div>}
        {tab === 'dash' && <Dashboard projects={projects} reloadAll={reloadAll} />}
        {tab === 'kanban' && <Kanban projects={projects} reloadAll={reloadAll} />}
        {tab === 'todos' && <Todos projects={projects} reloadAll={reloadAll} />}
        {tab === 'agenda' && <Agenda projects={projects} />}
        {tab === 'docs' && <Docs projects={projects} />}
        {tab === 'files' && <Files projects={projects} />}
        {tab === 'projects' && <Projects projects={projects} reloadAll={reloadAll} />}
        <div className="foot">WorkLogs V1 · données en local (`api/data/worklogs.db`) · API :8410 · Web :8411</div>
      </main>
    </div>
  );
}
