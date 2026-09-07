// Shared Vitest setup: load the repo-root .env.local (gitignored) so integration
// tests that opt in via env vars can run locally. Never prints values.
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const candidates = [
  resolve(process.cwd(), "../../.env.local"),
  resolve(process.cwd(), ".env.local"),
];
for (const file of candidates) {
  if (existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch {
      // ignore malformed env files in tests
    }
    break;
  }
}
