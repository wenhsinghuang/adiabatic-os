// connector-state — derives UI channel state from an integration row,
// mirroring the runtime's actual gate semantics. Deliberately simplified:
// users see plain states and human-readable setup needs, not runtime internals.

import type { ConnectorIntegrationView, ConnectorSetupPendingReason } from "./api";

export type ChannelState =
  | "live" // watch run active
  | "ready" // idle, all gates passed
  | "setup" // setup incomplete (auth / requirements / integration key)
  | "attention" // run errored; user should look (watch needs restart, poll auto-retries)
  | "quarantined" // package trust gate failed; needs human approval
  | "disabled"
  | "unsupported";

export function channelState(c: ConnectorIntegrationView): ChannelState {
  if (!c.supported) return "unsupported";
  if (c.packageTrust !== "official" && c.packageTrust !== "custom") return "quarantined";
  if (!c.enabled || c.status === "disabled") return "disabled";
  if (c.status === "error" && c.setupStatus === "ready") return "attention";
  if (c.running) return "live";
  if (c.setupStatus === "setup" || c.status === "error") return "setup";
  return "ready";
}

export const CHANNEL_LABEL: Record<ChannelState, string> = {
  live: "LIVE",
  ready: "READY",
  setup: "NEEDS SETUP",
  attention: "ATTENTION",
  quarantined: "NEEDS APPROVAL",
  disabled: "OFF",
  unsupported: "UNSUPPORTED",
};

// Trust collapses to what a user must understand: official, approved custom,
// needs approval, or broken (package gone/invalid).
export type TrustView = "official" | "custom" | "needs-approval" | "broken";

export function trustView(c: ConnectorIntegrationView): TrustView {
  switch (c.packageTrust) {
    case "official":
      return "official";
    case "custom":
      return "custom";
    case "untrusted":
    case "modified":
      return "needs-approval";
    default:
      return "broken";
  }
}

const SETUP_NEED_LABEL: Record<ConnectorSetupPendingReason, string> = {
  integration_key: "integration name",
  auth: "account connection",
  requirements: "permission grants",
};

export function setupNeeds(c: ConnectorIntegrationView): string[] {
  return c.setupPending.map((reason) => SETUP_NEED_LABEL[reason]);
}

// Aggregate state for a connector card: trust/platform problems are
// connector-level; otherwise surface the most urgent integration state.
const AGGREGATE_PRIORITY: ChannelState[] = ["attention", "setup", "live", "ready", "disabled"];

export function connectorAggregateState(integrations: ConnectorIntegrationView[]): ChannelState {
  const first = integrations[0];
  if (!first) return "disabled";
  if (!first.supported) return "unsupported";
  if (first.packageTrust !== "official" && first.packageTrust !== "custom") return "quarantined";
  const states = new Set(integrations.map(channelState));
  for (const state of AGGREGATE_PRIORITY) {
    if (states.has(state)) return state;
  }
  return "ready";
}

export function relativeTime(ts: number | undefined, now = Date.now()): string {
  if (!ts) return "—";
  const delta = now - ts;
  const future = delta < 0;
  const abs = Math.abs(delta);
  const units: Array<[number, string]> = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
    [1_000, "s"],
  ];
  for (const [ms, suffix] of units) {
    if (abs >= ms) {
      const value = Math.floor(abs / ms);
      return future ? `in ${value}${suffix}` : `${value}${suffix} ago`;
    }
  }
  return future ? "now" : "just now";
}
