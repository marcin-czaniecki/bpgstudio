export {
  createPostgresAdapter,
  type PgClientFactory,
  type PgClientLike,
} from "./adapter";
export { mapPgError } from "./error-mapping";
export {
  loadSchemaHints,
  type SchemaHintsOutcome,
  type TableHint,
} from "./schema-hints";

export const DATABASE_KIND_POSTGRES = "postgres" as const;
