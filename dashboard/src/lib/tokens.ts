export const colors = {
  lime: '#c8e64a',
  teal: '#7dd3c0',
  iris: '#818cf8',
  amber: '#f59e0b',
  red: '#ef4444',
  background: '#080808',
  cardBg: '#0f0f0f',
  cardBorder: 'rgba(255, 255, 255, 0.06)',
} as const;

export const agentColors: Record<string, string> = {
  Pace: '#818cf8',
  Eli: '#c8e64a',
  Dana: '#f472b6',
  Mark: '#fb923c',
  System: '#7dd3c0',
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
