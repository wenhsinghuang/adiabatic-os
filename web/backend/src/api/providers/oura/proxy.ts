import { notImplementedProxy } from "../shared";
import type { ManagedProviderProxyContext } from "../types";
import { metadata } from "./metadata";

export async function handleProxy(ctx: ManagedProviderProxyContext): Promise<never> {
  return notImplementedProxy(metadata, ctx);
}
