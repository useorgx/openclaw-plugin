import { AnimatePresence, motion } from 'framer-motion';
import { Modal } from '@/components/shared/Modal';
import type { EntityModalTarget } from './MissionControlContext';
import { InitiativeDetail } from './EntityDetailModal.Initiative';
import { WorkstreamDetail } from './EntityDetailModal.Workstream';
import { MilestoneDetail } from './EntityDetailModal.Milestone';
import { TaskDetail } from './EntityDetailModal.Task';
import { IwmtLevelIcon, iwmtLevelCode } from './IwmtLevelIcon';
import type { MissionControlNodeType } from '@/types';

interface EntityDetailModalProps {
  target: EntityModalTarget | null;
  onClose: () => void;
}

interface HeaderBreadcrumbItem {
  id: string;
  label: string;
  level: MissionControlNodeType;
}

function resolveWorkstreamName(target: EntityModalTarget): string | null {
  if (target.type === 'initiative') return null;
  if (target.type === 'workstream') return target.entity.name;
  const workstreamId = target.entity.workstreamId;
  if (!workstreamId) return null;
  return (
    target.initiative.workstreams?.find((workstream) => workstream.id === workstreamId)?.name ??
    null
  );
}

function buildHeaderBreadcrumbs(target: EntityModalTarget): HeaderBreadcrumbItem[] {
  if (target.type === 'initiative') {
    return [
      {
        id: target.entity.id,
        label: target.entity.name,
        level: 'initiative',
      },
    ];
  }

  const items: HeaderBreadcrumbItem[] = [
    {
      id: target.initiative.id,
      label: target.initiative.name,
      level: 'initiative',
    },
  ];

  const workstreamName = resolveWorkstreamName(target);
  const workstreamId =
    target.type === 'workstream' ? target.entity.id : target.entity.workstreamId;
  if (workstreamName && workstreamId) {
    items.push({
      id: workstreamId,
      label: workstreamName,
      level: 'workstream',
    });
  }

  if (target.type === 'milestone') {
    items.push({
      id: target.entity.id,
      label: target.entity.title,
      level: 'milestone',
    });
  } else if (target.type === 'task') {
    items.push({
      id: target.entity.id,
      label: target.entity.title,
      level: 'task',
    });
  }

  return items;
}

function hierarchyTag(target: EntityModalTarget): string {
  if (target.type === 'initiative') return target.entity.hierarchyLabel ?? iwmtLevelCode('initiative');
  if (target.type === 'workstream') return target.entity.hierarchyLabel ?? iwmtLevelCode('workstream');
  if (target.type === 'milestone') return target.entity.hierarchyLabel ?? iwmtLevelCode('milestone');
  return target.entity.hierarchyLabel ?? iwmtLevelCode('task');
}

export function EntityDetailModal({ target, onClose }: EntityDetailModalProps) {
  return (
    <Modal open={target !== null} onClose={onClose} maxWidth="max-w-5xl">
      {target && (
        <div className="flex h-full w-full min-h-0 flex-col">
          {/* Header with breadcrumb + close button */}
          <div className="border-b border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0))] px-5 py-3 sm:px-6">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="-mx-0.5 overflow-x-auto pb-0.5">
                  <ol className="flex min-w-max items-center gap-1 px-0.5 text-body text-secondary">
                    {buildHeaderBreadcrumbs(target).map((item, index, list) => {
                      const isCurrent = index === list.length - 1;
                      return (
                        <li key={item.id} className="flex min-w-0 items-center gap-1">
                          {index > 0 && (
                            <svg
                              width="10"
                              height="10"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              className="flex-shrink-0 text-faint"
                              aria-hidden
                            >
                              <path d="m9 18 6-6-6-6" />
                            </svg>
                          )}
                          <IwmtLevelIcon
                            level={item.level}
                            size={11}
                            className={`flex-shrink-0 ${isCurrent ? 'opacity-95' : 'opacity-75'}`}
                          />
                          <span
                            className={`max-w-[320px] truncate sm:max-w-[420px] ${
                              isCurrent ? 'font-medium text-primary' : 'text-secondary'
                            }`}
                          >
                            {item.label}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              </div>
              <span className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-full border border-white/[0.12] bg-white/[0.04] px-2.5 py-1 text-micro uppercase tracking-[0.08em] text-white/72">
                <IwmtLevelIcon level={target.type} size={11} className="opacity-90" />
                <span className="font-semibold text-white/82">{hierarchyTag(target)}</span>
                <span>{target.type}</span>
              </span>
              <motion.button
                type="button"
                onClick={onClose}
                aria-label="Close detail"
                whileHover={{ scale: 1.06 }}
                whileTap={{ scale: 0.92 }}
                transition={{ duration: 0.12 }}
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
              </motion.button>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            <AnimatePresence mode="wait">
              <motion.div
                key={`${target.type}-${target.entity.id}`}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              >
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
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      )}
    </Modal>
  );
}
