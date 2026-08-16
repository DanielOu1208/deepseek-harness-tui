# Contributing

Thanks for helping improve the DeepSeek Harness TUI. Small, focused pull requests are easiest to review and safest to release.

## Before opening a change

1. Open an issue for a substantial behavior or architecture change so the approach can be agreed on first.
2. Fork the repository and branch from `main`.
3. Install the exact locked dependencies with `npm ci`.
4. Keep the official `@deepseek-ai/*` packages on one compatible Harness release line. The project is currently pinned to `0.1.0-rc.6` because those packages share runtime contracts.

Do not commit API keys, credentials, `.env` files, private prompts, session logs, generated exports, or machine-specific paths. If a secret is committed, rotate it immediately and report the exposure privately; deleting the commit is not sufficient.

## Validation

Run the same core checks as CI:

```sh
npm ci
npm run check
npm run pack:check
```

`npm run check` runs the tests and regenerates `lib/`. Commit the resulting `lib/` changes whenever TypeScript source changes because published GitHub installs execute those files. Before submitting, confirm that `git diff --exit-code -- lib` succeeds after a clean build.

For terminal interaction changes, describe the operating systems and terminal applications you tested. Automated tests do not count as physical terminal testing. A provider-backed model request is optional unless the behavior specifically depends on a live provider; never put a credential in a test fixture or pull request.

## Pull requests

- Explain the user-visible outcome and any compatibility impact.
- Add regression tests for bug fixes and tests for new behavior.
- Update the README or parity matrix when commands or capabilities change.
- Avoid unrelated formatting or refactors in the same pull request.
- Reply to review comments and resolve every review conversation before merge.

All pull requests must pass the required CI checks. Dependency changes are also scanned for known high-severity vulnerabilities, and the default branch is analyzed with CodeQL.

## Security reports

Do not discuss suspected vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md) to report them privately.
