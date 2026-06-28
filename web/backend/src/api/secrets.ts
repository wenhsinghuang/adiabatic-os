import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

import { getConfig } from "./config";

const secretsManager = new SecretsManagerClient({});
let cachedSecret: Record<string, string> | null = null;

export async function getAppSecretValue(name: string): Promise<string> {
  const bundle = await getAppSecretBundle();
  const value = bundle[name];
  if (!value) {
    throw new Error(`Missing ${name} in ${getConfig().secretName}`);
  }
  return value;
}

async function getAppSecretBundle(): Promise<Record<string, string>> {
  if (cachedSecret) {
    return cachedSecret;
  }

  const { secretName } = getConfig();
  const response = await secretsManager.send(
    new GetSecretValueCommand({
      SecretId: secretName,
    }),
  );

  if (!response.SecretString) {
    throw new Error(`${secretName} does not contain a JSON SecretString`);
  }

  const parsed = JSON.parse(response.SecretString) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${secretName} SecretString must be a JSON object`);
  }

  cachedSecret = Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [key, String(value)]),
  );
  return cachedSecret;
}
