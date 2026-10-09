import type { IAgentRuntime } from "@elizaos/core";
import { normalizePrivateKey, VibeKastClient } from "./client";
import { SETTINGS } from "./constants";

const setting = (runtime: IAgentRuntime, key: string): string | undefined => {
  const value = runtime.getSetting(key);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
};

export function hasWallet(runtime: IAgentRuntime): boolean {
  return Boolean(setting(runtime, SETTINGS.privateKey) ?? setting(runtime, SETTINGS.fallbackPrivateKey));
}

const clients = new WeakMap<IAgentRuntime, VibeKastClient>();

/** One client per agent, built from its settings. The key stays inside the client's signer. */
export function getClient(runtime: IAgentRuntime): VibeKastClient {
  const cached = clients.get(runtime);
  if (cached) return cached;
  const client = new VibeKastClient({
    apiUrl: setting(runtime, SETTINGS.apiUrl),
    rpcUrl: setting(runtime, SETTINGS.rpcUrl),
    privateKey: normalizePrivateKey(
      setting(runtime, SETTINGS.privateKey) ?? setting(runtime, SETTINGS.fallbackPrivateKey),
    ),
  });
  clients.set(runtime, client);
  return client;
}

/** For tests: use a prepared client instead of one built from settings. */
export function setClient(runtime: IAgentRuntime, client: VibeKastClient): void {
  clients.set(runtime, client);
}
