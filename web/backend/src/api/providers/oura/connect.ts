import { notImplementedCallback, notImplementedConnectStart } from "../shared";
import type { ManagedProviderContext } from "../types";
import { metadata } from "./metadata";

export async function startConnect(ctx: ManagedProviderContext): Promise<never> {
  return notImplementedConnectStart(metadata, ctx);
}

export async function handleCallback(): Promise<never> {
  return notImplementedCallback(metadata);
}
