import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface EntityActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label?: string;
  icon?: ReactNode;
  color?: string;
  variant?: 'primary' | 'secondary' | 'destructive' | 'ghost';
  size?: 'sm' | 'md';
}

export function EntityActionButton({
  label,
  icon,
  color = '#BFFF00',
  variant = 'secondary',
  size = 'md',
  className = '',
  type = 'button',
  ...rest
}: EntityActionButtonProps) {
  const sizeClass = size === 'sm' ? 'px-2.5 py-1 text-micro' : 'px-3 py-1.5 text-caption';

  const style =
    variant === 'primary'
      ? { backgroundColor: color, color: '#05060A', borderColor: `${color}CC` }
      : variant === 'destructive'
        ? { backgroundColor: `${color}18`, color, borderColor: `${color}45` }
        : variant === 'ghost'
          ? { backgroundColor: 'rgba(255,255,255,0.03)', color: 'rgba(255,255,255,0.75)', borderColor: 'rgba(255,255,255,0.12)' }
          : { backgroundColor: `${color}20`, color, borderColor: `${color}30` };

  return (
    <button
      type={type}
      className={`inline-flex items-center gap-1.5 rounded-lg border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${sizeClass} ${className}`}
      style={style}
      {...rest}
    >
      {icon}
      {label && <span>{label}</span>}
    </button>
  );
}
