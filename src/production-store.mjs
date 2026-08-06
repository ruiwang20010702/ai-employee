import { PostgresStore } from "./postgres-store.mjs";

export async function createProductionStore(config, options = {}) {
  return new PostgresStore(config, options).open();
}
