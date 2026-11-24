import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';

const entries = [
  { to: '/plan', icon: 'lucide:files', title: 'Workspace & Pläne' },
  { to: '/multi', icon: 'lucide:network', title: 'Multi-Agent' },
  { to: '/models', icon: 'lucide:box', title: 'Modelle' },
  { to: '/workflows', icon: 'lucide:workflow', title: 'Workflows' },
  { to: '/tools', icon: 'lucide:wrench', title: 'Werkzeuge' },
];

export function ActivityRail() {
  const navigate = useNavigate();
  const location = useLocation();
  const inChat = location.pathname === '/' || location.pathname.startsWith('/chat');

  return (
    <nav aria-label="Arbeitsbereiche" className="workbench-rail z-30 flex w-11 shrink-0 flex-col items-center gap-1.5 border-r border-edge py-2.5">
      <button
        className={`workbench-rail-item ${inChat ? 'is-active' : ''}`}
        title="Neuer Chat"
        aria-label="Neuer Chat"
        onClick={() => navigate(`/chat/${useHub.getState().newSession()}`)}
      >
        <Icon name="lucide:messages-square" size={18} />
      </button>
      {entries.map((entry) => (
        <NavLink
          key={entry.to}
          to={entry.to}
          title={entry.title}
          aria-label={entry.title}
          className={({ isActive }) => `workbench-rail-item ${isActive ? 'is-active' : ''}`}
        >
          <Icon name={entry.icon} size={18} />
        </NavLink>
      ))}
      <div className="flex-1" />
      <button
        className="workbench-rail-item"
        title="Einstellungen"
        aria-label="Einstellungen"
        onClick={() => useHub.getState().openSettings()}
      >
        <Icon name="lucide:settings-2" size={18} />
      </button>
    </nav>
  );
}
