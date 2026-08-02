import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema.js";

/**
 * Driver-agnostic database handle. Both the node-postgres client used in
 * production and the PGlite client used in tests satisfy this type.
 */
export type DbClient = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbConnection {
  db: DbClient;
  close: () => Promise<void>;
}

export function createDbConnection(
  databaseUrl: string,
  onIdleClientError: (error: Error) => void,
): DbConnection {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  // Without a listener, an error on an idle pooled connection (e.g. a
  // PostgreSQL restart) is an unhandled 'error' event and kills Node.
  // The pool already discards the broken client; reporting is enough.
  pool.on("error", onIdleClientError);
  const db = drizzle(pool, { schema });

  return {
    db,
    close: () => pool.end(),
  };
}
