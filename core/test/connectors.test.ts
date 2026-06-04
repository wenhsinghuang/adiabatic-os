import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDB } from "../src/db";
import { Guard } from "../src/guard";
import {
  ConnectorSupervisor,
  MemoryConnectorSecretStore,
  ConnectorAuthManager,
  loadConnectorManifest,
  resolveConnectorEntry,
  sourceForConnector,
  validateConnectorManifest,
  type ConnectorDefinition,
  type ConnectorManifest,
} from "../src/connectors";

describe("Connector system", () => {
  let workspace: string;
  let db: ReturnType<typeof openDB>["db"];
  let close: () => void;
  let supervisor: ConnectorSupervisor;
  let secrets: MemoryConnectorSecretStore;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "adiabatic-connector-test-"));
    mkdirSync(join(workspace, ".adiabatic"), { recursive: true });
    const result = openDB(workspace);
    db = result.db;
    close = result.close;
    secrets = new MemoryConnectorSecretStore();
    supervisor = new ConnectorSupervisor({
      db,
      guard: new Guard({ db, source: "system:test" }),
      platform: "darwin",
      authManager: new ConnectorAuthManager(secrets),
    });
  });

  afterEach(() => {
    close();
    rmSync(workspace, { recursive: true, force: true });
  });

  test("loads and validates a connector manifest from YAML", async () => {
    const dir = join(workspace, "connectors", "calendar");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "connector.yaml"),
      `id: calendar
name: Calendar
entry: ./index.mjs
runtime:
  mode: poll
  schedule: every 15m
platforms:
  - darwin
  - cloud
auth:
  type: oauth2
  provider: google
  scopes:
    - https://www.googleapis.com/auth/calendar.readonly
events:
  - calendar.event
`,
    );

    const manifest = await loadConnectorManifest(dir);
    expect(manifest).toMatchObject({
      id: "calendar",
      name: "Calendar",
      entry: "./index.mjs",
      runtime: { mode: "poll", schedule: "every 15m" },
      platforms: ["darwin", "cloud"],
      auth: {
        type: "oauth2",
        provider: "google",
        scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
      },
      events: ["calendar.event"],
    });
  });

  test("rejects invalid manifest ids, modes, schedules, auth, and platforms", () => {
    const base: ConnectorManifest = {
      id: "demo",
      name: "Demo",
      entry: "./index.ts",
      runtime: { mode: "poll" },
    };

    expect(() => validateConnectorManifest({ ...base, id: "../demo" })).toThrow("Invalid connector id");
    expect(() =>
      validateConnectorManifest({ ...base, runtime: { mode: "stream" as any } })
    ).toThrow("invalid runtime mode");
    expect(() =>
      validateConnectorManifest({ ...base, runtime: { mode: "watch", schedule: "every 1m" } })
    ).toThrow("schedule is only valid");
    expect(() =>
      validateConnectorManifest({ ...base, platforms: ["haiku" as any] })
    ).toThrow("invalid platform");
    expect(() =>
      validateConnectorManifest({ ...base, auth: { type: "oauth2", provider: "" } })
    ).toThrow("oauth2 auth requires provider");
  });

  test("runs a connector with bound guard, config, and persistent state", async () => {
    const definition: ConnectorDefinition<{ label: string }, { cursor: string }> = {
      async run({ guard, state, config }) {
        expect(await state.get()).toBeUndefined();
        expect(config).toEqual({ label: "override", extra: true });
        await guard.writeEvent({
          type: "app.commit",
          externalId: "abc123",
          startedAt: 1000,
          payload: { sha: "abc123", label: config.label },
        });
        await state.set({ cursor: "abc123" });
      },
    };

    supervisor.register(
      {
        id: "app-commits",
        name: "App Commits",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        auth: { type: "none" },
        config: { label: "manifest" },
      },
      definition,
    );
    supervisor.ensureIntegration({
      connectorId: "app-commits",
      config: { label: "integration", extra: true },
    });

    await supervisor.run("app-commits", { config: { label: "override" } });

    const event = db.prepare("SELECT * FROM events WHERE type = ?").get("app.commit") as any;
    expect(event.source).toBe("connector:app-commits");
    expect(event.external_id).toBe("abc123");
    expect(JSON.parse(event.payload)).toEqual({ sha: "abc123", label: "override" });

    const integration = supervisor.getIntegration<unknown, { cursor: string }>("app-commits");
    expect(integration?.status).toBe("idle");
    expect(integration?.syncState).toEqual({ cursor: "abc123" });
    expect(integration?.lastRunAt).toBeGreaterThan(0);
  });

  test("supports multiple connector instances with separate sources and state", async () => {
    const definition: ConnectorDefinition<{ externalId: string }, { seen: string }> = {
      async run({ guard, state, config }) {
        await guard.writeEvent({
          type: "calendar.event",
          externalId: config.externalId,
          startedAt: 2000,
          payload: { id: config.externalId },
        });
        await state.set({ seen: config.externalId });
      },
    };

    supervisor.register(
      {
        id: "calendar",
        name: "Calendar",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        auth: { type: "none" },
      },
      definition,
    );
    supervisor.ensureIntegration({ id: "calendar-personal", connectorId: "calendar", config: { externalId: "same" } });
    supervisor.ensureIntegration({ id: "calendar-work", connectorId: "calendar", config: { externalId: "same" } });

    await supervisor.run("calendar-personal");
    await supervisor.run("calendar-work");

    const rows = db.prepare("SELECT source, external_id FROM events ORDER BY source").all() as any[];
    expect(rows).toEqual([
      { source: "connector:calendar-personal", external_id: "same" },
      { source: "connector:calendar-work", external_id: "same" },
    ]);
    expect(supervisor.getIntegration("calendar-personal")?.syncState).toEqual({ seen: "same" });
    expect(supervisor.getIntegration("calendar-work")?.syncState).toEqual({ seen: "same" });
  });

  test("provides auth as a capability handle", async () => {
    let tokenSeen = "";
    const definition: ConnectorDefinition = {
      async run({ auth, guard }) {
        if (auth.type === "none") throw new Error("expected auth");
        tokenSeen = await auth.getToken();
        await guard.writeEvent({
          type: "oura.sample",
          startedAt: 3000,
          payload: { ok: true },
        });
      },
    };

    supervisor.register(
      {
        id: "oura",
        name: "Oura",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        auth: { type: "apiKey", label: "Oura Token" },
      },
      definition,
    );
    const integration = supervisor.ensureIntegration({ connectorId: "oura" });
    await supervisor.getAuthManager().setToken(integration.authRef!, "secret-token");

    await supervisor.run("oura");

    expect(tokenSeen).toBe("secret-token");
    const event = db.prepare("SELECT source, type FROM events").get() as any;
    expect(event).toEqual({ source: "connector:oura", type: "oura.sample" });
  });

  test("connector guard accepts non-object JSON payloads and rejects non-JSON payloads", async () => {
    supervisor.register(
      {
        id: "json-feed",
        name: "JSON Feed",
        entry: "./index.ts",
        runtime: { mode: "import" },
        auth: { type: "none" },
      },
      {
        async run({ guard }) {
          await guard.writeEvent({
            type: "json.string",
            startedAt: 3100,
            payload: "hello",
          });
          await expect(guard.writeEvent({
            type: "json.bad",
            startedAt: 3101,
            payload: (() => undefined) as any,
          })).rejects.toThrow("JSON-serializable");
        },
      },
    );
    supervisor.ensureIntegration({ connectorId: "json-feed" });

    await supervisor.run("json-feed");

    const event = db.prepare("SELECT payload FROM events WHERE type = ?").get("json.string") as any;
    expect(JSON.parse(event.payload)).toBe("hello");
  });

  test("fails auth connectors without credentials and records integration error", async () => {
    supervisor.register(
      {
        id: "oura",
        name: "Oura",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        auth: { type: "apiKey" },
      },
      {
        async run({ auth }) {
          if (auth.type === "none") throw new Error("expected auth");
          await auth.getToken();
        },
      },
    );
    supervisor.ensureIntegration({ connectorId: "oura" });

    await expect(supervisor.run("oura")).rejects.toThrow("missing credentials");
    const integration = supervisor.getIntegration("oura");
    expect(integration?.status).toBe("error");
    expect(integration?.lastError).toContain("missing credentials");
  });

  test("gates integrations by platform", () => {
    const linuxSupervisor = new ConnectorSupervisor({
      db,
      guard: new Guard({ db, source: "system:test" }),
      platform: "linux",
    });
    linuxSupervisor.register(
      {
        id: "macos-ax",
        name: "macOS Accessibility",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        platforms: ["darwin"],
        auth: { type: "localPermission", permission: "macos.accessibility" },
      },
      { async run() {} },
    );

    expect(() =>
      linuxSupervisor.ensureIntegration({ connectorId: "macos-ax" })
    ).toThrow("not supported on linux");
  });

  test("starts and aborts watch connector runs", async () => {
    supervisor.register(
      {
        id: "terminal",
        name: "Terminal",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        auth: { type: "none" },
      },
      {
        async run({ signal, state, guard }) {
          await guard.writeEvent({
            type: "terminal.session.started",
            startedAt: 4000,
            payload: { session: "s1" },
          });
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
            } else {
              signal.addEventListener("abort", () => resolve(), { once: true });
            }
          });
          await state.set({ stopped: true });
        },
      },
    );
    supervisor.ensureIntegration({ connectorId: "terminal" });

    const handle = supervisor.start("terminal");
    expect(supervisor.list()[0].running).toBe(true);
    handle.abort();
    await handle.promise;

    expect(supervisor.list()[0].running).toBe(false);
    expect(supervisor.getIntegration("terminal")?.status).toBe("idle");
    expect(supervisor.getIntegration("terminal")?.syncState).toEqual({ stopped: true });
  });

  test("loads connector runtime from directory entry", async () => {
    const dir = join(workspace, "connectors", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "connector.yaml"),
      `id: demo
name: Demo
entry: ./index.mjs
runtime:
  mode: import
auth:
  type: none
events:
  - demo.event
`,
    );
    writeFileSync(
      join(dir, "index.mjs"),
      `export default {
  async run({ guard, state }) {
    await guard.writeEvent({
      type: "demo.event",
      externalId: "loaded",
      startedAt: 5000,
      payload: { loaded: true },
    });
    await state.set({ loaded: true });
  },
};
`,
    );

    const manifest = await supervisor.registerDirectory(dir);
    supervisor.ensureIntegration({ connectorId: manifest.id });
    await supervisor.run("demo");

    const event = db.prepare("SELECT source, type, external_id FROM events").get() as any;
    expect(event).toEqual({
      source: "connector:demo",
      type: "demo.event",
      external_id: "loaded",
    });
    expect(supervisor.getIntegration("demo")?.syncState).toEqual({ loaded: true });
  });

  test("rejects connector entries outside connector directory", () => {
    expect(() => resolveConnectorEntry("/tmp/connector", "../outside.mjs")).toThrow("inside connector directory");
  });

  test("uses the connector source namespace helper", () => {
    expect(sourceForConnector("terminal")).toBe("connector:terminal");
    expect(() => sourceForConnector("../terminal")).toThrow("Invalid connector id");
  });
});
