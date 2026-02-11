import { motion } from 'framer-motion';
import type { Initiative } from '@/types';
import { InitiativeSection } from './InitiativeSection';

interface InitiativeOrbitProps {
  initiatives: Initiative[];
  selectedInitiativeIds?: Set<string>;
  onToggleInitiativeSelection?: (initiativeId: string, selected: boolean) => void;
  runtimeActivityByInitiativeId?: ReadonlyMap<
    string,
    { activeCount: number; totalCount: number; lastHeartbeatAt: string | null }
  >;
}

const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.045, delayChildren: 0.02 },
  },
};

const item = {
  hidden: { opacity: 0, y: 10, scale: 0.995 },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { type: 'spring', stiffness: 320, damping: 28, mass: 0.7 },
  },
};

export function InitiativeOrbit({
  initiatives,
  selectedInitiativeIds,
  onToggleInitiativeSelection,
  runtimeActivityByInitiativeId,
}: InitiativeOrbitProps) {
  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="space-y-2"
    >
      {initiatives.map((initiative) => (
        <motion.div
          key={initiative.id}
          variants={item}
          layout
          transition={{ type: 'spring', stiffness: 280, damping: 32, mass: 0.75 }}
        >
          <InitiativeSection
            initiative={initiative}
            selected={selectedInitiativeIds?.has(initiative.id) ?? false}
            onSelectionChange={onToggleInitiativeSelection}
            runtimeActivity={runtimeActivityByInitiativeId?.get(initiative.id) ?? null}
          />
        </motion.div>
      ))}
    </motion.div>
  );
}
