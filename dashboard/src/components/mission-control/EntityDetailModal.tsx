import { Modal } from '@/components/shared/Modal';
import type { EntityModalTarget } from './MissionControlContext';
import { InitiativeDetail } from './EntityDetailModal.Initiative';
import { WorkstreamDetail } from './EntityDetailModal.Workstream';
import { MilestoneDetail } from './EntityDetailModal.Milestone';
import { TaskDetail } from './EntityDetailModal.Task';

interface EntityDetailModalProps {
  target: EntityModalTarget | null;
  onClose: () => void;
}

export function EntityDetailModal({ target, onClose }: EntityDetailModalProps) {
  return (
    <Modal open={target !== null} onClose={onClose} maxWidth="max-w-3xl">
      {target && (
        <div className="max-h-[80vh] overflow-y-auto">
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
      )}
    </Modal>
  );
}
