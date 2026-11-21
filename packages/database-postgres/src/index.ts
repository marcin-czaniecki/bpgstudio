export {
  createPostgresAdapter,
  type PgClientFactory,
  type PgClientLike,
} from "./adapter";
export { mapPgError } from "./error-mapping";

export const DATABASE_KIND_POSTGRES = "postgres" as const;
