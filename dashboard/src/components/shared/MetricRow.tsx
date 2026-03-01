interface Metric {
  label: string;
  value: number | string;
  color?: string;
  suffix?: string;
}

interface MetricRowProps {
  metrics: Metric[];
  className?: string;
}

export function MetricRow({ metrics, className }: MetricRowProps) {
  return (
    <div className={`flex items-center gap-12 ${className ?? ''}`}>
      {metrics.map((metric) => (
        <div key={metric.label}>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted">
            {metric.label}
          </p>
          <p
            className="mt-1 text-2xl font-light"
            style={{
              color:
                (typeof metric.value === 'number' && metric.value === 0) || metric.value === '0'
                  ? 'rgba(255,255,255,0.2)'
                  : metric.color ?? 'rgba(242,247,255,0.78)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {metric.value}
            {metric.suffix && (
              <span className="ml-0.5 text-sm font-normal text-muted">{metric.suffix}</span>
            )}
          </p>
        </div>
      ))}
    </div>
  );
}
