import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export function cx(...c: (string | false | null | undefined)[]) { return c.filter(Boolean).join(" "); }

const BTN = {
  primary: "bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-600/50",
  secondary: "bg-white text-ink border border-line hover:bg-canvas disabled:text-muted",
  danger: "bg-white text-red-700 border border-red-200 hover:bg-red-50",
  ghost: "text-navy-700 hover:bg-navy-100/60",
};
type BtnVariant = keyof typeof BTN;
const btnBase = "inline-flex items-center justify-center gap-1.5 rounded-md px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed min-h-9";

export function Button({ variant = "primary", className, ...p }: ComponentProps<"button"> & { variant?: BtnVariant }) {
  return <button {...p} className={cx(btnBase, BTN[variant], className)} />;
}
export function ButtonLink({ variant = "primary", className, ...p }: ComponentProps<typeof Link> & { variant?: BtnVariant }) {
  return <Link {...p} className={cx(btnBase, BTN[variant], className)} />;
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-lg border border-line bg-white", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          {title && <h2 className="text-[15px] font-semibold">{title}</h2>}
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold" dir="auto">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: string; error?: string; children: ReactNode; htmlFor: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium">{label}</label>
      {children}
      {hint && !error && <p className="text-xs text-muted">{hint}</p>}
      {error && <p className="text-xs text-red-700" role="alert">{error}</p>}
    </div>
  );
}

export const inputCls = "block w-full rounded-md border border-line bg-white px-3 py-2 text-sm placeholder:text-muted/70 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-canvas";

export function Input(p: ComponentProps<"input">) { return <input dir="auto" {...p} className={cx(inputCls, p.className)} />; }
export function Textarea(p: ComponentProps<"textarea">) { return <textarea dir="auto" {...p} className={cx(inputCls, p.className)} />; }
export function Select(p: ComponentProps<"select">) { return <select {...p} className={cx(inputCls, p.className)} />; }

export function Alert({ tone = "info", children, title }: { tone?: "info" | "error" | "success" | "warning"; children: ReactNode; title?: string }) {
  const t = {
    info: "border-navy-200 bg-navy-100/50 text-navy-900",
    error: "border-red-200 bg-red-50 text-red-900",
    success: "border-brand-100 bg-brand-50 text-brand-700",
    warning: "border-amber-200 bg-amber-50 text-amber-900",
  }[tone];
  return (
    <div className={cx("rounded-md border px-3.5 py-2.5 text-sm", t)} role={tone === "error" ? "alert" : "status"}>
      {title && <p className="font-semibold">{title}</p>}
      <div className="whitespace-pre-line">{children}</div>
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-white px-6 py-10 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function Badge({ tone = "gray", children }: { tone?: "gray" | "green" | "amber" | "red" | "blue" | "navy"; children: ReactNode }) {
  const t = {
    gray: "bg-gray-100 text-gray-700 ring-gray-200",
    green: "bg-brand-50 text-brand-700 ring-brand-100",
    amber: "bg-amber-50 text-amber-800 ring-amber-200",
    red: "bg-red-50 text-red-700 ring-red-200",
    blue: "bg-sky-50 text-sky-800 ring-sky-200",
    navy: "bg-navy-100 text-navy-900 ring-navy-200",
  }[tone];
  return <span className={cx("inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", t)}>{children}</span>;
}

export const STATUS: Record<string, { label: string; tone: "gray" | "green" | "amber" | "red" | "blue" | "navy" }> = {
  new: { label: "New", tone: "gray" },
  processing: { label: "Processing", tone: "blue" },
  needs_clarification: { label: "Needs clarification", tone: "amber" },
  ready_for_review: { label: "Ready for review", tone: "navy" },
  draft_prepared: { label: "Draft prepared", tone: "blue" },
  approved: { label: "Approved", tone: "green" },
};
export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: "gray" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("overflow-x-auto rounded-lg border border-line bg-white", className)}>
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}
export const th = "border-b border-line bg-canvas px-3 py-2 text-start text-xs font-semibold uppercase tracking-wide text-muted";
export const td = "border-b border-line px-3 py-2 align-top";

export function fmtQty(v: string | number | null | undefined) {
  if (v === null || v === undefined || v === "") return "";
  const s = String(v);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}
export function fmtDate(d: string | Date | null | undefined) {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d.length === 10 ? d + "T00:00:00" : d) : d;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
export function fmtMoney(v: string | null | undefined, cur?: string) {
  if (v === null || v === undefined) return "—";
  const [i, f] = v.split(".");
  const neg = i.startsWith("-");
  const int = (neg ? i.slice(1) : i).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${int}${f !== undefined ? "." + f : ""}${cur ? " " + cur : ""}`;
}
