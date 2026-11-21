/** Seed shape, not the final canonical PostgreSQL schema representation. */
export interface SchemaIdentifier {
  readonly schemaName: string;
  readonly objectName: string;
}

export interface SchemaColumn {
  readonly name: string;
  readonly databaseType: string;
  readonly nullable: boolean;
}

export interface SchemaTable {
  readonly identifier: SchemaIdentifier;
  readonly columns: readonly SchemaColumn[];
}
