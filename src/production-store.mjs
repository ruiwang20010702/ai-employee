import { PostgresStore } from "./postgres-store.mjs";

export async function createProductionStore(config) {
  return new PostgresStore(config).open();
}
