import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderConfigurationError,
  createProviderFromConfig,
  validateProviderConfig,
} from "../providers/createProvider.js";

const compatibleProvider = {
  type: "openai-compatible",
  baseUrl: "https://api.example.test/v1",
  apiKeyEnv: "SKILLFOO_API_KEY",
  model: "example-chat",
};

test("validateProviderConfig accepts a complete OpenAI-compatible config", () => {
  assert.doesNotThrow(() => validateProviderConfig(compatibleProvider));
});

test("validateProviderConfig rejects an unsupported provider instead of falling back", () => {
  assert.throws(
    () => validateProviderConfig({ type: "anthropic", model: "claude" }),
    ProviderConfigurationError,
  );
});

test("validateProviderConfig requires baseUrl, apiKeyEnv, and model for real APIs", () => {
  for (const provider of [
    { type: "openai-compatible", apiKeyEnv: "KEY", model: "m" },
    { type: "openai-compatible", baseUrl: "https://api.example.test/v1", model: "m" },
    { type: "openai-compatible", baseUrl: "https://api.example.test/v1", apiKeyEnv: "KEY" },
  ]) {
    assert.throws(() => validateProviderConfig(provider), ProviderConfigurationError);
  }
});

test("validateProviderConfig rejects a full Chat Completions endpoint as baseUrl", () => {
  assert.throws(
    () => validateProviderConfig({ ...compatibleProvider, baseUrl: "https://api.example.test/v1/chat/completions" }),
    /Base URL/,
  );
});

test("createProviderFromConfig only creates mock when mock is explicitly requested", () => {
  assert.equal(createProviderFromConfig({ type: "mock" }).name, "mock");
  assert.throws(
    () => createProviderFromConfig({ type: "unknown-provider" }),
    ProviderConfigurationError,
  );
});
