import { getConfig } from "../../config";
import { HttpError, redirect } from "../../http";
import { logInfo, logWarn } from "../../log";
import { createManagedProviderOAuthState, consumeManagedProviderOAuthState } from "../oauth-state";
import type { ManagedProviderContext } from "../types";
import { metadata } from "./metadata";
import { exchangeOuraCode, ouraOAuthConfig, storeOuraConnection } from "./tokens";

const OURA_AUTHORIZATION_ENDPOINT = "https://cloud.ouraring.com/oauth/authorize";

export async function startConnect(ctx: ManagedProviderContext) {
  if (!ctx.integrationId) {
    throw new HttpError(400, "invalid_integration_id", "Oura connect requires integrationId.");
  }
  const oauth = await ouraOAuthConfig();
  const state = await createManagedProviderOAuthState({
    providerId: metadata.providerId,
    userId: ctx.user.userId,
    integrationId: ctx.integrationId,
  });
  const url = new URL(OURA_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", oauth.clientId);
  url.searchParams.set("redirect_uri", oauth.redirectUri);
  url.searchParams.set("scope", metadata.connect.scopes.join(" "));
  url.searchParams.set("state", state);

  logInfo("oura.connect.start", {
    userId: ctx.user.userId,
    integrationId: ctx.integrationId,
    scopes: metadata.connect.scopes,
    redirectUri: oauth.redirectUri,
  });

  return {
    providerId: metadata.providerId,
    displayName: metadata.displayName,
    capability: metadata.capability,
    status: "redirect" as const,
    message: "Redirecting to Oura.",
    userId: ctx.user.userId,
    integrationId: ctx.integrationId,
    apiBaseUrl: `${getConfig().apiOrigin}${metadata.apiBasePath}`,
    scopes: metadata.connect.scopes,
    connectUrl: url.toString(),
  };
}

export async function handleCallback(ctx: Omit<ManagedProviderContext, "user">) {
  const params = ctx.event.queryStringParameters ?? {};
  const providerError = params.error;
  const state = await consumeManagedProviderOAuthState(metadata.providerId, params.state);
  const finishUrl = new URL(`/providers/${encodeURIComponent(metadata.providerId)}/connect`, getConfig().appOrigin);
  finishUrl.searchParams.set("integrationId", state.integrationId);

  if (providerError) {
    logWarn("oura.oauth.callback.provider_error", {
      userId: state.userId,
      integrationId: state.integrationId,
      error: providerError,
      errorDescription: params.error_description,
    });
    finishUrl.searchParams.set("error", providerError);
    if (params.error_description) finishUrl.searchParams.set("message", params.error_description);
    return redirect(303, finishUrl.toString());
  }
  if (!params.code) {
    throw new HttpError(400, "missing_oauth_code", "Oura OAuth callback is missing code.");
  }

  const token = await exchangeOuraCode(params.code);
  await storeOuraConnection({
    userId: state.userId,
    integrationId: state.integrationId,
    providerId: metadata.providerId,
    token,
  });

  logInfo("oura.oauth.connected", {
    userId: state.userId,
    integrationId: state.integrationId,
    providerId: metadata.providerId,
  });

  finishUrl.searchParams.set("connected", "1");
  return redirect(303, finishUrl.toString());
}
