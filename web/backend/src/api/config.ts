export interface ApiConfig {
  appEnv: "dev" | "prod";
  secretName: string;
  appOrigin: string;
  apiOrigin: string;
  allowedOrigins: string[];
  usersTable: string;
  userIdentitiesTable: string;
  desktopSessionsTable: string;
  managedProviderConnectionsTable: string;
  managedProviderCapabilityTokensTable: string;
  oauthStateTable: string;
}

let cachedConfig: ApiConfig | null = null;

export function getConfig(): ApiConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const appEnv = requiredEnv("APP_ENV");
  if (appEnv !== "dev" && appEnv !== "prod") {
    throw new Error(`Invalid APP_ENV: ${appEnv}`);
  }

  cachedConfig = {
    appEnv,
    secretName: requiredEnv("SECRET_NAME"),
    appOrigin: requiredEnv("LAMARCK_APP_ORIGIN"),
    apiOrigin: requiredEnv("LAMARCK_API_ORIGIN"),
    allowedOrigins: parseCsvEnv("LAMARCK_ALLOWED_ORIGINS"),
    usersTable: requiredEnv("USERS_TABLE"),
    userIdentitiesTable: requiredEnv("USER_IDENTITIES_TABLE"),
    desktopSessionsTable: requiredEnv("DESKTOP_SESSIONS_TABLE"),
    managedProviderConnectionsTable: requiredEnv("MANAGED_PROVIDER_CONNECTIONS_TABLE"),
    managedProviderCapabilityTokensTable: requiredEnv("MANAGED_PROVIDER_CAPABILITY_TOKENS_TABLE"),
    oauthStateTable: requiredEnv("OAUTH_STATE_TABLE"),
  };

  return cachedConfig;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseCsvEnv(name: string): string[] {
  const raw = requiredEnv(name);
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}
