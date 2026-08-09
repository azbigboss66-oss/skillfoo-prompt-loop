import { createMockProvider } from "./mockProvider.js";
import { createOpenAICompatibleProvider } from "./openaiCompatibleProvider.js";
import type { ModelProvider } from "./types.js";

export type RuntimeProviderConfig = {
  type: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  model?: string;
};

export class ProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigurationError";
  }
}

export function validateProviderConfig(provider: RuntimeProviderConfig): void {
  if (!provider?.type) {
    throw new ProviderConfigurationError("Provider type is required. Use mock or openai-compatible.");
  }

  if (provider.type === "mock") return;

  if (provider.type !== "openai-compatible") {
    throw new ProviderConfigurationError(
      `Unsupported provider type: ${provider.type}. This release supports only mock and openai-compatible.`,
    );
  }

  for (const field of ["baseUrl", "apiKeyEnv", "model"] as const) {
    if (!provider[field]?.trim()) {
      throw new ProviderConfigurationError(
        `openai-compatible provider requires ${field}.`,
      );
    }
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(provider.baseUrl!);
  } catch {
    throw new ProviderConfigurationError("Base URL must be a valid absolute URL.");
  }

  const isLocalHttp = parsedUrl.protocol === "http:" &&
    (parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1");
  if (parsedUrl.protocol !== "https:" && !isLocalHttp) {
    throw new ProviderConfigurationError("Base URL must use HTTPS, except localhost for local development.");
  }

  if (/\/chat\/completions\/?$/i.test(parsedUrl.pathname)) {
    throw new ProviderConfigurationError(
      "Base URL must stop before /chat/completions, for example https://api.example.com/v1.",
    );
  }

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(provider.apiKeyEnv!)) {
    throw new ProviderConfigurationError("apiKeyEnv must be an environment variable name, not an API key value.");
  }
}

export function createProviderFromConfig(provider: RuntimeProviderConfig): ModelProvider {
  validateProviderConfig(provider);

  if (provider.type === "mock") return createMockProvider();

  return createOpenAICompatibleProvider({
    baseUrl: provider.baseUrl!,
    apiKeyEnv: provider.apiKeyEnv!,
    model: provider.model!,
  });
}
