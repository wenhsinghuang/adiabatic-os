// ConnectorsView — the Source Console: connector integration management.
//
// Deliberately simple for the user: a connector is official / custom /
// needs-approval; an integration needs setup, is ready, is live, or needs
// attention. Implementation details (hashes, gate internals) stay behind the
// API. Each integration card manages its own auth, permissions, schedule
// visibility, and lifecycle actions.

import { useCallback, useMemo, useState } from "react";
import { useConnectors } from "../hooks/useConnectors";
import {
  approveConnector,
  checkConnectorRequirements,
  connectConnectorIntegration,
  createConnectorIntegration,
  deleteConnectorIntegration,
  removeConnector,
  requestConnectorRequirement,
  restartConnectorIntegration,
  updateConnectorIntegration,
  type ConnectorIntegrationView,
  type ConnectorRequirementView,
} from "../lib/api";
import {
  CHANNEL_LABEL,
  channelState,
  relativeTime,
  setupNeeds,
  trustView,
  type ChannelState,
} from "../lib/connector-state";
import styles from "./ConnectorsView.module.css";

type Act = (key: string, label: string, fn: () => Promise<unknown>) => Promise<void>;

export function ConnectorsView() {
  const { connectors, loading, error, refresh } = useConnectors();
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const act = useCallback<Act>(
    async (key, label, fn) => {
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
            <ChannelCard key={c.id} connector={c} index={index} busy={busy} onAct={act} />
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
  onAct: Act;
}

function ChannelCard({ connector: c, index, busy, onAct }: ChannelCardProps) {
  const state = channelState(c);
  const trust = trustView(c);
  const needs = setupNeeds(c);
  const trusted = trust === "official" || trust === "custom";
  const interactive = state !== "unsupported" && trust !== "broken";

  const [panel, setPanel] = useState<"approve" | "remove" | "add" | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [addKeyInput, setAddKeyInput] = useState("");

  const cardBusy = Boolean(busy[c.id]);

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
            {trust === "official" && <span className={styles.officialSeal}>official</span>}
            {trust === "custom" && <span className={styles.customSeal}>custom</span>}
            {trust === "broken" && <span className={styles.brokenSeal}>missing</span>}
          </span>
          {interactive && trusted && (
            <button
              className={`${styles.toggle} ${c.enabled ? styles.toggleOn : ""}`}
              title={c.enabled ? "Disable" : "Enable"}
              disabled={cardBusy}
              onClick={() =>
                onAct(c.id, "toggle", () =>
                  updateConnectorIntegration(c.id, { enabled: !c.enabled }),
                )
              }
            >
              <span className={styles.toggleKnob} />
            </button>
          )}
        </div>

        <div className={styles.sourceLine}>
          {c.source ?? `connector:${c.connectorId} — needs an integration name`}
        </div>

        {state === "setup" && needs.length > 0 && (
          <div className={styles.needsLine}>
            needs <span className={styles.needsItems}>{needs.join(" · ")}</span>
          </div>
        )}

        {trusted && c.enabled && c.setupPending.includes("integration_key") && (
          <form
            className={styles.inlineForm}
            onSubmit={(event) => {
              event.preventDefault();
              if (!keyInput.trim()) return;
              onAct(c.id, "name", async () => {
                await updateConnectorIntegration(c.id, { integrationKey: keyInput.trim() });
                setKeyInput("");
              });
            }}
          >
            <input
              className={styles.inlineInput}
              placeholder="integration name, e.g. work or macbook"
              value={keyInput}
              onChange={(event) => setKeyInput(event.target.value)}
            />
            <button className={styles.ghostBtn} disabled={cardBusy || !keyInput.trim()}>
              {busy[c.id] === "name" ? "saving…" : "Save"}
            </button>
          </form>
        )}

        {trusted && c.enabled && c.setupPending.includes("auth") && (
          c.authType === "apiKey" ? (
            <form
              className={styles.inlineForm}
              onSubmit={(event) => {
                event.preventDefault();
                if (!tokenInput.trim()) return;
                onAct(c.id, "connect", async () => {
                  await connectConnectorIntegration(c.id, tokenInput.trim());
                  setTokenInput("");
                });
              }}
            >
              <input
                className={styles.inlineInput}
                type="password"
                placeholder="paste API key"
                value={tokenInput}
                onChange={(event) => setTokenInput(event.target.value)}
              />
              <button className={styles.primaryBtn} disabled={cardBusy || !tokenInput.trim()}>
                {busy[c.id] === "connect" ? "connecting…" : "Connect"}
              </button>
            </form>
          ) : (
            <div className={styles.oauthNote}>
              OAuth account connection is coming with the auth module.
            </div>
          )
        )}

        {c.requirements.length > 0 && trusted && c.enabled && (
          <div className={styles.requirements}>
            {c.requirements.map((req) => (
              <RequirementChip key={req.id} integrationId={c.id} req={req} busy={busy} onAct={onAct} />
            ))}
            <button
              className={styles.ghostBtn}
              disabled={cardBusy}
              onClick={() => onAct(c.id, "check", () => checkConnectorRequirements(c.id))}
            >
              {busy[c.id] === "check" ? "checking…" : "re-check all"}
            </button>
          </div>
        )}

        {c.lastError && (state === "attention" || state === "setup") && (
          <div className={styles.lastError}>
            <span className={styles.errorGlyph}>▲</span>
            {c.lastError}
            {state === "attention" && c.mode === "poll" && (
              <span className={styles.retryNote}>auto-retries at next schedule</span>
            )}
          </div>
        )}

        <div className={styles.cardFooter}>
          <span className={styles.timestamps}>
            last run {relativeTime(c.lastRunAt)}
            {c.mode === "poll" && c.nextRunAt ? ` · next ${relativeTime(c.nextRunAt)}` : ""}
          </span>
          <div className={styles.actions}>
            {state === "attention" && (
              <button
                className={styles.primaryBtn}
                disabled={cardBusy}
                onClick={() => onAct(c.id, "restart", () => restartConnectorIntegration(c.id))}
              >
                {busy[c.id] === "restart"
                  ? "working…"
                  : c.mode === "watch"
                    ? "Restart"
                    : c.mode === "poll"
                      ? "Retry now"
                      : "Clear error"}
              </button>
            )}
            {state === "quarantined" && trust === "needs-approval" && panel !== "approve" && (
              <button className={styles.hazardBtn} onClick={() => setPanel("approve")}>
                Review &amp; Approve
              </button>
            )}
            {trusted && c.integrationsMode === "multiple" && panel !== "add" && (
              <button className={styles.ghostBtn} onClick={() => setPanel("add")}>
                + Add
              </button>
            )}
            {c.integrationsMode === "multiple" && interactive && (
              <button
                className={styles.ghostBtn}
                disabled={cardBusy}
                title="Delete this integration"
                onClick={() =>
                  onAct(c.id, "delete", () => deleteConnectorIntegration(c.id))
                }
              >
                {busy[c.id] === "delete" ? "…" : "Delete"}
              </button>
            )}
            {panel !== "remove" && (
              <button
                className={styles.ghostBtn}
                title="Remove connector package"
                onClick={() => setPanel("remove")}
              >
                Remove…
              </button>
            )}
          </div>
        </div>

        {panel === "approve" && (
          <div className={styles.confirmPanel}>
            <div className={styles.confirmText}>
              Approving trusts <strong>this version of the connector</strong> to run inside your
              workspace. If the connector&apos;s code changes later, it is blocked again until you
              re-approve.
            </div>
            <div className={styles.confirmActions}>
              <button
                className={styles.hazardBtn}
                disabled={Boolean(busy[c.connectorId])}
                onClick={() =>
                  onAct(c.connectorId, "approve", async () => {
                    await approveConnector(c.connectorId);
                    setPanel(null);
                  })
                }
              >
                {busy[c.connectorId] === "approve" ? "approving…" : "Approve this version"}
              </button>
              <button className={styles.ghostBtn} onClick={() => setPanel(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {panel === "add" && (
          <form
            className={styles.confirmPanel}
            onSubmit={(event) => {
              event.preventDefault();
              if (!addKeyInput.trim()) return;
              onAct(c.connectorId, "add", async () => {
                await createConnectorIntegration(c.connectorId, addKeyInput.trim());
                setAddKeyInput("");
                setPanel(null);
              });
            }}
          >
            <div className={styles.confirmText}>
              Add another <strong>{c.name}</strong> integration. Each integration is its own
              source with its own account, permissions, and history.
            </div>
            <div className={styles.inlineForm}>
              <input
                className={styles.inlineInput}
                placeholder="integration name, e.g. personal or mac-mini"
                value={addKeyInput}
                onChange={(event) => setAddKeyInput(event.target.value)}
              />
              <button
                className={styles.primaryBtn}
                disabled={Boolean(busy[c.connectorId]) || !addKeyInput.trim()}
              >
                {busy[c.connectorId] === "add" ? "adding…" : "Add"}
              </button>
              <button type="button" className={styles.ghostBtn} onClick={() => setPanel(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {panel === "remove" && (
          <div className={styles.confirmPanel}>
            <div className={styles.confirmText}>
              Remove the <strong>{c.name}</strong> connector from this workspace? Collected events
              stay in your ledger. Its integrations stop running and stay off until the connector
              is installed again.
            </div>
            <div className={styles.confirmActions}>
              <button
                className={styles.hazardBtn}
                disabled={Boolean(busy[c.connectorId])}
                onClick={() =>
                  onAct(c.connectorId, "remove", async () => {
                    await removeConnector(c.connectorId);
                    setPanel(null);
                  })
                }
              >
                {busy[c.connectorId] === "remove" ? "removing…" : "Remove connector"}
              </button>
              <button className={styles.ghostBtn} onClick={() => setPanel(null)}>
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
  onAct: Act;
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
