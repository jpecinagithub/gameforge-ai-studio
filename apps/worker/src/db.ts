/**
 * Minimal database access surface. The worker talks to Postgres through this
 * narrow interface so processors stay testable without a live database.
 *
 * Rows are intentionally `unknown[]` — callers cast to their row shapes.
 * (A generic `query<T>` looks nicer but makes every test double fight
 * variance; the cast sites are few and explicit.)
 */
export interface QueryResultLike {
  rows: unknown[];
  rowCount: number;
}

export interface DbClient {
  query(text: string, params?: unknown[]): Promise<QueryResultLike>;
  release(): void;
}

export interface DbPool {
  query(text: string, params?: unknown[]): Promise<QueryResultLike>;
  connect(): Promise<DbClient>;
  end(): Promise<void>;
}
