# Security Policy

[中文版安全说明](./docs/指南/安全说明.md)

Foursday can process workplace messages and execute approved external actions. Please report security issues privately and avoid exposing real users or business data.

## Reporting a vulnerability

Use the repository's **GitHub Security Advisory** to send a private report. Do not open a public issue for vulnerabilities that involve credentials, authorization bypasses, message content, personal information, remote execution, or production deployment.

Include, when possible:

- affected version or full commit SHA;
- impact and preconditions;
- minimal reproduction using synthetic data;
- whether external side effects occurred;
- a suggested mitigation, if known.

Never include production secrets, real DingTalk messages, user identifiers, cookies, database dumps, Keychain values, or internal company documents.

## Supported versions

Security fixes are developed on the latest `main` revision. Production installations should pin a reviewed full commit SHA; mutable branch references are not a supported deployment boundary.

## Security boundaries

- Sending and work-plan execution are disabled independently and are off by default.
- Chat content and model output cannot grant new capabilities.
- High-risk plans require approval bound to the complete plan and authorization snapshot.
- External effects require idempotency records and target-system read-back.
- Unknown external outcomes fail closed and are not automatically retried.
- Production secrets must be injected at runtime and must not be committed to the repository.

For the complete Chinese threat model, secret-handling rules, and operational controls, see [安全说明.md](./docs/指南/安全说明.md).
