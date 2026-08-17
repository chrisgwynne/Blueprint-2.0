/**
 * Test-only helper process for db-path-resolution.integration.test.ts.
 *
 * Imports the real db.ts (with its real module-load side effects — opening
 * bun:sqlite, running startup migrations) exactly as a standalone script
 * would, and prints the DB module's actually-resolved DB_PATH so the
 * integration test can compare it across two different invocation
 * directories (regression for issue #41).
 */
import { DB_PATH } from './db.js';

console.log(`DB_PATH=${DB_PATH}`);
