import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import type { DbClient } from "../db/client.js";
import * as schema from "../db/schema.js";

const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

export interface TestDb {
  db: DbClient;
  close: () => Promise<void>;
}

/**
 * In-memory PostgreSQL (PGlite) database with the real SQL migrations
 * applied, so repository tests exercise the exact production schema.
 */
export async function createTestDb(): Promise<TestDb> {
  const pglite = new PGlite();
  const db = drizzle(pglite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  return {
    db: db as unknown as DbClient,
    close: () => pglite.close(),
  };
}
