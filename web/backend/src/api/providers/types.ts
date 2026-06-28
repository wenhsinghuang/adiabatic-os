import type { APIGatewayProxyEventV2 } from "aws-lambda";

import type { LamarckUser } from "../identity";

export interface ManagedProviderMetadata {
  providerId: string;
  displayName: string;
  capability: string;
  apiBasePath: string;
  connect: {
    type: "oauth2";
    enabled: boolean;
    scopes: string[];
  };
}

export interface ManagedProviderConnectStart {
  providerId: string;
  displayName: string;
  capability: string;
  status: "not_implemented";
  message: string;
  userId: string;
  apiBaseUrl: string;
  scopes: string[];
}

export interface ManagedProviderContext {
  user: LamarckUser;
  event: APIGatewayProxyEventV2;
}

export interface ManagedProviderModule {
  metadata: ManagedProviderMetadata;
  connect: {
    start(ctx: ManagedProviderContext): Promise<ManagedProviderConnectStart>;
    callback(ctx: Omit<ManagedProviderContext, "user">): Promise<unknown>;
  };
  proxy(ctx: ManagedProviderContext): Promise<unknown>;
}
