import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { getAppSecretValue } from "./secrets";

const KEY_ID = "v1";
const ALGORITHM = "A256GCM";
const CIPHER = "aes-256-gcm";

interface TokenEnvelope {
  v: 1;
  alg: typeof ALGORITHM;
  kid: typeof KEY_ID;
  iv: string;
  tag: string;
  ciphertext: string;
}

let cachedKey: Buffer | null = null;

export async function encryptJson(value: unknown, aad: string): Promise<string> {
  const key = await tokenEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope: TokenEnvelope = {
    v: 1,
    alg: ALGORITHM,
    kid: KEY_ID,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
  return JSON.stringify(envelope);
}

export async function decryptJson<T>(envelopeJson: string, aad: string): Promise<T> {
  const envelope = JSON.parse(envelopeJson) as Partial<TokenEnvelope>;
  if (
    envelope.v !== 1 ||
    envelope.alg !== ALGORITHM ||
    envelope.kid !== KEY_ID ||
    !envelope.iv ||
    !envelope.tag ||
    !envelope.ciphertext
  ) {
    throw new Error("Invalid encrypted token envelope");
  }

  const key = await tokenEncryptionKey();
  const decipher = createDecipheriv(CIPHER, key, Buffer.from(envelope.iv, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

async function tokenEncryptionKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  const raw = await getAppSecretValue("TOKEN_ENCRYPTION_KEY_V1");
  const key = Buffer.from(raw, "base64url");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY_V1 must decode to 32 bytes");
  }
  cachedKey = key;
  return cachedKey;
}
