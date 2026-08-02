interface ErrorWithCode {
  code?: unknown;
}

function hasPgCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as ErrorWithCode).code === code
  );
}

/**
 * Detect a PostgreSQL unique-constraint violation (SQLSTATE 23505),
 * whether the driver error surfaces directly or wrapped as `cause`.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (hasPgCode(error, "23505")) return true;
  const cause = error instanceof Error ? error.cause : undefined;
  return hasPgCode(cause, "23505");
}
