import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { resolveApiKeyPath } from "./config.js";

export const API_KEY_ENV_VAR = "JSMCP_API_KEY";

export async function loadOrCreateApiKey() {
  const filePath = resolveApiKeyPath();
  const existing = await readApiKey(filePath);
  if (existing) {
    return existing;
  }

  const apiKey = randomBytes(32).toString("base64url");
  await mkdir(path.dirname(filePath), { recursive: true });

  try {
    await writeFile(filePath, `${apiKey}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return apiKey;
  } catch (error) {
    if (error && error.code === "EEXIST") {
      const created = await readApiKey(filePath);
      if (created) {
        return created;
      }
      return await loadOrCreateApiKey();
    }
    throw error;
  }
}

export async function loadApiKey(apiKeyOverride) {
  if (apiKeyOverride !== undefined) {
    const apiKey = normalizeApiKey(apiKeyOverride);
    if (!apiKey) {
      throw new Error("API key must not be empty.");
    }
    return apiKey;
  }

  const envApiKey = normalizeApiKey(process.env[API_KEY_ENV_VAR]);
  if (envApiKey) {
    return envApiKey;
  }

  const filePath = resolveApiKeyPath();
  const apiKey = await readApiKey(filePath);
  if (!apiKey) {
    throw new Error(`API key not found at ${filePath}. Start jsmcp server once to create it, set ${API_KEY_ENV_VAR}, or pass --api-key to jsmcp client.`);
  }
  return apiKey;
}

export function apiKeysEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }

  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeApiKey(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value).trim() || undefined;
}

async function readApiKey(filePath) {
  try {
    const value = (await readFile(filePath, "utf8")).trim();
    return value || undefined;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
