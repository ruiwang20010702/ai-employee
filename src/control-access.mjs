const readOnlyCommands = new Set(["review-report"]);

export function controlStoreOptions(command) {
  return { readOnly: readOnlyCommands.has(String(command ?? "")) };
}
