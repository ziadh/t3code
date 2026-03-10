import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN default_provider TEXT NOT NULL DEFAULT 'codex'
  `.pipe(Effect.catchTag("SqlError", () => Effect.void));

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN provider TEXT NOT NULL DEFAULT 'codex'
  `.pipe(Effect.catchTag("SqlError", () => Effect.void));

  yield* sql`
    UPDATE projection_projects
    SET default_provider = 'codex'
    WHERE default_provider IS NULL OR TRIM(default_provider) = ''
  `;

  yield* sql`
    UPDATE projection_threads
    SET provider = 'codex'
    WHERE provider IS NULL OR TRIM(provider) = ''
  `;
});
