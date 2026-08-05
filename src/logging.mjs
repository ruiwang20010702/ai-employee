export function safeErrorCode(error) {
  const text = String(error?.message ?? error ?? "").toLowerCase();
  if (error?.code && /^CODEX_[A-Z_]+$/.test(String(error.code))) {
    return String(error.code).toLowerCase();
  }
  if (/timeout|timed out|i\/o timeout|request_timeout/.test(text)) {
    return "request_timeout";
  }
  if (/network_error|unavailable|connection refused|econn/.test(text)) {
    return "network_unavailable";
  }
  if (/forbidden|permission|denied/.test(text)) return "permission_denied";
  if (/peeruid is required/.test(text)) return "invalid_peer_identity";
  if (/pagination cursor repeated/.test(text)) return "pagination_repeated";
  if (/pagination exceeded/.test(text)) return "pagination_exceeded";
  return "operation_failed";
}
