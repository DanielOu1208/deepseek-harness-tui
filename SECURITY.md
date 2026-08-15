# Security policy

## Supported versions

This project is experimental and currently supports the latest `0.1.x` release only. Security fixes are applied to the newest release rather than backported to older prerelease builds.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/DanielOu1208/deepseek-harness-tui/security/advisories/new). Do not open a public issue for a suspected vulnerability.

Include a concise description, affected version, reproduction steps, and expected impact. Remove API keys, credentials, private prompts, session logs, usernames, and local paths. Reports will be assessed privately before a fix or disclosure is discussed.

If a credential was exposed, revoke or rotate it with the provider immediately. Removing it from a Git commit does not make the credential safe again.

## Scope

Useful reports include credential disclosure, unsafe file permissions, command or argument injection, unauthorized tool execution, session-data exposure, and dependency supply-chain risks. Reports about the official DeepSeek Harness runtime should also be shared with its maintainers when the problem is outside this TUI package.
