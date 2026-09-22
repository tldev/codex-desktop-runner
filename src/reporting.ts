import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { key, type Run } from './store.ts';
import { validate } from './schema.ts';
export interface Reporting {
  version: number;
  updatedAt?: string;
  progress?: unknown;
  records: Record<string, unknown>[];
  result?: unknown;
  finished: boolean;
  stopped?: boolean;
  researcherActive?: boolean;
}
export function acknowledgment(value: Reporting): {
  version: number;
  recordCount: number;
  finished: boolean;
} {
  return { version: value.version, recordCount: value.records.length, finished: value.finished };
}
export function reportingDirectory(root: string, id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid run id');
  return path.join(root, 'reports', id);
}
export function prepareReporting(root: string, id: string): string {
  const directory = reportingDirectory(root, id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return realpathSync(directory);
}
function database(root: string, id: string): DatabaseSync {
  const directory = reportingDirectory(root, id);
  // Previously launched jobs retain their original shared database.
  const file = path.join(existsSync(directory) ? directory : root, 'reporting.sqlite');
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS snapshots (run_id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS updates (run_id TEXT, update_id TEXT, fingerprint TEXT NOT NULL, PRIMARY KEY(run_id, update_id));`);
  return db;
}
function read(db: DatabaseSync, id: string): Reporting {
  const row = db.prepare('SELECT value FROM snapshots WHERE run_id=?').get(id);
  return row
    ? (JSON.parse(String(row.value)) as Reporting)
    : { version: 0, records: [], finished: false };
}
export function snapshot(root: string, id: string): Reporting {
  const db = database(root, id);
  try {
    return read(db, id);
  } finally {
    db.close();
  }
}
function append(run: Run, current: Reporting, input: unknown): void {
  if (!Array.isArray(input)) {
    const hint =
      input && typeof input === 'object' && 'records' in input ? ', not {records:[...]}' : '';
    throw new Error(`append-records expects a top-level JSON array [record, ...]${hint}`);
  }
  if (input.length > 50) throw new Error('append-records accepts up to 50 records per call');
  const records = new Map(current.records.map((r) => [r.id, r]));
  for (const item of input) {
    validate(run.contract!.record, item);
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id.trim() || record.id.length > 2048)
      throw new Error('Invalid record id');
    records.set(record.id, record);
  }
  if (records.size > 250) throw new Error('Run record limit is 250');
  current.records = [...records.values()];
}
function change(run: Run, current: Reporting, action: string, input: unknown): void {
  if (current.stopped)
    throw new Error('Run was cancelled; stop work, clean up, and call researcher-stop');
  if (current.finished) throw new Error('Reporting is already finished');
  if (action === 'finish' && current.researcherActive)
    throw new Error('Researcher is still active; call researcher-stop, then finish');
  if (action === 'append-records') return append(run, current, input);
  const kind = action === 'report' ? 'progress' : 'result';
  validate(run.contract![kind], input);
  current[kind] = input;
  if (kind === 'result') current.finished = true;
}
export function report(
  root: string,
  run: Run,
  action: string,
  updateId: string,
  input: unknown,
): Reporting {
  if (!run.contract || !run.submittedAt) throw new Error('Run has no active reporting contract');
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(updateId)) throw new Error('Invalid update id');
  const fingerprint = key(JSON.stringify({ action, input }));
  const db = database(root, run.id);
  try {
    db.exec('BEGIN IMMEDIATE');
    const current = read(db, run.id);
    const prior = db
      .prepare('SELECT fingerprint FROM updates WHERE run_id=? AND update_id=?')
      .get(run.id, updateId);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new Error(
          `Update id ${updateId} was already used with a different payload; use a new update id`,
        );
      db.exec('COMMIT');
      return current;
    }
    change(run, current, action, input);
    current.version += 1;
    current.updatedAt = new Date().toISOString();
    const serialized = JSON.stringify(current);
    if (Buffer.byteLength(serialized) > 2000000) throw new Error('Run reporting limit exceeded');
    db.prepare(
      'INSERT INTO snapshots VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET value=excluded.value',
    ).run(run.id, serialized);
    db.prepare('INSERT INTO updates VALUES (?,?,?)').run(run.id, updateId, fingerprint);
    db.exec('COMMIT');
    return current;
  } finally {
    db.close();
  }
}
export function instructions(root: string, run: Run): string {
  const prefix = `CDR_HOME=${quote(root)} ${quote(process.execPath)} ${quote(process.argv[1]!)}`;
  return `

Structured reporting contract for this run:
${JSON.stringify(run.contract)}
Run ID: ${run.id}
Run work directory: ${reportingDirectory(root, run.id)}
Report only through the commands below, in the default sandbox. Do not request elevated permissions; if a command is denied, report the blocker and stop. Never edit run files, modify the runner, start nested researchers, or call start/cancel.

Lifecycle:
1. ${prefix} researcher-start ${run.id} before any work.
2. ${prefix} active ${run.id} returns {"active":false} once the run is cancelled. Then stop work, clean up, and call researcher-stop; do not finish.
3. Append each record as soon as it is complete.
4. Call researcher-stop, then finish. Give your final response only after finish succeeds.

Commands. Payloads are validated against the contract, and rejections say what to fix. The update ID is an idempotency key: retry an identical payload with the same ID, send a changed payload with a new one.
printf '%s' 'PROGRESS_OBJECT' | ${prefix} report ${run.id} --update-id ID --json-file - --ack-only
printf '%s' '[RECORD_OBJECT]' | ${prefix} append-records ${run.id} --update-id ID --json-file - --ack-only
${prefix} researcher-stop ${run.id} && printf '%s' 'RESULT_OBJECT' | ${prefix} finish ${run.id} --update-id ID --json-file - --ack-only
Single-quote inline payloads so the shell cannot expand them, or pass --json-file PATH for a file inside the run work directory. Heredocs are denied: they write temporary files outside it.
append-records also accepts --browser-output in place of --json-file: it reads the records from an envelope written in the browser REPL with nodeRepl.write(JSON.stringify({cdrRecords:{runId:"${run.id}",updateId:"ID",records:[record]}})), using the same update ID.
`;
}
function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function researcherLifecycle(
  root: string,
  run: Run,
  action: 'stop' | 'researcher-start' | 'researcher-stop',
): Reporting {
  if (!run.contract) throw new Error('Researcher lifecycle requires a reporting contract');
  const db = database(root, run.id);
  try {
    db.exec('BEGIN IMMEDIATE');
    const current = read(db, run.id);
    if (action === 'researcher-start') {
      if (current.stopped || current.finished || current.researcherActive)
        throw new Error('Run cannot start another researcher');
      current.researcherActive = true;
    } else if (action === 'researcher-stop') {
      current.researcherActive = false;
    } else {
      current.stopped = true;
    }
    current.version += 1;
    current.updatedAt = new Date().toISOString();
    db.prepare(
      'INSERT INTO snapshots VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET value=excluded.value',
    ).run(run.id, JSON.stringify(current));
    db.exec('COMMIT');
    return current;
  } finally {
    db.close();
  }
}

export function reportingLifecycle(observed: Run): Run {
  const report = observed.reporting;
  if (report && observed.state === 'completed' && !report.finished) {
    observed.state = report.stopped ? 'cancelled' : 'failed';
    if (!report.stopped) observed.error = 'Agent ended without a validated final result';
  }
  if (
    report?.researcherActive &&
    (report.stopped || ['completed', 'cancelled', 'failed'].includes(observed.state))
  ) {
    if (observed.state !== 'running') observed.parentState = observed.state;
    observed.state = 'draining';
  }
  return observed;
}
