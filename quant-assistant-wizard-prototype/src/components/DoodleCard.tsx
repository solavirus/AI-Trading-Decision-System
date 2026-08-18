import type { ReactNode } from "react";

interface DoodleCardProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  status?: ReactNode;
  footer?: ReactNode;
  decoration?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function DoodleCard({
  title,
  subtitle,
  icon,
  status,
  footer,
  decoration,
  className = "",
  children,
}: DoodleCardProps) {
  return (
    <section className={`doodle-card p-4 ${className}`.trim()}>
      {(title || icon || status) && (
        <header className="mb-3 flex min-h-8 items-start gap-2">
          {icon && <span className="shrink-0">{icon}</span>}
          <div className="min-w-0 flex-1">
            {title && <div className="text-[16px] font-bold leading-5">{title}</div>}
            {subtitle && <div className="mt-0.5 text-[11px] text-[var(--wn-ink-500)]">{subtitle}</div>}
          </div>
          {status && <div className="shrink-0 text-[11px]">{status}</div>}
        </header>
      )}
      <div className="min-h-0 flex-1">{children}</div>
      {footer && <footer className="mt-auto pt-3">{footer}</footer>}
      {decoration && <div aria-hidden className="pointer-events-none absolute">{decoration}</div>}
    </section>
  );
}
