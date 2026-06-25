export const APP_ID_HEADER = "x-adiabatic-app-id";
export const BRIDGE_TOKEN_HEADER = "x-adiabatic-bridge-token";

export type AuthContext =
  | { kind: "host" }
  | { kind: "bridge"; appId: string };

export interface AuthSecrets {
  coreToken: string;
  bridgeToken: string;
}

export function requireSecret(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function authenticateRequest(req: Request, secrets: AuthSecrets): AuthContext | null {
  const authorization = req.headers.get("authorization");
  if (authorization === `Bearer ${secrets.coreToken}`) {
    return { kind: "host" };
  }

  const bridgeToken = req.headers.get(BRIDGE_TOKEN_HEADER);
  if (bridgeToken === secrets.bridgeToken) {
    const appId = req.headers.get(APP_ID_HEADER);
    if (!appId) return null;
    return { kind: "bridge", appId };
  }

  return null;
}
