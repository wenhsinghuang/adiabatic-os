#!/usr/bin/env bun
import { readFile } from "fs/promises";

const baseUrl = process.env.ADIABATIC_CORE_URL ?? "http://localhost:3000";
const coreToken = process.env.ADIABATIC_CORE_TOKEN;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    usage();
    return;
  }

  if (command === "query") {
    const sql = args.join(" ").trim();
    if (!sql) die("query requires SQL");
    const result = await post<{ rows: unknown[] }>("/api/query", { sql });
    console.log(JSON.stringify(result.rows, null, 2));
    return;
  }

  if (command === "promote" || command === "demote") {
    const ddl = await readDdlArg(args);
    if (!ddl.trim()) die(`${command} requires DDL`);
    const result = await post<{
      status: "pending" | "applied";
      request?: { id: string; status: string };
    }>(`/api/schema/${command}/request`, { ddl, requestedBy: "coding-agent" });

    if (result.status === "applied") {
      console.log(`${command} applied`);
      return;
    }

    const id = result.request?.id;
    if (!id) die("schema request returned without id");
    console.log(`${command} pending approval: ${id}`);
    await waitForSchemaRequest(id);
    return;
  }

  die(`unknown command: ${command}`);
}

async function readDdlArg(args: string[]): Promise<string> {
  if (args[0] === "--file" || args[0] === "-f") {
    const file = args[1];
    if (!file) die("--file requires a path");
    return readFile(file, "utf8");
  }
  return args.join(" ");
}

async function waitForSchemaRequest(id: string): Promise<void> {
  for (;;) {
    await Bun.sleep(1000);
    const result = await get<{ request: { status: string; error?: string } }>(`/api/schema/requests/${id}`);
    if (result.request.status === "pending") continue;
    if (result.request.status === "applied") {
      console.log(`schema request applied: ${id}`);
      return;
    }
    if (result.request.status === "failed") {
      die(`schema request failed: ${result.request.error ?? id}`);
    }
    die(`schema request ${result.request.status}: ${id}`);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  return readResponse<T>(res);
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, { headers: authHeaders() });
  return readResponse<T>(res);
}

function authHeaders(): Record<string, string> {
  if (!coreToken) {
    die("ADIABATIC_CORE_TOKEN is required");
  }
  return {
    Authorization: `Bearer ${coreToken}`,
    "Content-Type": "application/json",
  };
}

async function readResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    die(body.error ?? `${res.status} ${res.statusText}`);
  }
  return body as T;
}

function usage(): void {
  console.log(`Usage:
  adiabatic query "<sql>"
  adiabatic promote "<ddl>"
  adiabatic promote --file schema.sql
  adiabatic demote "<ddl>"
  adiabatic demote --file cleanup.sql`);
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
