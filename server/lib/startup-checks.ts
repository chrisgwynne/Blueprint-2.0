/**
 * Pure, unit-testable startup safety checks. Kept separate from index.ts
 * so they can be tested directly without spawning the full server process
 * (which calls process.exit() on failure by design).
 */

/**
 * True if the instance would start in production with a known-default or
 * unset admin password (F-18). The .env.example placeholder is
 * 'changeme' — refuse to run with it, or with nothing set at all.
 */
export function isProductionAdminPasswordUnsafe(nodeEnv: string | undefined, adminPassword: string | undefined): boolean {
  if (nodeEnv !== 'production') return false;
  return !adminPassword || adminPassword === 'changeme';
}
