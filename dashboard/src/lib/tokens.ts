export const colors = {
  // OrgX brand system (aligned with useorgx.com + mcp.useorgx.com)
  lime: '#BFFF00',
  teal: '#14B8A6',
  cyan: '#0AD4C4',
  iris: '#7C7CFF',

  amber: '#F5B700',
  red: '#FF6B88',

  background: '#02040A',
  cardBg: '#08090D',
  cardBgElevated: '#0C0E14',
  cardBorder: 'rgba(255, 255, 255, 0.08)',
  cardBorderStrong: 'rgba(255, 255, 255, 0.12)',

  text: '#F2F7FF',
  textMuted: '#8F9AB7',
} as const;

export const agentColors: Record<string, string> = {
  Pace: '#7C7CFF',
  Eli: '#BFFF00',
  Dana: '#FF00D4',
  Mark: '#F5B700',
  System: '#14B8A6',
};

export function getAgentColor(name: string): string {
  return agentColors[name] ?? colors.teal;
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}
