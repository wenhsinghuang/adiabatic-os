import type { ManagedProviderMetadata } from "../types";

export const metadata = {
  providerId: "oura",
  displayName: "Oura",
  capability: "Health signals",
  apiBasePath: "/providers/oura",
  connect: {
    type: "oauth2",
    enabled: false,
    scopes: [
      "daily",
      "heartrate",
      "tag",
      "workout",
      "session",
      "spo2",
      "ring_configuration",
      "stress",
      "heart_health",
    ],
  },
} satisfies ManagedProviderMetadata;
