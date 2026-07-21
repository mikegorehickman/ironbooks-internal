/**
 * Page header — sits directly on the canvas per the design language: an
 * eyebrow line (12px caps muted) above a 24px/800 navy title, primary action
 * top-right. The old `subtitle` prop renders as the eyebrow so every existing
 * page picks up the new anatomy without changes.
 */
export function TopBar({
  title,
  subtitle,
  actions,
}: {
  title: React.ReactNode;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-end justify-between px-8 pt-7 pb-4">
      <div>
        {subtitle && (
          <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-ink-light mb-1">
            {subtitle}
          </p>
        )}
        <h1 className="text-2xl font-extrabold tracking-tight text-navy" style={{ letterSpacing: "-0.02em" }}>
          {title}
        </h1>
      </div>
      {actions && <div className="flex items-center gap-3">{actions}</div>}
    </div>
  );
}
