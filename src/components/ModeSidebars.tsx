import { useEffect, useState } from 'react';
import type { WorkspaceEntry } from '@shared/ide/types';
import type { Plan } from '@shared/plan/types';
import { hub } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { ThreeDTools } from './ThreeDTools';
import { Modal, cx } from './ui';

interface SidebarProps {
  pinned?: boolean;
  onClose?: () => void;
}

type ThreeDProject = Awaited<ReturnType<typeof hub.threedList>>[number];

export function ThreeDSidebar({ pinned, onClose }: SidebarProps) {
  const projectId = useHub((state) => state.threeDProjectId);
  const revision = useHub((state) => state.threeDRevision);
  const { setThreeDProjectId, bumpThreeDRevision } = useHub.getState();

  const [projects, setProjects] = useState<ThreeDProject[]>([]);
  const [toolsOpen, setToolsOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    void hub.threedList()
      .then((list) => {
        if (!alive) {
          return;
        }
        setProjects(list);
        if (!useHub.getState().threeDProjectId && list.length > 0) {
          setThreeDProjectId(list[0].id);
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [revision, setThreeDProjectId]);

  const createProject = async () => {
    const created = await hub.threedCreate(t('Neues 3D-Projekt'));
    setThreeDProjectId(created.id);
    bumpThreeDRevision();
  };

  const deleteProject = async (id: string) => {
    await hub.threedDelete(id);
    const list = await hub.threedList();
    setProjects(list);
    if (projectId === id) {
      setThreeDProjectId(list[0]?.id ?? '');
    }
    bumpThreeDRevision();
  };

  return (
    <aside className="flex h-full min-h-0 w-full min-w-0 flex-col select-none">
      <div className="flex items-center gap-1.5 px-2.5 pb-2 pt-2.5">
        <button className="btn btn-primary min-w-0 flex-1 justify-center gap-2" onClick={() => void createProject()}>
          <Icon name="lucide:plus" size={15} />
          <span className="truncate">{t('Neues 3D-Projekt')}</span>
        </button>
        {!pinned && onClose && (
          <button className="icon-btn !size-8 shrink-0 text-muted hover:text-fg md:hidden" title={t('Schließen')} onClick={onClose}>
            <Icon name="lucide:x" size={15} />
          </button>
        )}
      </div>

      <div className="px-3 pb-1 pt-1 text-[10.5px] font-semibold uppercase tracking-wider text-subtle">
        {t('Projekte')} ({projects.length})
      </div>

      <div className="sidebar-scroll min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        {projects.length === 0 && (
          <p className="px-2 py-6 text-center text-[12px] text-subtle">{t('Noch keine 3D-Projekte.')}</p>
        )}
        {projects.map((project) => {
          const selected = project.id === projectId;
          return (
            <div
              key={project.id}
              className={cx(
                'group flex items-center gap-2 rounded-lumen-sm px-2.5 py-2 transition-colors',
                selected ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg',
              )}
            >
              <button className="min-w-0 flex-1 text-left" onClick={() => setThreeDProjectId(project.id)}>
                <span className="block truncate text-[12.5px] font-medium">{project.name}</span>
                <span className="block text-[10.5px] text-subtle">{new Date(project.updatedAt).toLocaleDateString()}</span>
              </button>
              <button
                className="icon-btn hidden !size-6 group-hover:grid"
                title={t('Projekt löschen')}
                onClick={() => void deleteProject(project.id)}
              >
                <Icon name="lucide:trash-2" size={12} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="border-t border-edge p-2">
        <button
          className="flex w-full items-center justify-between rounded-lumen-sm px-2.5 py-2 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg"
          onClick={() => setToolsOpen(true)}
        >
          <span className="flex items-center gap-2">
            <Icon name="lucide:wrench" size={13} />
            <span>{t('Blockbench & Blender')}</span>
          </span>
          <Icon name="lucide:chevron-right" size={13} className="text-subtle" />
        </button>
      </div>
      {toolsOpen && (
        <Modal title={t('Blockbench & Blender')} onClose={() => setToolsOpen(false)}>
          <ThreeDTools embedded />
        </Modal>
      )}
    </aside>
  );
}

function IdeFileTree({ root, directory, selected, depth = 0, onOpen }: { root: string; directory?: string; selected: string; depth?: number; onOpen: (path: string) => void }) {
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    void hub.ideList(root, directory)
      .then((result) => { if (active) { setEntries(result); } })
      .catch(() => {});
    return () => { active = false; };
  }, [root, directory]);

  return (
    <div>
      {entries.map((entry) => {
        const isOpen = expanded.includes(entry.path);
        const isSelected = selected === entry.path;
        return (
          <div key={entry.path}>
            <button
              className={cx(
                'flex w-full items-center gap-1.5 rounded-lumen-sm py-1 pr-2 text-left text-[12px] transition-colors',
                isSelected ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg',
              )}
              style={{ paddingLeft: `${8 + depth * 12}px` }}
              title={entry.path}
              onClick={() => {
                if (!entry.isDirectory) {
                  onOpen(entry.path);
                  return;
                }
                setExpanded((previous) => previous.includes(entry.path) ? previous.filter((path) => path !== entry.path) : [...previous, entry.path]);
              }}
            >
              {entry.isDirectory ? (
                <>
                  <Icon name={isOpen ? 'lucide:chevron-down' : 'lucide:chevron-right'} size={12} className="shrink-0 text-subtle" />
                  <Icon name={isOpen ? 'lucide:folder-open' : 'lucide:folder'} size={13} className="shrink-0 text-accent/80" />
                </>
              ) : (
                <>
                  <span className="w-3 shrink-0" />
                  <Icon name="lucide:file-code" size={13} className="shrink-0 text-subtle" />
                </>
              )}
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            </button>
            {isOpen && <IdeFileTree root={root} directory={entry.path} selected={selected} depth={depth + 1} onOpen={onOpen} />}
          </div>
        );
      })}
    </div>
  );
}

export function IdeSidebar({ pinned, onClose }: SidebarProps) {
  const root = useHub((state) => state.ideRootPath);
  const selectedFile = useHub((state) => state.ideOpenFile?.path ?? '');
  const { openIdeFile, triggerIdeQuickAction, triggerIdePlanAction } = useHub.getState();

  const [section, setSection] = useState<'files' | 'plans'>('files');
  const [plans, setPlans] = useState<Plan[]>([]);

  useEffect(() => {
    if (section !== 'plans') {
      return;
    }
    let alive = true;
    void hub.planList().then((list) => { if (alive) { setPlans(list); } }).catch(() => {});
    return () => { alive = false; };
  }, [section]);

  // Der Wechsel läuft über den Workspace selbst: nur er kennt ungespeicherte Änderungen und offene Dateien.
  const pickWorkspace = () => useHub.getState().requestIdeWorkspace();

  const workspaceName = root ? root.split(/[\\/]/).filter(Boolean).pop() ?? root : '';

  return (
    <aside className="flex h-full min-h-0 w-full min-w-0 flex-col select-none">
      <div className="flex items-center gap-1.5 px-2.5 pb-2 pt-2.5">
        <button className="btn min-w-0 flex-1 justify-start gap-2 !px-2.5" title={root || t('Workspace wählen')} onClick={() => void pickWorkspace()}>
          <Icon name="lucide:folder-open" size={14} className="shrink-0 text-accent" />
          <span className="truncate text-[12px]">{workspaceName || t('Workspace wählen')}</span>
        </button>
        {!pinned && onClose && (
          <button className="icon-btn !size-8 shrink-0 text-muted hover:text-fg md:hidden" title={t('Schließen')} onClick={onClose}>
            <Icon name="lucide:x" size={15} />
          </button>
        )}
      </div>

      <div className="flex items-center gap-1 px-2.5 pb-2">
        <div className="grid flex-1 grid-cols-2 rounded-full border border-edge bg-bg/60 p-0.5 text-[11.5px]">
          <button
            onClick={() => setSection('files')}
            className={cx('rounded-full py-1 font-medium transition-colors', section === 'files' ? 'bg-overlay text-fg shadow-xs' : 'text-subtle hover:text-muted')}
          >
            {t('Dateien')}
          </button>
          <button
            onClick={() => setSection('plans')}
            className={cx('rounded-full py-1 font-medium transition-colors', section === 'plans' ? 'bg-overlay text-fg shadow-xs' : 'text-subtle hover:text-muted')}
          >
            {t('Pläne')}
          </button>
        </div>
        {section === 'files' && root && (
          <>
            <button className="icon-btn !size-7" title={t('Datei öffnen (Strg+P)')} onClick={() => triggerIdeQuickAction('files')}>
              <Icon name="lucide:file-search" size={13} />
            </button>
            <button className="icon-btn !size-7" title={t('Im Projekt suchen (Strg+Shift+F)')} onClick={() => triggerIdeQuickAction('content')}>
              <Icon name="lucide:search" size={13} />
            </button>
          </>
        )}
        {section === 'plans' && (
          <button className="icon-btn !size-7" title={t('Neuer Plan')} onClick={() => triggerIdePlanAction('new')}>
            <Icon name="lucide:plus" size={14} />
          </button>
        )}
      </div>

      <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {section === 'files' ? (
          root ? (
            <IdeFileTree root={root} selected={selectedFile} onOpen={openIdeFile} />
          ) : (
            <p className="px-3 py-6 text-center text-[12px] text-subtle">{t('Kein Workspace geöffnet.')}</p>
          )
        ) : (
          <div className="space-y-0.5 px-1">
            {plans.length === 0 && (
              <p className="px-2 py-6 text-center text-[12px] text-subtle">{t('Noch keine Pläne gespeichert.')}</p>
            )}
            {plans.map((plan) => (
              <button
                key={plan.id}
                className="block w-full rounded-lumen-sm px-2.5 py-2 text-left text-muted transition-colors hover:bg-hover hover:text-fg"
                onClick={() => triggerIdePlanAction('select', plan.id)}
              >
                <span className="block truncate text-[12.5px] font-medium">{plan.title}</span>
                <span className="text-[10.5px] text-subtle">{plan.status}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
