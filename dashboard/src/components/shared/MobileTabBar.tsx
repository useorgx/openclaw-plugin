import { cn } from '@/lib/utils';
import { colors } from '@/lib/tokens';
import { motion } from 'framer-motion';

export type MobileTab = 'agents' | 'activity' | 'decisions' | 'initiatives';

interface MobileTabBarProps {
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
  pendingDecisionCount?: number;
}

const tabs: { id: MobileTab; label: string; icon: JSX.Element }[] = [
  {
    id: 'agents',
    label: 'Agents',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
  },
  {
    id: 'activity',
    label: 'Activity',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
  },
  {
    id: 'decisions',
    label: 'Decisions',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    ),
  },
  {
    id: 'initiatives',
    label: 'Next Up',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
        <line x1="4" x2="4" y1="22" y2="15" />
      </svg>
    ),
  },
];

export function MobileTabBar({ activeTab, onTabChange, pendingDecisionCount = 0 }: MobileTabBarProps) {
  return (
    <nav
      className="pointer-events-none fixed inset-x-0 z-40 flex justify-center px-3 lg:hidden"
      style={{ bottom: 'max(10px, env(safe-area-inset-bottom))' }}
      aria-label="Mobile sections"
    >
      <div className="pointer-events-auto relative flex items-stretch gap-1 rounded-[24px] border border-white/[0.12] bg-[#090d16]/90 p-1.5 shadow-[0_20px_50px_rgba(0,0,0,0.52)] backdrop-blur-xl">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              type="button"
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'relative flex min-w-[76px] flex-1 flex-col items-center gap-1 overflow-hidden rounded-[18px] px-2 pb-1.5 pt-2.5 transition-colors',
                isActive ? 'text-lime' : 'text-white/45 hover:text-white/72'
              )}
            >
              {isActive && (
                <>
                  <motion.span
                    layoutId="mobile-tab-active-pill"
                    className="absolute inset-0 rounded-[18px] border border-[#BFFF00]/28 bg-[#BFFF00]/[0.1]"
                    transition={{ type: 'spring', stiffness: 420, damping: 34, mass: 0.8 }}
                  />
                  <motion.span
                    layoutId="mobile-tab-active-line"
                    className="absolute inset-x-3 top-0.5 h-[2px] rounded-full"
                    style={{ backgroundColor: colors.lime }}
                    transition={{ type: 'spring', stiffness: 440, damping: 36, mass: 0.75 }}
                  />
                </>
              )}
              <span
                className={cn(
                  'relative inline-flex h-8 w-8 items-center justify-center rounded-full border transition-colors',
                  isActive
                    ? 'border-[#BFFF00]/35 bg-[#BFFF00]/[0.12] text-[#D8FFA1]'
                    : 'border-white/[0.1] bg-white/[0.03]'
                )}
              >
                <span className="relative z-[1]">
                  {tab.icon}
                </span>
                {tab.id === 'decisions' && pendingDecisionCount > 0 && (
                  <span
                    className="absolute -right-1.5 -top-1 flex h-3.5 min-w-[14px] items-center justify-center rounded-full border border-black/35 px-1 text-[8px] font-bold text-black shadow-[0_2px_8px_rgba(0,0,0,0.35)]"
                    style={{ backgroundColor: colors.amber }}
                  >
                    {pendingDecisionCount > 99 ? '99+' : pendingDecisionCount}
                  </span>
                )}
              </span>
              <span className={cn('relative z-[1] text-[10px] font-medium', isActive ? 'text-[#D8FFA1]' : 'text-white/55')}>
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
