const allowedTypes = new Set(["person", "project", "principle"]);
const allowedSensitivities = new Set(["public", "internal", "confidential"]);
const factKeyPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,4}$/u;
const allowedPersonFactKeys = new Set([
  "communication.reply_length",
  "communication.tone",
  "communication.language",
  "communication.format",
  "collaboration.role",
  "collaboration.responsibility",
  "collaboration.relationship",
  "collaboration.working_style",
  "identity.public_role",
  "identity.public_team",
]);

const credentialPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\b(?:password|passwd|pwd|token|api[_ -]?key|access[_ -]?(?:key|token)|secret|client[_ -]?secret|credential|authorization|bearer|cookie|session[_ -]?id|verification[_ -]?code|one[_ -]?time[_ -]?password|otp)\b\s*[:=]/iu,
  /\b(?:password|passwd|pwd|token|api[_ -]?key|access[_ -]?(?:key|token)|secret|client[_ -]?secret|credential|authorization|cookie|session[_ -]?id|verification[_ -]?code|one[_ -]?time[_ -]?password|otp)\b\s*(?:is|are|是|为)\s*\S+/iu,
  /\b(?:password|passwd|pwd|token|api[_ -]?key|access[_ -]?(?:key|token)|secret|client[_ -]?secret|credential|authorization|cookie|session[_ -]?id|verification[_ -]?code|one[_ -]?time[_ -]?password|otp)\b\s+[a-z0-9][a-z0-9._~+/=-]{3,}/iu,
  /\bbearer\s+[a-z0-9._~+/=-]{4,}/iu,
  /(?:(?:数据库|账号|登录)?密码|口令|令牌|秘钥|密钥|访问密钥|凭据|授权头|会话令牌|验证码|动态码)\s*[:：=]/u,
  /(?:(?:数据库|账号|登录)?密码|口令|令牌|秘钥|密钥|访问密钥|凭据|授权头|会话令牌|验证码|动态码)\s*(?:是|为)\s*\S+/u,
  /(?:(?:数据库|账号|登录)?密码|口令|令牌|秘钥|密钥|访问密钥|凭据|授权头|会话令牌|验证码|动态码)\s+[a-z0-9][a-z0-9._~+/=-]{3,}/iu,
  /\b(?:https?|postgres(?:ql)?|mysql):\/\/[^\s/:@]+:[^\s/@]+@/iu,
  /\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/u,
  /\b(?:xox[baprs]-[a-z0-9-]{10,}|glpat-[a-z0-9_-]{10,}|npm_[a-z0-9]{20,})\b/iu,
  /\b(?:sk|rk|pk)_(?:live|test)_[a-z0-9]{10,}\b/iu,
  /\b(?:AIza[a-z0-9_-]{20,}|SK[a-f0-9]{32}|SG\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,})\b/iu,
  /\beyJ[a-z0-9_-]{10,}\.eyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\b/iu,
];

const sensitivePersonPatterns = [
  /(?:身份证|护照|银行卡|信用卡|病史|诊断|抑郁|焦虑|手机号|手机号码|电话号码|电子邮箱|邮箱|生日|出生日期|住址|家庭地址|薪资|薪酬|性取向|宗教|政治倾向)/u,
  /(?:能力差|不靠谱|懒惰|情绪不稳定|不适合|人品)/u,
  /\b(?:diagnos(?:ed|is)|medical history|health condition|depression|anxiety|phone|mobile|telephone|e-?mail|home address|residential address|birthday|date of birth|passport|social security|bank account|credit card|salary|compensation|sexual orientation|religion|political affiliation)\b/iu,
  /\b(?:unreliable|lazy|incompetent|unstable|unfit|poor character)\b/iu,
  /\b1[3-9]\d{9}\b/u,
  /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,63}\b/iu,
  /(?<!\d)(?:\+?86[\s-]?)?1[3-9]\d(?:[\s-]?\d){8}(?!\d)/u,
  /(?<!\d)(?:\+?86[\s-]?)?0\d{2,3}[\s-]?\d{7,8}(?!\d)/u,
];

function containsChineseResidentId(value) {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = "10X98765432";
  const matches = String(value ?? "").toUpperCase().matchAll(/(?<!\d)(\d{17}[\dX])(?!\d)/gu);
  for (const [, identifier] of matches) {
    const year = Number(identifier.slice(6, 10));
    const month = Number(identifier.slice(10, 12));
    const day = Number(identifier.slice(12, 14));
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      year < 1900 ||
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) continue;
    const sum = weights.reduce(
      (total, weight, index) => total + Number(identifier[index]) * weight,
      0,
    );
    if (checks[sum % 11] === identifier[17]) return true;
  }
  return false;
}

function containsPaymentCardNumber(value) {
  const matches = String(value ?? "").matchAll(/(?<!\d)(\d{16,19})(?!\d)/gu);
  for (const [, number] of matches) {
    let total = 0;
    let double = false;
    for (let index = number.length - 1; index >= 0; index -= 1) {
      let digit = Number(number[index]);
      if (double) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      total += digit;
      double = !double;
    }
    if (total % 10 === 0) return true;
  }
  return false;
}

function containsSensitivePersonMaterial(value) {
  const text = String(value ?? "");
  return sensitivePersonPatterns.some((pattern) => pattern.test(text)) ||
    containsChineseResidentId(text) ||
    containsPaymentCardNumber(text);
}

function cleanText(value, maximumLength) {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/gu, " ");
  if (!text || text.length > maximumLength) return null;
  return text;
}

export function containsCredentialMaterial(value) {
  const text = String(value ?? "");
  return credentialPatterns.some((pattern) => pattern.test(text));
}

export function sanitizeDraftMemoryCandidates(value) {
  if (value == null) return { candidates: [], rejectedReasons: [] };
  if (!Array.isArray(value)) {
    return { candidates: [], rejectedReasons: ["invalid_container"] };
  }
  const candidates = [];
  const rejectedReasons = [];
  for (const raw of value.slice(0, 3)) {
    const statement = cleanText(raw?.statement, 1_000);
    const factKey = cleanText(raw?.factKey, 120);
    const projectHint = typeof raw?.projectHint === "string"
      ? raw.projectHint.trim().slice(0, 200)
      : "";
    const retentionDays = Number(raw?.retentionDays);
    const confidence = Number(raw?.confidence);
    const sourceMessageId = cleanText(raw?.sourceMessageId, 200);
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      !allowedTypes.has(raw.type) ||
      !statement ||
      !factKey ||
      !factKeyPattern.test(factKey) ||
      !allowedSensitivities.has(raw.sensitivity) ||
      !Number.isInteger(retentionDays) ||
      retentionDays < 1 ||
      retentionDays > 365 ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1 ||
      !sourceMessageId ||
      (raw.type === "person" && !allowedPersonFactKeys.has(factKey)) ||
      (raw.type === "project" && !projectHint)
    ) {
      rejectedReasons.push("invalid_shape");
      continue;
    }
    if (containsCredentialMaterial(statement)) {
      rejectedReasons.push("credential_material");
      continue;
    }
    if (
      containsSensitivePersonMaterial(statement) ||
      (raw.type === "person" && raw.sensitivity === "confidential")
    ) {
      rejectedReasons.push("sensitive_person_fact");
      continue;
    }
    candidates.push({
      type: raw.type,
      statement,
      factKey,
      sensitivity: raw.sensitivity,
      retentionDays,
      confidence,
      projectHint,
      sourceMessageId,
    });
  }
  if (value.length > 3) rejectedReasons.push("candidate_limit");
  return { candidates, rejectedReasons };
}

export function validateAutomaticMemoryProposal(input, now = new Date()) {
  if (!allowedTypes.has(input?.type)) {
    throw new Error("Unsupported automatic memory candidate type");
  }
  if (input?.sourceType !== "dingtalk_message") {
    throw new Error("Automatic memory source must be a DingTalk message");
  }
  if (typeof input.sourceVersion !== "string" || !input.sourceVersion.trim()) {
    throw new Error("Automatic memory candidate requires a source task");
  }
  if (!input?.scope?.factKey) {
    throw new Error("Automatic memory candidate requires a fact key");
  }
  if (!factKeyPattern.test(input.scope.factKey)) {
    throw new Error("Automatic memory candidate fact key is invalid");
  }
  if (
    input.type === "person" &&
    !allowedPersonFactKeys.has(input.scope.factKey)
  ) {
    throw new Error("Automatic person memory fact key is not allowed");
  }
  if (!Object.hasOwn(input ?? {}, "sensitivity")) {
    throw new Error("Automatic memory candidate requires sensitivity");
  }
  if (!input?.expiresAt) {
    throw new Error("Automatic memory candidate requires an expiry");
  }
  const expiresAt = new Date(input.expiresAt);
  const maximum = new Date(now.getTime() + 365 * 86_400_000);
  if (
    Number.isNaN(expiresAt.getTime()) ||
    expiresAt <= now ||
    expiresAt > maximum
  ) {
    throw new Error("Automatic memory candidate expiry is outside the allowed range");
  }
  if (input.supersedesId) {
    throw new Error("Automatic memory candidate cannot supersede a confirmed fact");
  }
  if (containsCredentialMaterial(input.statement)) {
    throw new Error("Automatic memory candidate contains credential material");
  }
  if (
    containsSensitivePersonMaterial(input.statement) ||
    (input.type === "person" && input.sensitivity === "confidential")
  ) {
    throw new Error("Automatic memory candidate contains a sensitive person fact");
  }
  return input;
}
