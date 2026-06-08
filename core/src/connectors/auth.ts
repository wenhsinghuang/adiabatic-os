import type { ConnectorAuthHandle, ConnectorAuthSpec, ConnectorIntegration } from "./types";

export interface ConnectorSecretStore {
  get(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

export class MemoryConnectorSecretStore implements ConnectorSecretStore {
  private values = new Map<string, string>();

  async get(ref: string): Promise<string | undefined> {
    return this.values.get(ref);
  }

  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
  }

  async delete(ref: string): Promise<void> {
    this.values.delete(ref);
  }
}

export class ConnectorAuthManager {
  constructor(private secrets: ConnectorSecretStore = new MemoryConnectorSecretStore()) {}

  async setToken(authRef: string, token: string): Promise<void> {
    await this.secrets.set(authRef, token);
  }

  async deleteToken(authRef: string): Promise<void> {
    await this.secrets.delete(authRef);
  }

  async hasToken(authRef: string): Promise<boolean> {
    return Boolean(await this.secrets.get(authRef));
  }

  createHandle(auth: ConnectorAuthSpec, integration: ConnectorIntegration): ConnectorAuthHandle {
    if (auth.type === "none") {
      return { type: "none" };
    }

    const authRef = integration.authRef;
    if (!authRef) {
      throw new Error(`Connector integration ${integration.id} requires auth_ref`);
    }

    return {
      type: auth.type,
      getToken: async () => {
        const token = await this.secrets.get(authRef);
        if (!token) {
          throw new Error(`Connector integration ${integration.id} is missing credentials`);
        }
        return token;
      },
    };
  }
}
