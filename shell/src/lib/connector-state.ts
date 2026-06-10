// connector-state — derives a single UI channel state from an integration row,
// mirroring the runtime's actual gate semantics.

import type { ConnectorIntegrationView } from "./api";

export type ChannelState =
  | "live" // watch run active
  | "ready" // idle, all gates passed
  | "setup" // gates incomplete (auth / requirements / source identity)
  | "attention" // crashed while ready; needs explicit restart
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
  setup: "SETUP",
  attention: "ATTENTION",
  quarantined: "QUARANTINED",
  disabled: "DISABLED",
  unsupported: "UNSUPPORTED",
};

export type GateState = "pass" | "pending" | "fail" | "na";

export interface Gate {
  id: "trust" | "auth" | "reqs" | "source";
  label: string;
  state: GateState;
  detail?: string;
}

// The run gate chain in the order the runtime actually evaluates it.
export function gateChain(c: ConnectorIntegrationView): Gate[] {
  const trustPass = c.packageTrust === "official" || c.packageTrust === "custom";
  const trust: Gate = {
    id: "trust",
    label: "TRUST",
    state: trustPass ? "pass" : "fail",
    detail: c.packageTrust,
  };

  const auth: Gate = c.authType === "none"
    ? { id: "auth", label: "AUTH", state: "na", detail: "none required" }
    : {
      id: "auth",
      label: "AUTH",
      state: c.setupStatus === "ready" ? "pass" : "pending",
      detail: c.authType,
    };

  let reqs: Gate;
  if (c.requirements.length === 0) {
    reqs = { id: "reqs", label: "REQS", state: "na", detail: "none declared" };
  } else if (c.requirements.every((r) => r.status === "satisfied")) {
    reqs = { id: "reqs", label: "REQS", state: "pass" };
  } else if (c.requirements.some((r) => r.status === "error")) {
    reqs = { id: "reqs", label: "REQS", state: "fail" };
  } else {
    reqs = { id: "reqs", label: "REQS", state: "pending" };
  }

  const source: Gate = c.source
    ? { id: "source", label: "SOURCE", state: "pass", detail: c.source }
    : { id: "source", label: "SOURCE", state: "pending", detail: "integration key required" };

  return [trust, auth, reqs, source];
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
