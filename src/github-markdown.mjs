export function canonicalGitHubMarkdownBody(value) {
  const body = String(value ?? "");
  if (body.endsWith("\r\n")) return body.slice(0, -2);
  if (body.endsWith("\n")) return body.slice(0, -1);
  return body;
}
