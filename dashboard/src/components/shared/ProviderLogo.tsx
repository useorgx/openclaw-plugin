import { cn } from '@/lib/utils';
import { getProviderInfo, type ProviderId } from '@/lib/providers';

interface ProviderLogoProps {
  provider: ProviderId;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
  showRing?: boolean;
}

const sizeMap: Record<NonNullable<ProviderLogoProps['size']>, number> = {
  xs: 18,
  sm: 24,
  md: 30,
};

function ProviderGlyph({ provider }: { provider: ProviderId }) {
  switch (provider) {
    case 'openai':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
          />
        </svg>
      );
    case 'anthropic':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"
          />
        </svg>
      );
    case 'codex':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"
          />
        </svg>
      );
    case 'openclaw':
      return (
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <path
            d="M60 10C30 10 15 35 15 55C15 75 30 95 45 100V110H55V100C55 100 60 102 65 100V110H75V100C90 95 105 75 105 55C105 35 90 10 60 10Z"
            fill="currentColor"
          />
          <path
            d="M20 45C5 40 0 50 5 60C10 70 20 65 25 55C28 48 25 45 20 45Z"
            fill="currentColor"
          />
          <path
            d="M100 45C115 40 120 50 115 60C110 70 100 65 95 55C92 48 95 45 100 45Z"
            fill="currentColor"
          />
          <circle cx="45" cy="35" r="6" fill="rgba(2,4,10,0.92)" />
          <circle cx="75" cy="35" r="6" fill="rgba(2,4,10,0.92)" />
        </svg>
      );
    case 'orgx':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth="1.8" fill="none" />
          <path
            d="M8.2 8.2 15.8 15.8M15.8 8.2 8.2 15.8"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" fill="none" />
          <path d="m12 6-2 7h3l-1 5 4-8h-3l1-4Z" fill="currentColor" />
        </svg>
      );
  }
}

export function ProviderLogo({
  provider,
  size = 'sm',
  className,
  showRing = true,
}: ProviderLogoProps) {
  const info = getProviderInfo(provider);
  const pixelSize = sizeMap[size];

  return (
    <span
      className={cn('inline-flex items-center justify-center rounded-md', className)}
      style={{
        width: pixelSize,
        height: pixelSize,
        color: info.accent,
        backgroundColor: info.tint,
        border: showRing ? `1px solid ${info.accent}55` : 'none',
      }}
      title={info.label}
      aria-label={info.label}
    >
      <span
        style={{
          width: Math.round(pixelSize * 0.66),
          height: Math.round(pixelSize * 0.66),
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ProviderGlyph provider={provider} />
      </span>
    </span>
  );
}
