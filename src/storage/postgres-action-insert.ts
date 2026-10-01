import {Effect} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";

import {
  type ActionInsert,
  actionInsertColumns,
  positionalActionValues,
} from "./action-insert.js";

const columnList = `installation_id, id, ${actionInsertColumns.join(", ")}`;
const placeholders = actionInsertColumns.map((_, index) => `$${index + 3}`).join(", ");

/** Insert one activity-log row inside the caller's Postgres transaction. */
export function insertPostgresAction(
  installationId: string,
  insert: ActionInsert,
  options: {readonly once?: boolean} = {},
): Effect.Effect<void, unknown, SqlClient> {
  const [actionId, ...values] = positionalActionValues(insert);
  return Effect.gen(function*() {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      `INSERT INTO actions (${columnList})
       VALUES ($1, COALESCE($2::text, gen_random_uuid()::text), ${placeholders})
       ${options.once === true ? "ON CONFLICT DO NOTHING" : ""}`,
      [installationId, actionId ?? null, ...values],
    );
  });
}
