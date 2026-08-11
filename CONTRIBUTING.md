# Contributing to AI Employee

**English** · [简体中文](./CONTRIBUTING_ZH.md)

Thank you for helping improve AI Employee. This project treats workplace messaging and external actions as production systems, so authorization boundaries, failure paths, and verifiable evidence are first-class requirements.

## What you can contribute

- reproducible bug reports;
- documentation, examples, and usability improvements;
- message adapters, work adapters, and target verifiers;
- security, reliability, observability, and test improvements.

Sanitize anything related to real DingTalk accounts, production data, or internal company information. Report security issues privately according to [SECURITY.md](./SECURITY.md).

## Local development

AI Employee requires Node.js 22.5 or later:

```bash
git clone https://github.com/ruiwang20010702/ai-employee.git
cd ai-employee
npm ci
npm run check
```

`npm run check` must not read real DingTalk conversations or connect to a production database. For PostgreSQL integration coverage, run the isolated test environment:

```bash
npm run check:full
```

## Making a change

1. Open an issue describing the problem, expected behavior, and capability boundary. Small documentation fixes may go directly to a pull request.
2. Keep each pull request focused and avoid unrelated refactors.
3. Preserve default-deny behavior. New message sources, execution capabilities, people, or external writes must be explicitly configured.
4. Cover the allowed path, denied path, timeout or failure path, idempotency behavior, and target-system read-back.
5. Never let model text authorize a tool, and never treat a tool's success response as proof of the final external state.
6. Update the affected authoritative documentation and explain migration, rollback, and compatibility boundaries.

Before submitting:

```bash
npm run check
npm audit --audit-level=high
git diff --check
```

Run `npm run check:full` when the change affects PostgreSQL, migrations, concurrent state, or SQLite/PostgreSQL parity.

## Pull request checklist

- Describe the user problem and final behavior, not only the edited files.
- List the commands you actually ran and their results.
- Explain changes to permissions, data access, external effects, migrations, and rollback behavior.
- Include sanitized screenshots for UI or documentation changes when useful.
- Do not commit `.runtime/`, databases, logs, backups, tokens, cookies, real messages, user identifiers, or machine-specific absolute paths.

Maintainers prioritize correctness, security, failure recovery, readability, and performance. A merged change is not automatically deployed or enabled in production.

## License

By contributing, you agree that your contribution is provided under the project's [MIT License](./LICENSE).
