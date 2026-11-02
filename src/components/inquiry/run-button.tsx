"use client";
import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button } from "../ui";

type Result = { ok: true; message?: string; data?: unknown } | { ok: false; error: string };

/** Button that runs a processing step and shows its outcome (success notes or a clear error). */
export function RunButton({ run, children, pendingLabel, variant = "primary", confirmText, retryWithConfirm, onDone }: {
  run: (confirmed: boolean) => Promise<Result>; children: ReactNode; pendingLabel: string;
  variant?: "primary" | "secondary"; confirmText?: string; retryWithConfirm?: (r: Result) => string | null; onDone?: (r: Result) => void;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result | null>(null);
  const router = useRouter();
  const go = (confirmed: boolean): void => start(async () => {
    if (confirmText && !confirmed && !window.confirm(confirmText)) return;
    let r: Result;
    try { r = await run(confirmed); } catch { r = { ok: false, error: "The request did not complete. Check your connection and try again." }; }
    const ask = !r.ok && retryWithConfirm?.(r);
    if (ask && window.confirm(ask)) { go(true); return; }
    setResult(r); onDone?.(r); router.refresh();
  });
  return (
    <div className="space-y-2">
      <Button variant={variant} onClick={() => go(false)} disabled={pending} aria-busy={pending}>
        {pending ? <><Spinner /> {pendingLabel}</> : children}
      </Button>
      {result && !result.ok && <Alert tone="error">{result.error}</Alert>}
      {result && result.ok && result.message && <Alert tone="warning" title="Please note">{result.message}</Alert>}
    </div>
  );
}

export function Spinner() {
  return <span aria-hidden className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />;
}
