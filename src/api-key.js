import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveApiKeyPath } from "./config.js";

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
      return await loadApiKey();
    }
    throw error;
  }
}

export async function loadApiKey() {
  const filePath = resolveApiKeyPath();
  const apiKey = await readApiKey(filePath);
  if (!apiKey) {
    throw new Error(`API key not found at ${filePath}. Start jsmcp server once to create it.`);
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
