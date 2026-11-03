"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { startRecoveryAction } from "@/app/actions/auth";
import { Alert } from "./ui";

// Reset links arrive as /reset-password#access_token=…&refresh_token=…&type=recovery.
// The part after "#" never reaches the server, so this reads it in the browser,
// hands it to the server once to start the session, and removes it from the address bar.
export function RecoveryLanding() {
  const router = useRouter();
  const [state, setState] = useState<"checking" | "error">("checking");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    window.history.replaceState(null, "", window.location.pathname);
    const fail = (m: string) => { setMessage(m); setState("error"); };
    (async () => {
      await Promise.resolve();
      if (hash.get("error_description") || hash.get("error"))
        return fail(hash.get("error_code") === "otp_expired"
          ? "This reset link has expired or was already used."
          : (hash.get("error_description") ?? "This reset link didn't work."));
      const access = hash.get("access_token"), refresh = hash.get("refresh_token");
      if (!access || !refresh) return fail("Open the reset link from your email to choose a new password.");
      try {
        const r = await startRecoveryAction(access, refresh);
        if (r.error) fail(r.error); else router.refresh();
      } catch { fail("Something went wrong. Please request a new link."); }
    })();
  }, [router]);

  if (state === "checking") return <p className="text-sm text-muted" role="status">Checking your reset link…</p>;
  return (
    <div className="space-y-4">
      <Alert tone="error">{message}</Alert>
      <Link className="font-medium text-brand-700 underline" href="/forgot-password">Request a new reset link</Link>
    </div>
  );
}
