# Security Policy

## Supported versions

Security fixes are developed on `main` and, when practical, released in the newest
tagged version. The current stable release is `v1.0.0`; older releases are not
generally supported.

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Latest release | Yes |
| Older releases | No |

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability.

Use GitHub's [private vulnerability-reporting flow](https://github.com/keegandonley/Ondas/security/advisories/new)
when available. If that flow is unavailable, email [kd@keegandonley.com](mailto:kd@keegandonley.com)
with the subject line `Ondas security report`.

Include enough information to reproduce and assess the issue:

- Affected version, commit, or build configuration.
- Clear reproduction steps or a minimal proof of concept.
- Expected and observed behavior, plus likely impact.
- Whether the issue involves iCloud/CloudKit, entitlements, signing, telemetry, or
  local data handling.

Do not include chat transcripts, API keys, provisioning profiles, certificates, or
other credentials unless they are essential to demonstrate impact. Redact them first
and use a secure channel if a maintainer requests additional material.

## What to expect

The maintainer will aim to acknowledge a report within seven calendar days and provide
an update as investigation proceeds. Please allow time for a fix and coordinated
release before public disclosure. If the report affects an Apple platform service
rather than this repository, please also report it through Apple's security process.

## Scope

Reports are welcome for the app source, generated-project configuration, build and
release automation, signing and entitlement configuration, and the project's
telemetry and CloudKit integrations. Third-party services and modified downstream
forks are outside this project's direct control, but a report may still help identify
an issue in the upstream code.
