import type { InitiativeWorkstream, InitiativeTask, Initiative } from '@/types';
import { WorkstreamCard } from './WorkstreamCard';

interface WorkstreamConstellationProps {
  workstreams: InitiativeWorkstream[];
  tasks: InitiativeTask[];
  initiative: Initiative;
}

export function WorkstreamConstellation({
  workstreams,
  tasks,
  initiative,
}: WorkstreamConstellationProps) {
  if (!workstreams.length) {
    return (
      <div className="px-4 py-2 text-caption text-muted">
        No workstreams defined yet.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto pb-1">
      <div className="flex items-stretch gap-3 px-1" style={{ minWidth: 'min-content' }}>
        {workstreams.map((ws) => {
          const wsTasks = tasks.filter((t) => t.workstreamId === ws.id);
          return (
            <WorkstreamCard
              key={ws.id}
              workstream={ws}
              tasks={wsTasks}
              initiative={initiative}
            />
          );
        })}
      </div>
    </div>
  );
}
