# codex-desktop-runner

A small macOS CLI that runs tasks in the **existing Codex desktop app**, preserving the desktop agent's tools, including browser access. Invoke it locally or over SSH/Tailscale. No network listener, separate agent harness, or Remote relay enrollment.

Experimental: uses private desktop IPC. Tested protocol target is start-turn v2. Desktop updates can require adapter changes. `doctor` checks connectivity, not browser capability or every message schema.

## Install

Requires macOS, Node.js 24+, and a signed-in, running Codex desktop app. Google Chrome must be available for Chrome browser tasks. First use of a workspace may require accepting its desktop trust prompt.

```sh
npm ci
npm run check
npm install -g .
codex-desktop-runner doctor
```

The default app path is `/Applications/ChatGPT.app`. Override `CDR_APP` for another bundle name.

## Run

```sh
codex-desktop-runner start \
  --cwd "$HOME/projects/my-project" \
  --title 'Research task' \
  --prompt-file mission.txt \
  --request-id research-job-123

codex-desktop-runner status RUN_ID
codex-desktop-runner wait RUN_ID --timeout 900
codex-desktop-runner result RUN_ID
codex-desktop-runner cancel RUN_ID
codex-desktop-runner list
```

All operational commands return JSON. `--json` is accepted for explicit callers. `--prompt-file -` reads stdin, which keeps the prompt out of command-line arguments:

```sh
ssh mini 'PATH=/opt/homebrew/bin:$PATH codex-desktop-runner start --cwd ~/projects/deal-tool --title sourcing --request-id sourcing-123 --prompt-file -' < mission.txt
```

Pass `--model gpt-5.6-luna --effort low` to select execution settings for one run.
Omitted settings inherit runtime defaults. Availability depends on the signed-in account and
runtime; unsupported combinations fail through the runtime rather than falling back locally.
The settings apply to both the bootstrap turn and desktop handoff. Run JSON includes requested
`execution` settings and, once observed in the matching turn's typed metadata, `actualExecution`.
Changing settings with an existing request ID is rejected. This does not change app defaults.

Once `start` returns a turn ID, the desktop owns execution. SSH can disconnect and later CLI calls can retrieve results. No launcher daemon is required. The bootstrap itself takes a short model turn, so `start` is not instantaneous.

Exit codes: 0 for successful operations, 1 for command errors or submission failure/uncertainty, 2 for wait timeout or an unfinished result. A wait timeout never cancels the agent. Execution completion does not validate the truth or completeness of an agent's answer.

## Reliability model

Each caller request ID reserves one immutable input identity, mapped to a Codex thread and turn. Repeating it returns that run, never submits a second turn. Reusing it with different input fails. Reservation uses atomic filesystem linking; record updates use atomic rename and private permissions.

The launcher creates a read-only, approval-on-request bootstrap thread, names it, persists a harmless turn, releases its writer, and opens the desktop deep link. It discovers the exact desktop owner and sends the complete v2 payload with desktop permission defaults. It never kills the app-owned runtime or changes Codex configuration.

Submission intent is persisted **before** IPC dispatch. If acknowledgement is lost, the run becomes `unknown`; transcript observation can recover its turn ID. It is never automatically resubmitted. If the launcher dies before dispatch, the record may remain `preparing` or `submitting`; inspect that thread before starting a replacement under a new request ID.

Threads created here should remain dedicated to their run. Do not manually add turns during uncertain submission recovery. This release does not coordinate multiple browser tasks or enforce a global concurrency limit. Run browser missions sequentially.

`status`, `wait`, and `result` inspect only the matching thread transcript, exclude the bootstrap and later turns, and return the latest assistant text, final state, and tool counts. Waiting for approval can still appear as `running`; respond in the desktop app. There is no automatic approval handling. A desktop crash may leave an apparently running transcript; this release does not infer failure from inactivity.

## Configuration

| Variable     | Purpose                                                    |
| ------------ | ---------------------------------------------------------- |
| `CDR_HOME`   | Run records, default `~/.local/state/codex-desktop-runner` |
| `CODEX_HOME` | Codex state, default `~/.codex`                            |
| `CDR_APP`    | Desktop app bundle                                         |
| `CDR_CODEX`  | Bundled Codex executable override                          |
| `CDR_SOCKET` | Desktop IPC socket override                                |

Prompts and results stay in local private run records and Codex transcripts. Avoid committing them. SSH authentication and network routing remain the caller's responsibility. Keep the Mac's user session and desktop app available.

## Research references

This implementation was written for this project, using these projects as protocol and lifecycle references:

- [Codex IPC Tool](https://gist.github.com/InfinityMod/ecc1f441f7447824ff114b8a41debec2): command surface, framing, and older protocol versions.
- [codex-web IPC client](https://github.com/i-am-BT/codex-web/blob/main/desktop-ipc-client.mjs): owner targeting, timeouts, and lifecycle operations.
- [codex-thread.nvim](https://github.com/srctl/codex-thread.nvim): distinction between socket delivery and confirmed execution; large broadcast handling.
- [NightBloodRemote](https://github.com/jonathanroomer/NightBloodRemote): endpoint ownership validation and desktop attachment.
- [Syncodex](https://github.com/taolin7406/syncodex-public): existing desktop execution versus a competing app-server writer.
- [codex-process-jobs](https://github.com/joelfarthing/codex-process-jobs): uncertain acceptance must not trigger a second submission.

The browser sourcing PoC established the current payload shape: `turnStart.request`, `turnStart.context`, and `text_elements: []`. Older examples use a different shape. No compatibility fallback silently retries a mutating request.

## Development

TypeScript, Node standard library only at runtime. `npm run check` checks types and tests fragmented framing, endpoint interaction, disconnects, concurrent request deduplication, renderer context fields, and transcript reconciliation. `npm run build` emits the global CLI.

CI enforces a cyclomatic complexity maximum of 15 with no baseline exemptions, zero lint warnings, formatting, strict types, tests, and installation of the packed CLI on macOS and Linux. Security gates include dependency auditing, registry signatures, CodeQL, PR dependency review, and weekly scans. See [SECURITY.md](SECURITY.md).

## Structured reporting

`start --job-file FILE` (or `-` for stdin) accepts `{ "prompt": "...", "contract": {...} }`.
The immutable contract has `version: 1` and `progress`, `record`, and `result` schemas.
The runner automatically appends the run ID, exact local command paths and state directory,
contract, and reporting instructions to the agent's mission. No MCP server is needed.

The agent invokes these commands locally, writing JSON to a private temporary file:

```sh
codex-desktop-runner report RUN_ID --update-id phase-1 --json-file progress.json
codex-desktop-runner append-records RUN_ID --update-id batch-1 --json-file records.json
codex-desktop-runner finish RUN_ID --update-id final --json-file result.json
```

`append-records` accepts an array. Each record requires a stable string `id` and later
submissions replace that record. Update IDs are unique within a run: identical retries
are safe, reuse with different input fails. A finished report rejects subsequent changes.
Updates are atomic SQLite transactions in `CDR_HOME/reporting.sqlite`, separate from
execution metadata, so concurrent execution observations cannot overwrite agent reports.

`status` and `result` include `reporting` with a monotonic `version`, `updatedAt`, latest
`progress`, accumulated `records`, `result`, and `finished`. Poll the snapshot and apply
only newer versions. No transcript parsing is used for these application fields.
Desktop execution still determines when the agent stopped. A contracted run that ends
without a validated `finish` is failed, even if the agent's final prose says success.
A structured result may describe partial or failed business outcomes independently of
successful desktop execution.

Supported schema keywords are `type` (object, array, string, number, integer, boolean,
null), `properties`, `required`, `additionalProperties:false`, `items`, `enum`,
`minimum`, `maximum`, `minLength`, `maxLength`, `maxItems`, and `nullable` (a boolean
extension for optional values). Unsupported keywords fail at job creation. This is a
bounded subset, not a general JSON Schema implementation. Objects must explicitly
list properties, required fields, and forbid additional properties. Schemas are limited
to 12 levels; batches to 50 records; runs to 250 records and 2 MB of reporting data.
The host application's semantic checks, authorization, scheduling, browser serialization,
and interpretation of outcomes remain the caller's responsibility.

Contracted jobs explicitly select the named `cdr-report` permission profile for
both bootstrap and desktop handoff. Install this profile in the desktop's Codex
configuration before submitting contracted jobs (substitute your actual absolute
`CDR_HOME/reports` path):

```toml
[permissions.cdr-report]
extends = ":read-only"

[permissions.cdr-report.filesystem]
"/absolute/CDR_HOME/reports" = "write"

[permissions.cdr-report.network]
enabled = false
```

Preserve the desktop's existing `default_permissions` and normal approval settings.
If no default is configured, set `default_permissions = ":read-only"` at the top
of the file before any TOML tables, preserving Codex's implicit read-only default.
Named profiles require an explicit default. Review legacy `sandbox_mode` settings
before converting them.
The launcher verifies that the profile grants only the reports root, with no shell
network access or temp-directory writes. Jobs store their reports in separate `reports/RUN_ID` directories. Agents pipe
JSON to `--json-file -` with `printf`, avoiding shell heredoc temporary files. This separates job data but is
not an isolation boundary between agents using the same report root. Older jobs
retain their original report snapshots. Temporary bootstrap-only profile definitions
are insufficient because the desktop reloads configuration during attachment.

Cancellation uses interrupt protocol v4 with the expected turn ID, so a later turn
in the same conversation cannot accidentally be interrupted.

### Opt-in live deal-tool lookups

Contracted job files may include `"lookup": true`. This explicit capability is part
of the immutable request fingerprint and selects `cdr-lookup` instead of `cdr-report`.
Install that named profile through media-server before use. It retains report-folder
writes and read-only project access, while allowing command traffic to
`deals.cassettecapital.co`. Enable `features.network_proxy = true` in desktop
configuration as well as the bootstrap override: bootstrap-only feature settings
do not survive desktop handoff. Domain rules alone do not restrict network traffic without the proxy.

The job does not contain an API key. The deal-tool CLI reads its private key file on
the Mini. Keep that key scoped to `sourcing:lookup`. Regular contracted jobs remain
network-disabled. Verify an allowed API request and a denied off-domain request in
the desktop-owned turn whenever changing this permission handoff.

### Delegated extraction

Reporting commands accept `--ack-only` to return only the reporting version,
record count, and completion flag. Use it with `--json-file PATH` for child-produced
payloads so the parent does not have to read or reproduce raw listing content.
The injected reporting instructions identify the permitted run work directory.
The caller remains responsible for child lifecycles and browser concurrency.
