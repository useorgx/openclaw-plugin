import { Modal } from '@/components/shared/Modal';
import type { EntityModalTarget } from './MissionControlContext';
import { InitiativeDetail } from './EntityDetailModal.Initiative';
import { WorkstreamDetail } from './EntityDetailModal.Workstream';
import { MilestoneDetail } from './EntityDetailModal.Milestone';
import { TaskDetail } from './EntityDetailModal.Task';
import { EntityIcon } from '@/components/shared/EntityIcon';

interface EntityDetailModalProps {
  target: EntityModalTarget | null;
  onClose: () => void;
}

function breadcrumbLabel(target: EntityModalTarget): string[] {
  const crumbs: string[] = [];
  if (target.type !== 'initiative' && target.initiative) {
    crumbs.push(target.initiative.name);
  }
  if (target.type === 'initiative') {
    crumbs.push(target.entity.name);
  } else if (target.type === 'workstream') {
    crumbs.push(target.entity.name);
  } else if (target.type === 'milestone') {
    crumbs.push(target.entity.title);
  } else if (target.type === 'task') {
    crumbs.push(target.entity.title);
  }
  return crumbs;
}

export function EntityDetailModal({ target, onClose }: EntityDetailModalProps) {
  return (
    <Modal open={target !== null} onClose={onClose} maxWidth="max-w-5xl">
      {target && (
        <div className="flex h-full w-full min-h-0 flex-col">
          {/* Header with breadcrumb + close button */}
          <div className="flex items-center justify-between gap-3 border-b border-subtle px-5 py-3 sm:px-6">
            <div className="flex items-center gap-1.5 min-w-0 text-body text-secondary">
              {breadcrumbLabel(target).map((crumb, i, arr) => (
                <span key={i} className="flex items-center gap-1.5 min-w-0">
                  {i > 0 && (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="flex-shrink-0 text-faint">
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  )}
                  <span className={`truncate ${i === arr.length - 1 ? 'text-primary font-medium' : ''}`}>
                    {crumb}
                  </span>
                </span>
              ))}
              <span className="ml-1 inline-flex items-center gap-1 rounded-full border border-white/[0.1] bg-white/[0.04] px-2 py-0.5 text-micro uppercase tracking-[0.06em] text-secondary">
                <EntityIcon type={target.type} size={11} className="opacity-90" />
                {target.type}
              </span>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close detail"
              className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-strong bg-white/[0.03] text-primary transition-colors hover:bg-white/[0.08] hover:text-white"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 6L6 18" />
                <path d="M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {target.type === 'initiative' && (
              <InitiativeDetail initiative={target.entity} />
            )}
            {target.type === 'workstream' && (
              <WorkstreamDetail
                workstream={target.entity}
                initiative={target.initiative}
              />
            )}
            {target.type === 'milestone' && (
              <MilestoneDetail
                milestone={target.entity}
                initiative={target.initiative}
              />
            )}
            {target.type === 'task' && (
              <TaskDetail task={target.entity} initiative={target.initiative} />
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
