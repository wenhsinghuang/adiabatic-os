import { describe, expect, test } from "bun:test";
import {
  APP_ID_HEADER,
  BRIDGE_TOKEN_HEADER,
  authenticateRequest,
} from "../src/auth";

const secrets = {
  coreToken: "core-secret",
  bridgeToken: "bridge-secret",
};

describe("auth", () => {
  test("accepts host bearer token", () => {
    const req = new Request("http://localhost:3000/api/apps", {
      headers: { Authorization: "Bearer core-secret" },
    });

    expect(authenticateRequest(req, secrets)).toEqual({ kind: "host" });
  });

  test("accepts bridge token only with app id", () => {
    const req = new Request("http://localhost:3000/api/query", {
      headers: {
        [BRIDGE_TOKEN_HEADER]: "bridge-secret",
        [APP_ID_HEADER]: "hello-world",
      },
    });

    expect(authenticateRequest(req, secrets)).toEqual({
      kind: "bridge",
      appId: "hello-world",
    });
  });

  test("rejects missing or mismatched credentials", () => {
    expect(authenticateRequest(new Request("http://localhost:3000/api/apps"), secrets)).toBeNull();
    expect(
      authenticateRequest(
        new Request("http://localhost:3000/api/apps", {
          headers: { Authorization: "Bearer wrong" },
        }),
        secrets,
      ),
    ).toBeNull();
    expect(
      authenticateRequest(
        new Request("http://localhost:3000/api/apps", {
          headers: { [BRIDGE_TOKEN_HEADER]: "bridge-secret" },
        }),
        secrets,
      ),
    ).toBeNull();
  });
});
