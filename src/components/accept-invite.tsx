"use client";
import { useActionState } from "react";
import { acceptInvitationAction, type InviteState } from "@/app/actions/team";
import { Alert, Button } from "./ui";

export function AcceptInviteForm({ token, companyName }: { token: string; companyName: string }) {
  const [state, action, pending] = useActionState<InviteState, FormData>(acceptInvitationAction, undefined);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      {state?.error && <Alert tone="error">{state.error}</Alert>}
      <Button type="submit" disabled={pending} className="w-full">{pending ? "Joining…" : `Join ${companyName}`}</Button>
    </form>
  );
}
