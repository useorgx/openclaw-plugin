import { cn } from '@/lib/utils';
import { colors } from '@/lib/tokens';

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
    label: 'Initiatives',
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
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.08] bg-[#0a0a0f]/95 backdrop-blur-lg lg:hidden">
      <div className="flex items-stretch">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={cn(
                'relative flex flex-1 flex-col items-center gap-0.5 pb-1 pt-2 transition-colors',
                isActive ? 'text-lime' : 'text-white/40 hover:text-white/60'
              )}
            >
              {isActive && (
                <span
                  className="absolute inset-x-3 top-0 h-[2px] rounded-full"
                  style={{ backgroundColor: colors.lime }}
                />
              )}
              <span className="relative">
                {tab.icon}
                {tab.id === 'decisions' && pendingDecisionCount > 0 && (
                  <span
                    className="absolute -right-2 -top-1 flex h-3.5 min-w-[14px] items-center justify-center rounded-full px-1 text-[8px] font-bold text-black"
                    style={{ backgroundColor: colors.amber }}
                  >
                    {pendingDecisionCount > 99 ? '99+' : pendingDecisionCount}
                  </span>
                )}
              </span>
              <span className="text-[10px]">{tab.label}</span>
            </button>
          );
        })}
      </div>
      {/* iOS safe area inset */}
      <div className="h-[env(safe-area-inset-bottom)]" />
    </nav>
  );
}
