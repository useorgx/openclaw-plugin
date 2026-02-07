import { colors } from '@/lib/tokens';
import { PremiumCard } from '@/components/shared/PremiumCard';

export function MissionControlEmpty() {
  return (
    <div className="flex-1 flex items-center justify-center p-12">
      <PremiumCard className="max-w-sm p-8">
        <div className="flex flex-col items-center text-center gap-4">
          <div
            className="relative flex items-center justify-center h-16 w-16 rounded-2xl"
            style={{
              backgroundColor: `${colors.iris}1a`,
              border: `1px solid ${colors.iris}33`,
            }}
          >
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke={colors.iris}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>
          </div>
          <div className="space-y-1.5">
            <h3 className="text-[14px] font-semibold text-white">
              No initiatives yet
            </h3>
            <p className="text-[12px] text-white/50 leading-relaxed">
              Create initiatives in OrgX to see them here. Mission Control shows
              your full initiative hierarchy with workstreams, milestones, and tasks.
            </p>
          </div>
        </div>
      </PremiumCard>
    </div>
  );
}
