/**
 * Runtime configuration resolved from environment variables, with defaults
 * from `constants.ts`. Import `config` anywhere you need paths or settings.
 */

import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import {
  BALOTO_DATASET_FILE,
  CAPTURES_FILE,
  DEFAULT_API_PORT,
  DEFAULT_HOME_DIRNAME,
  DEFAULT_PORTAL_URL,
  ENDPOINTS_FILE,
  SESSION_FILE,
  STORAGE_STATE_FILE,
} from "./constants.ts";

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : join(process.cwd(), p);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

const home = expandHome(
  process.env.BANCOLOMBIA_HOME ?? join(homedir(), DEFAULT_HOME_DIRNAME),
);

export const config = {
  /** Directory where the session and browser storage state live. */
  home,
  sessionPath: join(home, SESSION_FILE),
  storageStatePath: join(home, STORAGE_STATE_FILE),
  endpointsPath: join(home, ENDPOINTS_FILE),
  capturesPath: join(home, CAPTURES_FILE),
  balotoDatasetPath: join(home, BALOTO_DATASET_FILE),

  /** Local REST API port for `bancolombia server`. */
  apiPort: envInt("BANCOLOMBIA_API_PORT", DEFAULT_API_PORT),

  /** Personal-banking portal automated by `bancolombia login`. */
  portalUrl: process.env.BANCOLOMBIA_PORTAL_URL ?? DEFAULT_PORTAL_URL,

  /** Optional default headless proxy URL for `bancolombia connect`. */
  apiUrl: process.env.BANCOLOMBIA_API_URL ?? "",

  /** Show the browser window during login. */
  headful: envBool("BANCOLOMBIA_HEADFUL", false),
} as const;

export type Config = typeof config;
