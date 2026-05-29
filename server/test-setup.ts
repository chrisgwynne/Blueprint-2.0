/**
 * Test preload (configured in bunfig.toml). Runs before any test file is
 * imported. Forces an ephemeral in-memory database so that any module which
 * transitively imports the DB layer (db.ts reads DATABASE_PATH at load time)
 * can never read or mutate the developer's real ./data/blueprint.db during a
 * test run. Unit tests should still inject their dependencies; this is the
 * belt-and-braces safety net.
 */
process.env.DATABASE_PATH ||= ':memory:';
