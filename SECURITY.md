# Security

The CLI has the authority of the local user. Run it only through trusted local callers or authenticated SSH. It opens no network listener and never auto-approves agent actions. Desktop permissions remain authoritative.

Private IPC is version-dependent. Unexpected responses and uncertain dispatch fail without automatic mutation retries. Socket and parent directory ownership and write permissions are checked before connecting. JSON frames are size-bounded. Thread records contain task text and use private filesystem permissions.

Use dedicated threads. Manual turns in launcher-managed threads can make ambiguous-submission reconciliation unsafe. Keep your desktop and Node runtime updated and review agent actions in the desktop UI.

Report vulnerabilities privately through GitHub private vulnerability reporting. Do not include credentials, transcripts, or personal data in public issues.

CI checks lint, complexity (maximum 15), formatting, types, tests, package installation on macOS and Linux, dependency vulnerabilities (moderate and above), npm registry signatures, CodeQL security-extended analysis, and dependency changes in PRs. Weekly scans and Dependabot cover later advisories. These checks do not establish that the private desktop protocol is secure or compatible with every app version.
