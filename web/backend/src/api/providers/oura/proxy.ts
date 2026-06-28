import { notImplementedProxy } from "../shared";
import type { ManagedProviderContext } from "../types";
import { metadata } from "./metadata";

export async function handleProxy(ctx: ManagedProviderContext): Promise<never> {
  return notImplementedProxy(metadata, ctx);
}
