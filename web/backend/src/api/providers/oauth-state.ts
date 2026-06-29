import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHash, randomBytes } from "node:crypto";

import { getConfig } from "../config";
import { HttpError } from "../http";

const PROVIDER_OAUTH_STATE_TTL_SECONDS = 10 * 60;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

interface ManagedProviderOAuthStateItem {
  state: string;
  kind: "managedProviderOAuthState";
  providerId: string;
  userId: string;
  integrationId: string;
  createdAt: string;
  expiresAt: number;
}

export interface ManagedProviderOAuthState {
  providerId: string;
  userId: string;
  integrationId: string;
}

export async function createManagedProviderOAuthState(input: {
  providerId: string;
  userId: string;
  integrationId: string;
}): Promise<string> {
  const state = `mp_${randomBytes(32).toString("base64url")}`;
  const now = new Date();
  const item: ManagedProviderOAuthStateItem = {
    state: stateKey(input.providerId, state),
    kind: "managedProviderOAuthState",
    providerId: input.providerId,
    userId: input.userId,
    integrationId: input.integrationId,
    createdAt: now.toISOString(),
    expiresAt: Math.floor(now.getTime() / 1000) + PROVIDER_OAUTH_STATE_TTL_SECONDS,
  };

  await ddb.send(
    new PutCommand({
      TableName: getConfig().oauthStateTable,
      Item: item,
      ConditionExpression: "attribute_not_exists(#state)",
      ExpressionAttributeNames: {
        "#state": "state",
      },
    }),
  );

  return state;
}

export async function consumeManagedProviderOAuthState(
  providerId: string,
  state: string | undefined,
): Promise<ManagedProviderOAuthState> {
  if (!state) {
    throw new HttpError(400, "missing_oauth_state", "Provider OAuth callback is missing state.");
  }

  const key = stateKey(providerId, state);
  const result = await ddb.send(
    new GetCommand({
      TableName: getConfig().oauthStateTable,
      Key: { state: key },
      ConsistentRead: true,
    }),
  );
  const item = result.Item as ManagedProviderOAuthStateItem | undefined;
  if (!item || item.kind !== "managedProviderOAuthState" || item.providerId !== providerId) {
    throw new HttpError(400, "invalid_oauth_state", "Provider OAuth state is invalid or expired.");
  }

  await ddb.send(
    new DeleteCommand({
      TableName: getConfig().oauthStateTable,
      Key: { state: key },
    }),
  );

  if (item.expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new HttpError(400, "expired_oauth_state", "Provider OAuth state expired.");
  }

  return {
    providerId: item.providerId,
    userId: item.userId,
    integrationId: item.integrationId,
  };
}

function stateKey(providerId: string, state: string): string {
  return `managed-provider-oauth:${providerId}:${hash(state)}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
