#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { auth } from "@modelcontextprotocol/sdk/client/auth.js";

import { AuthStateStore } from "../src/auth-store.js";
import { createRemoteAuthProvider } from "../src/oauth-provider.js";

const serverUrl = "https://mcp.example.com/v2/mcp";
const issuer = "https://auth.example.com";
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  registration_endpoint: `${issuer}/register`,
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
};
const oldState = {
  discoveryState: {
    authorizationServerUrl: "https://old.example.com/",
    authorizationServerMetadata: {
      ...metadata,
      issuer: "https://old.example.com/",
      token_endpoint: "https://old.example.com/token",
    },
    // Reproduce the mixed v2 resource / v1 issuer state seen after migration.
    resourceMetadata: { resource: serverUrl, authorization_servers: [issuer] },
  },
  clientInformation: { client_id: "old-client" },
  codeVerifier: "old-verifier",
  tokens: { access_token: "old-token", refresh_token: "old-refresh", token_type: "Bearer" },
};
const newTokens = { access_token: "new-token", refresh_token: "new-refresh", token_type: "Bearer" };

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jsmcp-oauth-provider-"));

try {
  await testInteractiveAuth("success");
  await testInteractiveAuth("cancel");
  await testInteractiveAuth("token-error");
  await testInteractiveAuth("invalid-token-response");
  await testInteractiveAuth("fixed-client");
  await testStartupProvider();
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function testInteractiveAuth(outcome) {
  const filePath = path.join(tempRoot, `${outcome}.json`);
  const original = `${JSON.stringify({ version: 1, servers: { docs: oldState, other: { marker: "unchanged" } } }, null, 2)}\n`;
  await writeFile(filePath, original);

  const requests = [];
  let authorizationUrl;
  const provider = createRemoteAuthProvider("docs", {
    type: "remote",
    url: serverUrl,
    oauth: outcome === "fixed-client" ? { clientId: "fixed-client", clientSecret: "fixed-secret" } : {},
  }, new AuthStateStore(filePath), {
    mode: "interactive",
    onRedirect: async (url) => { authorizationUrl = url; },
  });

  const fetchFn = async (url, init) => {
    const target = String(url);
    requests.push(target);
    if (target === "https://mcp.example.com/.well-known/oauth-protected-resource/v2/mcp") {
      return Response.json({ resource: serverUrl, authorization_servers: [issuer], scopes_supported: ["docs.read"] });
    }
    if (target === `${issuer}/.well-known/oauth-authorization-server`) {
      return Response.json(metadata);
    }
    if (target === metadata.registration_endpoint) {
      return Response.json({ ...JSON.parse(init.body), client_id: "new-client" });
    }
    if (target === metadata.token_endpoint) {
      const params = new URLSearchParams(init.body);
      assert.equal(params.get("grant_type"), "authorization_code");
      assert.equal(params.get("code"), "accepted-code");
      assert.equal(params.get("code_verifier"), await provider.codeVerifier());
      assert.equal(params.get("resource"), serverUrl);
      assert.equal(await readFile(filePath, "utf8"), beforeExchange);
      if (outcome === "token-error") {
        return Response.json({ error: "invalid_grant", error_description: "Code rejected" }, { status: 400 });
      }
      if (outcome === "invalid-token-response") {
        return Response.json({ token_type: "Bearer" });
      }
      return Response.json(newTokens);
    }
    assert.fail(`Unexpected OAuth request: ${target}`);
  };

  // Starting a new login must not read the old registration, tokens or discovery.
  assert.equal(await provider.tokens(), undefined);
  assert.equal(await provider.discoveryState(), undefined);
  assert.equal(await auth(provider, { serverUrl, fetchFn }), "REDIRECT");
  assert.equal(authorizationUrl.origin, issuer);
  assert.equal(authorizationUrl.searchParams.get("client_id"), outcome === "fixed-client" ? "fixed-client" : "new-client");
  assert.equal(authorizationUrl.searchParams.get("resource"), serverUrl);
  assert.equal(await readFile(filePath, "utf8"), original);
  assert.equal(requests.includes(metadata.registration_endpoint), outcome !== "fixed-client");

  if (outcome === "cancel") {
    // Abandon the pending flow: even discovery, DCR and PKCE have made no writes.
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")).servers.docs, oldState);
    return;
  }

  // Another server may authenticate while this user is still in the browser.
  const otherTokens = { access_token: "other-new-token", token_type: "Bearer" };
  await new AuthStateStore(filePath).setServerState("other", { tokens: otherTokens });
  const beforeExchange = await readFile(filePath, "utf8");

  if (outcome === "token-error" || outcome === "invalid-token-response") {
    await assert.rejects(auth(provider, { serverUrl, fetchFn, authorizationCode: "accepted-code" }));
    assert.equal(await readFile(filePath, "utf8"), beforeExchange);
    return;
  }

  assert.equal(await auth(provider, { serverUrl, fetchFn, authorizationCode: "accepted-code" }), "AUTHORIZED");
  const saved = JSON.parse(await readFile(filePath, "utf8"));
  assert.deepEqual(saved.servers.docs.tokens, newTokens);
  assert.equal(saved.servers.docs.discoveryState.authorizationServerUrl, issuer);
  assert.equal(saved.servers.docs.discoveryState.authorizationServerMetadata.token_endpoint, metadata.token_endpoint);
  assert.notEqual(saved.servers.docs.codeVerifier, oldState.codeVerifier);
  if (outcome === "fixed-client") {
    assert.equal(saved.servers.docs.clientInformation, undefined);
  } else {
    assert.equal(saved.servers.docs.clientInformation.client_id, "new-client");
  }
  assert.deepEqual(saved.servers.other, { tokens: otherTokens });
}

async function testStartupProvider() {
  const filePath = path.join(tempRoot, "startup.json");
  const store = new AuthStateStore(filePath);
  await store.setServerState("docs", oldState);
  const provider = createRemoteAuthProvider("docs", { type: "remote", url: serverUrl, oauth: {} }, store, { mode: "startup" });

  // Daemon token refresh continues to use and persist existing credentials.
  assert.deepEqual(await provider.tokens(), oldState.tokens);
  assert.deepEqual(await provider.clientInformation(), oldState.clientInformation);
  assert.deepEqual(await provider.discoveryState(), oldState.discoveryState);
  await provider.saveTokens(newTokens);
  assert.deepEqual((await new AuthStateStore(filePath).getServerState("docs")).tokens, newTokens);
  await assert.rejects(provider.redirectToAuthorization(new URL(`${issuer}/authorize`)), /jsmcp auth docs/);
}
