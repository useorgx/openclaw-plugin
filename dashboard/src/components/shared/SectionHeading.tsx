export function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-micro font-semibold uppercase tracking-wider text-muted mb-1.5">
      {children}
    </h4>
  );
}
