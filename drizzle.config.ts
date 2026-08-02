import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dbCredentials: {
    // Only needed for `drizzle-kit migrate`; `generate` works without a database.
    url: process.env.DATABASE_URL ?? "",
  },
});
