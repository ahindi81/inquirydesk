import { Badge } from "./ui";

export function StateBadge({ state, status }: { state: string; status: string }) {
  if (state === "trial_ended") return <Badge tone="red">Trial ended</Badge>;
  if (state === "expired") return <Badge tone="red">Expired</Badge>;
  if (state === "cancelled") return <Badge tone="red">Cancelled</Badge>;
  if (status === "trialing") return <Badge tone="blue">Trial</Badge>;
  if (status === "complimentary") return <Badge tone="navy">Complimentary</Badge>;
  return <Badge tone="green">Active</Badge>;
}

