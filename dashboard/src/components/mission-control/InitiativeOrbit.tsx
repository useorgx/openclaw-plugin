import { motion } from 'framer-motion';
import type { Initiative } from '@/types';
import { InitiativeSection } from './InitiativeSection';

interface InitiativeOrbitProps {
  initiatives: Initiative[];
}

const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.04 },
  },
};

const item = {
  hidden: { opacity: 0, y: 12 },
  show: {
    opacity: 1,
    y: 0,
    transition: { type: 'spring', stiffness: 300, damping: 30 },
  },
};

export function InitiativeOrbit({ initiatives }: InitiativeOrbitProps) {
  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="space-y-2"
    >
      {initiatives.map((initiative) => (
        <motion.div key={initiative.id} variants={item}>
          <InitiativeSection initiative={initiative} />
        </motion.div>
      ))}
    </motion.div>
  );
}
