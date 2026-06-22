// ConnectorsView — the Source Console: connector integration management.
//
// Hierarchy mirrors the model: a connector package owns its integrations
// (source identities). One card per connector; integrations are rows inside
// it. Trust and platform availability are connector-level; setup, auth,
// permissions, and lifecycle actions are per integration.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnectors } from "../hooks/useConnectors";
import {
  approveConnector,
  checkConnectorRequirements,
  connectConnectorIntegration,
  createConnectorIntegration,
  deleteConnectorIntegration,
  getConnectorOAuthAttempt,
  installConnector,
  removeConnector,
  requestConnectorRequirement,
  restartConnectorIntegration,
  runConnectorIntegration,
  startConnectorOAuth,
  updateConnectorIntegration,
  type ConnectorIntegrationView,
  type ConnectorRequirementView,
} from "../lib/api";
import {
  CHANNEL_LABEL,
  channelState,
  connectorAggregateState,
  relativeTime,
  setupNeeds,
  trustView,
  type ChannelState,
} from "../lib/connector-state";
import styles from "./ConnectorsView.module.css";

type Act = (key: string, label: string, fn: () => Promise<unknown>) => Promise<void>;

export function ConnectorsView({ onOpenCatalog }: { onOpenCatalog?: () => void }) {
  const { connectors, available, loading, error, refresh } = useConnectors();
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

  const groups = useMemo(() => {
    const byConnector = new Map<string, ConnectorIntegrationView[]>();
    for (const c of connectors) {
      const list = byConnector.get(c.connectorId) ?? [];
      list.push(c);
      byConnector.set(c.connectorId, list);
    }
    return [...byConnector.entries()].map(([connectorId, integrations]) => ({
      connectorId,
      integrations,
    }));
  }, [connectors]);

  const counts = useMemo(() => {
    const tally: Partial<Record<ChannelState, number>> = {};
    for (const c of connectors) {
      const state = channelState(c);
      tally[state] = (tally[state] ?? 0) + 1;
    }
    return tally;
  }, [connectors]);

  // Bundled packages that were removed but kept their integration rows can be
  // reinstalled in place from this console; fresh installs live in the
  // Connector Catalog.
  const reinstallable = useMemo(
    () => new Set(available.filter((entry) => !entry.installed).map((entry) => entry.connectorId)),
    [available],
  );

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
        {onOpenCatalog && (
          <button className={styles.ghostBtn} onClick={onOpenCatalog}>
            + Add source
          </button>
        )}
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
        ) : groups.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyGlyph}>⌀</span>
            <span>no sources wired</span>
            {onOpenCatalog ? (
              <button className={styles.ghostBtn} onClick={onOpenCatalog}>
                browse the connector catalog
              </button>
            ) : (
              <span className={styles.emptyHint}>
                install a connector package into workspace/connectors/
              </span>
            )}
          </div>
        ) : (
          groups.map((group, index) => (
            <ConnectorCard
              key={group.connectorId}
              connectorId={group.connectorId}
              integrations={group.integrations}
              installable={reinstallable.has(group.connectorId)}
              index={index}
              busy={busy}
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

interface ConnectorCardProps {
  connectorId: string;
  integrations: ConnectorIntegrationView[];
  installable: boolean;
  index: number;
  busy: Record<string, string>;
  onAct: Act;
}

function ConnectorCard({ connectorId, integrations, installable, index, busy, onAct }: ConnectorCardProps) {
  const head = integrations[0];
  const aggregate = connectorAggregateState(integrations);
  const trust = trustView(head);
  const trusted = trust === "official" || trust === "custom";
  const interactive = aggregate !== "unsupported" && trust !== "broken";

  const [panel, setPanel] = useState<"approve" | "remove" | "add" | null>(null);
  const [addKeyInput, setAddKeyInput] = useState("");

  return (
    <article
      className={`${styles.card} ${styles[`card_${aggregate}`]}`}
      style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
    >
      <div className={styles.cardRail} />
      <div className={styles.cardBody}>
        <div className={styles.cardTop}>
          <span className={`${styles.stateBadge} ${styles[`tone_${aggregate}`]}`}>
            <span className={`${styles.stateDot} ${aggregate === "live" ? styles.pulse : ""}`} />
            {CHANNEL_LABEL[aggregate]}
          </span>
          <h2 className={styles.cardName}>{head.name}</h2>
          <span className={styles.cardMeta}>
            {head.mode}
            {head.scheduleCron ? <span className={styles.cron}> · {head.scheduleCron}</span> : null}
            {trust === "official" && <span className={styles.officialSeal}>official</span>}
            {trust === "custom" && <span className={styles.customSeal}>custom</span>}
            {trust === "broken" && <span className={styles.brokenSeal}>missing</span>}
          </span>
          <div className={styles.cardTopActions}>
            {trust === "broken" && installable && (
              <button
                className={styles.primaryBtn}
                disabled={Boolean(busy[connectorId])}
                title="Reinstall the bundled package; existing settings reconnect"
                onClick={() => onAct(connectorId, "install", () => installConnector(connectorId))}
              >
                {busy[connectorId] === "install" ? "installing…" : "Reinstall"}
              </button>
            )}
            {aggregate === "quarantined" && trust === "needs-approval" && panel !== "approve" && (
              <button className={styles.hazardBtn} onClick={() => setPanel("approve")}>
                Review &amp; Approve
              </button>
            )}
            {trusted && head.integrationsMode === "multiple" && panel !== "add" && (
              <button className={styles.ghostBtn} onClick={() => setPanel("add")}>
                + Add
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
                disabled={Boolean(busy[connectorId])}
                onClick={() =>
                  onAct(connectorId, "approve", async () => {
                    await approveConnector(connectorId);
                    setPanel(null);
                  })
                }
              >
                {busy[connectorId] === "approve" ? "approving…" : "Approve this version"}
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
              onAct(connectorId, "add", async () => {
                await createConnectorIntegration(connectorId, addKeyInput.trim());
                setAddKeyInput("");
                setPanel(null);
              });
            }}
          >
            <div className={styles.confirmText}>
              Add another <strong>{head.name}</strong> integration. Each integration is its own
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
                disabled={Boolean(busy[connectorId]) || !addKeyInput.trim()}
              >
                {busy[connectorId] === "add" ? "adding…" : "Add"}
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
              Remove the <strong>{head.name}</strong> connector from this workspace? Collected
              events stay in your ledger. Its integrations stop running and stay off until the
              connector is installed again.
            </div>
            <div className={styles.confirmActions}>
              <button
                className={styles.hazardBtn}
                disabled={Boolean(busy[connectorId])}
                onClick={() =>
                  onAct(connectorId, "remove", async () => {
                    await removeConnector(connectorId);
                    setPanel(null);
                  })
                }
              >
                {busy[connectorId] === "remove" ? "removing…" : "Remove connector"}
              </button>
              <button className={styles.ghostBtn} onClick={() => setPanel(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className={styles.integrationList}>
          {integrations.map((c) => (
            <IntegrationRow
              key={c.id}
              connector={c}
              trusted={trusted}
              interactive={interactive}
              busy={busy}
              onAct={onAct}
            />
          ))}
        </div>
      </div>
    </article>
  );
}

interface IntegrationRowProps {
  connector: ConnectorIntegrationView;
  trusted: boolean;
  interactive: boolean;
  busy: Record<string, string>;
  onAct: Act;
}

function IntegrationRow({ connector: c, trusted, interactive, busy, onAct }: IntegrationRowProps) {
  const state = channelState(c);
  const needs = setupNeeds(c);
  const [tokenInput, setTokenInput] = useState("");
  const [clientSecretInput, setClientSecretInput] = useState("");
  const [clientIdInput, setClientIdInput] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const cardBusy = Boolean(busy[c.id]);
  const showSetup = trusted && interactive && c.enabled;

  return (
    <div className={styles.integrationRow}>
      <div className={styles.rowTop}>
        <span className={`${styles.rowBadge} ${styles[`tone_${state}`]}`}>
          <span className={`${styles.stateDot} ${state === "live" ? styles.pulse : ""}`} />
          {CHANNEL_LABEL[state]}
        </span>
        <span className={styles.sourceLine}>
          {c.source ?? `connector:${c.connectorId} — needs an integration name`}
        </span>
        <span className={styles.timestamps}>
          last run {relativeTime(c.lastRunAt)}
          {c.mode === "poll" && c.nextRunAt ? ` · next ${relativeTime(c.nextRunAt)}` : ""}
        </span>
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
        {c.mode === "manual" && interactive && trusted && c.setupStatus === "ready" && c.status !== "error" && (
          <button
            className={styles.primaryBtn}
            title="Run this connector now"
            disabled={cardBusy || c.status === "running"}
            onClick={() => onAct(c.id, "run", () => runConnectorIntegration(c.id))}
          >
            {busy[c.id] === "run" || c.status === "running" ? "running…" : "Run"}
          </button>
        )}
        {c.integrationsMode === "multiple" && interactive && trusted && (
          <button
            className={styles.ghostBtn}
            disabled={cardBusy}
            title="Delete this integration"
            onClick={() => onAct(c.id, "delete", () => deleteConnectorIntegration(c.id))}
          >
            {busy[c.id] === "delete" ? "…" : "Delete"}
          </button>
        )}
        {interactive && trusted && (
          <button
            className={`${styles.toggle} ${c.enabled ? styles.toggleOn : ""}`}
            title={c.enabled ? "Disable" : "Enable"}
            disabled={cardBusy}
            onClick={() =>
              onAct(c.id, "toggle", () => updateConnectorIntegration(c.id, { enabled: !c.enabled }))
            }
          >
            <span className={styles.toggleKnob} />
          </button>
        )}
      </div>

      {state === "setup" && needs.length > 0 && (
        <div className={styles.needsLine}>
          needs <span className={styles.needsItems}>{needs.join(" · ")}</span>
        </div>
      )}

      {c.authAttention === "redirect_uri_changed" && (
        <div className={styles.lastError}>
          <span className={styles.errorGlyph}>▲</span>
          OAuth redirect URI changed. Existing tokens may keep working, but update the provider app before reconnecting this account.
        </div>
      )}

      {c.authAttention === "refresh_failed" && (
        <div className={styles.lastError}>
          <span className={styles.errorGlyph}>▲</span>
          OAuth refresh failed. Reconnect this account.
        </div>
      )}

      {showSetup && c.setupPending.includes("integration_key") && (
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

      {showSetup && c.setupPending.includes("auth") && (
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
        ) : c.authType === "oauth2" ? (
          <form
            className={styles.oauthBox}
            onSubmit={(event) => {
              event.preventDefault();
              const requiresSecret = c.authTokenEndpointAuthMethod
                && c.authTokenEndpointAuthMethod !== "none";
              if (requiresSecret && !clientSecretInput.trim()) return;
              if (c.authNeedsClientId && !clientIdInput.trim()) return;
              onAct(c.id, "oauth", async () => {
                const started = await startConnectorOAuth(c.id, {
                  clientSecret: clientSecretInput.trim() || undefined,
                  clientId: clientIdInput.trim() || undefined,
                });
                await openAuthorizationUrl(started.authorizationUrl);
                await waitForOAuthAttempt(c.id, started.attemptId);
                setClientSecretInput("");
                setClientIdInput("");
              });
            }}
          >
            {c.oauthRedirectUri && (
              <div className={styles.oauthNote}>
                redirect <span className={styles.redirectUri}>{c.oauthRedirectUri}</span>
              </div>
            )}
            {c.authNeedsClientId && (
              <input
                className={styles.inlineInput}
                type="text"
                placeholder="OAuth client ID (your registered app)"
                value={clientIdInput}
                onChange={(event) => setClientIdInput(event.target.value)}
              />
            )}
            {c.authTokenEndpointAuthMethod && c.authTokenEndpointAuthMethod !== "none" && (
              <input
                className={styles.inlineInput}
                type="password"
                placeholder="OAuth client secret"
                value={clientSecretInput}
                onChange={(event) => setClientSecretInput(event.target.value)}
              />
            )}
            <button
              className={styles.primaryBtn}
              disabled={
                cardBusy
                || Boolean(c.authTokenEndpointAuthMethod && c.authTokenEndpointAuthMethod !== "none" && !clientSecretInput.trim())
                || Boolean(c.authNeedsClientId && !clientIdInput.trim())
              }
            >
              {busy[c.id] === "oauth" ? "waiting…" : "Connect Account"}
            </button>
          </form>
        ) : (
          <div className={styles.oauthNote}>Unsupported auth type.</div>
        )
      )}

      {c.requirements.length > 0 && showSetup && (
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

      {trusted && interactive && c.configSchema && Object.keys(c.configSchema).length > 0 && (
        <ConfigForm connector={c} busy={busy} onAct={onAct} />
      )}
    </div>
  );
}

// Schema-driven settings form: one input per declared config field, prefilled
// from the integration's stored override or the author default. Save writes the
// overrides; Reset clears them so the schema defaults apply again.
function buildConfigValues(
  schema: NonNullable<ConnectorIntegrationView["configSchema"]>,
  config: ConnectorIntegrationView["config"],
): Record<string, string | number | boolean> {
  const next: Record<string, string | number | boolean> = {};
  for (const [key, field] of Object.entries(schema)) {
    const current = config?.[key];
    const fallback = field.default ?? (field.type === "boolean" ? false : field.type === "number" ? 0 : "");
    next[key] = (current ?? fallback) as string | number | boolean;
  }
  return next;
}

function ConfigForm({ connector: c, busy, onAct }: {
  connector: ConnectorIntegrationView;
  busy: Record<string, string>;
  onAct: Act;
}) {
  const schema = c.configSchema ?? {};
  const cardBusy = Boolean(busy[c.id]);

  // Key the re-sync on the *content* of the stored config (+ schema), not object
  // identity: useConnectors polls every 2s and hands us fresh refs each tick, so
  // keying on identity would revert an in-progress edit. This re-syncs only when
  // the stored values actually change (after Save/Reset).
  const storedKey = JSON.stringify([c.config ?? {}, schema]);
  const [values, setValues] = useState<Record<string, string | number | boolean>>(
    () => buildConfigValues(schema, c.config),
  );
  useEffect(() => {
    setValues(buildConfigValues(schema, c.config));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey]);

  return (
    <form
      className={styles.configForm}
      onSubmit={(event) => {
        event.preventDefault();
        onAct(c.id, "config", () => updateConnectorIntegration(c.id, { config: values }));
      }}
    >
      {Object.entries(schema).map(([key, field]) => (
        <label key={key} className={styles.configField}>
          <span className={styles.configLabel}>{field.label}</span>
          {field.type === "boolean" ? (
            <input
              type="checkbox"
              checked={Boolean(values[key])}
              onChange={(event) => setValues((v) => ({ ...v, [key]: event.target.checked }))}
            />
          ) : (
            <input
              className={styles.inlineInput}
              type={field.type === "number" ? "number" : "text"}
              value={String(values[key] ?? "")}
              onChange={(event) =>
                setValues((v) => ({
                  ...v,
                  [key]: field.type === "number" ? Number(event.target.value) : event.target.value,
                }))
              }
            />
          )}
        </label>
      ))}
      <div className={styles.configActions}>
        <button className={styles.primaryBtn} disabled={cardBusy}>
          {busy[c.id] === "config" ? "saving…" : "Save settings"}
        </button>
        <button
          type="button"
          className={styles.ghostBtn}
          disabled={cardBusy}
          title="Clear overrides and restore defaults"
          onClick={() => onAct(c.id, "config", () => updateConnectorIntegration(c.id, { config: {} }))}
        >
          {busy[c.id] === "config" ? "…" : "Reset"}
        </button>
      </div>
    </form>
  );
}

async function openAuthorizationUrl(url: string): Promise<void> {
  if (window.adiabaticHost?.openExternal) {
    await window.adiabaticHost.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener");
}

async function waitForOAuthAttempt(integrationId: string, attemptId: string): Promise<void> {
  for (let i = 0; i < 180; i++) {
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
    const result = await getConnectorOAuthAttempt(integrationId, attemptId);
    if (result.status === "pending") continue;
    if (result.status === "connected") return;
    throw new Error(result.error ?? `OAuth ${result.status}`);
  }
  throw new Error("OAuth connection timed out");
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
