import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createClerkClient, verifyToken, type User } from "@clerk/backend";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { randomBytes } from "node:crypto";

import { getConfig } from "./config";
import { bearerToken, HttpError } from "./http";
import { getAppSecretValue } from "./secrets";

export interface LamarckUser {
  userId: string;
  email: string | null;
  displayName: string | null;
  imageUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

let cachedClerkSecretKey: string | null = null;

export async function requireLamarckUser(
  event: APIGatewayProxyEventV2,
): Promise<LamarckUser> {
  const clerkUserId = await requireClerkUserId(event);
  const secretKey = await getClerkSecretKey();
  const clerk = createClerkClient({ secretKey });
  const clerkUser = await clerk.users.getUser(clerkUserId);

  return upsertUser(clerkUser);
}

async function requireClerkUserId(event: APIGatewayProxyEventV2): Promise<string> {
  const token = bearerToken(event);
  if (!token) {
    throw new HttpError(401, "missing_session", "Missing Clerk session bearer token.");
  }

  try {
    const verified = await verifyToken(token, {
      secretKey: await getClerkSecretKey(),
      authorizedParties: getConfig().allowedOrigins,
    });

    if (!verified.sub) {
      throw new HttpError(401, "invalid_session", "Clerk session token is missing subject.");
    }

    return verified.sub;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(401, "invalid_session", "Clerk session token could not be verified.");
  }
}

async function getClerkSecretKey(): Promise<string> {
  if (cachedClerkSecretKey) {
    return cachedClerkSecretKey;
  }
  cachedClerkSecretKey = await getAppSecretValue("CLERK_SECRET_KEY");
  return cachedClerkSecretKey;
}

async function upsertUser(clerkUser: User): Promise<LamarckUser> {
  const now = new Date().toISOString();
  const profile = userProfile(clerkUser);
  const identityKey = identityKeyFor("clerk", clerkUser.id);
  const existingIdentity = await getIdentity(identityKey);
  const userId =
    existingIdentity?.userId ?? (await createUserForIdentity(identityKey, clerkUser.id, profile, now));

  const result = await ddb.send(
    new UpdateCommand({
      TableName: getConfig().usersTable,
      Key: { userId },
      UpdateExpression: [
        "SET email = :email",
        "displayName = :displayName",
        "imageUrl = :imageUrl",
        "updatedAt = :now",
        "createdAt = if_not_exists(createdAt, :now)",
      ].join(", "),
      ExpressionAttributeValues: {
        ":email": profile.email,
        ":displayName": profile.displayName,
        ":imageUrl": profile.imageUrl,
        ":now": now,
      },
      ReturnValues: "ALL_NEW",
    }),
  );

  const item = result.Attributes;
  if (!item) {
    throw new Error("DynamoDB user upsert did not return a user item");
  }

  return {
    userId: String(item.userId),
    email: nullableString(item.email),
    displayName: nullableString(item.displayName),
    imageUrl: nullableString(item.imageUrl),
    createdAt: String(item.createdAt),
    updatedAt: String(item.updatedAt),
  };
}

async function getIdentity(identityKey: string): Promise<{ userId: string } | null> {
  const result = await ddb.send(
    new GetCommand({
      TableName: getConfig().userIdentitiesTable,
      Key: { identityKey },
      ConsistentRead: true,
    }),
  );

  if (!result.Item?.userId) {
    return null;
  }
  return { userId: String(result.Item.userId) };
}

async function createUserForIdentity(
  identityKey: string,
  clerkUserId: string,
  profile: Pick<LamarckUser, "email" | "displayName" | "imageUrl">,
  now: string,
): Promise<string> {
  const userId = newUserId();

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: getConfig().usersTable,
              Item: {
                userId,
                email: profile.email,
                displayName: profile.displayName,
                imageUrl: profile.imageUrl,
                createdAt: now,
                updatedAt: now,
              },
              ConditionExpression: "attribute_not_exists(userId)",
            },
          },
          {
            Put: {
              TableName: getConfig().userIdentitiesTable,
              Item: {
                identityKey,
                identityProvider: "clerk",
                identitySubject: clerkUserId,
                userId,
                createdAt: now,
                updatedAt: now,
              },
              ConditionExpression: "attribute_not_exists(identityKey)",
            },
          },
        ],
      }),
    );
    return userId;
  } catch (error) {
    const racedIdentity = await getIdentity(identityKey);
    if (racedIdentity) {
      return racedIdentity.userId;
    }
    throw error;
  }
}

function identityKeyFor(provider: string, subject: string): string {
  return `${provider}:${subject}`;
}

function newUserId(): string {
  return `usr_${randomBytes(16).toString("base64url")}`;
}

function userProfile(user: User): Pick<LamarckUser, "email" | "displayName" | "imageUrl"> {
  const primaryEmail =
    user.emailAddresses.find((email) => email.id === user.primaryEmailAddressId)?.emailAddress ??
    user.emailAddresses[0]?.emailAddress ??
    null;
  const displayName = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username;

  return {
    email: primaryEmail,
    displayName: displayName || null,
    imageUrl: user.imageUrl || null,
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
