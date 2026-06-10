// ConnectorsView — the Source Console: connector integration management.
//
// Connectors are the OS's sensory organs feeding the append-only D0 ledger.
// Each integration renders as an instrument channel: provenance string up
// front, the actual runtime gate chain (TRUST → AUTH → REQS → SOURCE) made
// visible, trust approval as a deliberate two-step, crash recovery as an
// explicit human action.

import { useCallback, useMemo, useState } from "react";
import { useConnectors } from "../hooks/useConnectors";
import {
  approveConnector,
  checkConnectorRequirements,
  requestConnectorRequirement,
  restartConnectorIntegration,
  type ConnectorIntegrationView,
  type ConnectorRequirementView,
} from "../lib/api";
import {
  CHANNEL_LABEL,
  channelState,
  gateChain,
  relativeTime,
  type ChannelState,
} from "../lib/connector-state";
import styles from "./ConnectorsView.module.css";

export function ConnectorsView() {
  const { connectors, loading, error, refresh } = useConnectors();
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [confirmApprove, setConfirmApprove] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = useCallback(
    async (key: string, label: string, fn: () => Promise<unknown>) => {
      setBusy((prev) => ({ ...prev, [key]: label }));
      setActionError(null);
      try {
        await fn();
        await refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    },
    [refresh],
  );

  const counts = useMemo(() => {
    const tally: Partial<Record<ChannelState, number>> = {};
    for (const c of connectors) {
      const state = channelState(c);
      tally[state] = (tally[state] ?? 0) + 1;
    }
    return tally;
  }, [connectors]);

  return (
    <div className={styles.console}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.title}>Source Console</h1>
          <span className={styles.subtitle}>connector runtime · this device</span>
        </div>
        <div className={styles.tally}>
          <TallyItem state="live" count={counts.live} />
          <TallyItem state="ready" count={counts.ready} />
          <TallyItem state="setup" count={counts.setup} />
          <TallyItem state="attention" count={counts.attention} />
          <TallyItem state="quarantined" count={counts.quarantined} />
        </div>
      </header>

      {(error || actionError) && (
        <div className={styles.errorStrip} role="alert">
          <span className={styles.errorGlyph}>▲</span>
          {actionError ?? error}
          {actionError && (
            <button className={styles.errorDismiss} onClick={() => setActionError(null)}>
              ✕
            </button>
          )}
        </div>
      )}

      <div className={styles.ledger}>
        {loading && connectors.length === 0 ? (
          <div className={styles.empty}>scanning workspace connectors…</div>
        ) : connectors.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyGlyph}>⌀</span>
            <span>no sources wired</span>
            <span className={styles.emptyHint}>
              install a connector package into workspace/connectors/
            </span>
          </div>
        ) : (
          connectors.map((c, index) => (
            <ChannelCard
              key={c.id}
              connector={c}
              index={index}
              busy={busy}
              confirmApprove={confirmApprove}
              onConfirmApprove={setConfirmApprove}
              onAct={act}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TallyItem({ state, count }: { state: ChannelState; count: number | undefined }) {
  return (
    <span className={`${styles.tallyItem} ${count ? styles[`tone_${state}`] : styles.tallyZero}`}>
      <span className={styles.tallyCount}>{count ?? 0}</span>
      {CHANNEL_LABEL[state].toLowerCase()}
    </span>
  );
}

interface ChannelCardProps {
  connector: ConnectorIntegrationView;
  index: number;
  busy: Record<string, string>;
  confirmApprove: string | null;
  onConfirmApprove: (id: string | null) => void;
  onAct: (key: string, label: string, fn: () => Promise<unknown>) => Promise<void>;
}

function ChannelCard({
  connector: c,
  index,
  busy,
  confirmApprove,
  onConfirmApprove,
  onAct,
}: ChannelCardProps) {
  const state = channelState(c);
  const gates = gateChain(c);
  const needsApproval = state === "quarantined" && c.packageTrust !== "missing";
  const canRestart = state === "attention";
  const hasRequirements = c.requirements.length > 0;
  const trusted = c.packageTrust === "official" || c.packageTrust === "custom";

  return (
    <article
      className={`${styles.card} ${styles[`card_${state}`]}`}
      style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
    >
      <div className={styles.cardRail} />
      <div className={styles.cardBody}>
        <div className={styles.cardTop}>
          <span className={`${styles.stateBadge} ${styles[`tone_${state}`]}`}>
            <span className={`${styles.stateDot} ${state === "live" ? styles.pulse : ""}`} />
            {CHANNEL_LABEL[state]}
          </span>
          <h2 className={styles.cardName}>{c.name}</h2>
          <span className={styles.cardMeta}>
            {c.mode}
            {c.scheduleCron ? <span className={styles.cron}> · {c.scheduleCron}</span> : null}
            {c.packageTrust === "official" && <span className={styles.officialSeal}>official</span>}
          </span>
        </div>

        <div className={styles.sourceLine}>
          {c.source ?? `connector:${c.connectorId} — source identity incomplete`}
        </div>

        <div className={styles.gateChain}>
          {gates.map((gate) => (
            <span
              key={gate.id}
              className={`${styles.gate} ${styles[`gate_${gate.state}`]}`}
              title={gate.detail}
            >
              <span className={styles.gateNode} />
              {gate.label}
            </span>
          ))}
        </div>

        {hasRequirements && trusted && (
          <div className={styles.requirements}>
            {c.requirements.map((req) => (
              <RequirementChip
                key={req.id}
                integrationId={c.id}
                req={req}
                busy={busy}
                onAct={onAct}
              />
            ))}
            <button
              className={styles.ghostBtn}
              disabled={Boolean(busy[c.id])}
              onClick={() =>
                onAct(c.id, "check", () => checkConnectorRequirements(c.id))
              }
            >
              {busy[c.id] === "check" ? "checking…" : "re-check all"}
            </button>
          </div>
        )}

        {c.lastError && (state === "attention" || state === "setup") && (
          <div className={styles.lastError}>
            <span className={styles.errorGlyph}>▲</span>
            {c.lastError}
          </div>
        )}

        <div className={styles.cardFooter}>
          <span className={styles.timestamps}>
            last run {relativeTime(c.lastRunAt)}
            {c.mode === "poll" && c.nextRunAt ? ` · next ${relativeTime(c.nextRunAt)}` : ""}
          </span>
          <div className={styles.actions}>
            {canRestart && (
              <button
                className={styles.primaryBtn}
                disabled={Boolean(busy[c.id])}
                onClick={() =>
                  onAct(c.id, "restart", () => restartConnectorIntegration(c.id))
                }
              >
                {busy[c.id] === "restart" ? "restarting…" : "Restart"}
              </button>
            )}
            {needsApproval && confirmApprove !== c.id && (
              <button
                className={styles.hazardBtn}
                onClick={() => onConfirmApprove(c.id)}
              >
                Review &amp; Approve
              </button>
            )}
          </div>
        </div>

        {needsApproval && confirmApprove === c.id && (
          <div className={styles.approvePanel}>
            <div className={styles.approveText}>
              Approving trusts <strong>this exact package content</strong> to run inside your
              workspace. Any later change to the package re-quarantines it.
            </div>
            <div className={styles.hashLine}>
              <span className={styles.hashLabel}>sha</span>
              {c.packageHash ?? "(hash unavailable)"}
            </div>
            <div className={styles.approveActions}>
              <button
                className={styles.hazardBtn}
                disabled={Boolean(busy[c.connectorId])}
                onClick={() =>
                  onAct(c.connectorId, "approve", async () => {
                    await approveConnector(c.connectorId);
                    onConfirmApprove(null);
                  })
                }
              >
                {busy[c.connectorId] === "approve" ? "approving…" : "Approve exact package"}
              </button>
              <button className={styles.ghostBtn} onClick={() => onConfirmApprove(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

interface RequirementChipProps {
  integrationId: string;
  req: ConnectorRequirementView;
  busy: Record<string, string>;
  onAct: (key: string, label: string, fn: () => Promise<unknown>) => Promise<void>;
}

function RequirementChip({ integrationId, req, busy, onAct }: RequirementChipProps) {
  const busyKey = `${integrationId}:${req.id}`;
  const actionable = req.status !== "satisfied";
  return (
    <span
      className={`${styles.reqChip} ${styles[`req_${req.status}`]}`}
      title={req.message ?? (req.lastCheckedAt ? `checked ${relativeTime(req.lastCheckedAt)}` : "never checked")}
    >
      <span className={styles.reqDot} />
      {req.id}
      <span className={styles.reqStatus}>{req.status}</span>
      {actionable && (
        <button
          className={styles.reqAction}
          disabled={Boolean(busy[busyKey])}
          onClick={() =>
            onAct(busyKey, "grant", () =>
              req.status === "unknown"
                ? checkConnectorRequirements(integrationId)
                : requestConnectorRequirement(integrationId, req.id),
            )
          }
        >
          {busy[busyKey] ? "…" : req.status === "unknown" ? "check" : "grant"}
        </button>
      )}
    </span>
  );
}
