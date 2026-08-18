/**
 * Background-job protocol layer (P0-1, doc/2026-08-17-p0-job-runtime-channel.md §1.1).
 *
 * Types only: lifecycle, owner fencing, snapshot shape. No execution logic
 * lives here, so a second backend can implement the same registry without
 * touching the tool layer. Borrowed from deepseek-harness `packages/jobs/jobs`
 * with the cordis Service base dropped — pi has no cordis, so the registry is
 * a plain interface the gateway implements.
 */

/**
 * Task lifecycle. `queued` is a kalo addition: a job with a `gate` waits for
 * the gate to pass before its process exists at all (roadmap §2). Everything
 * else follows dsh: optionally `stopping`, then exactly one terminal status.
 */
export type JobStatus = "queued" | "running" | "stopping" | "completed" | "killed" | "failed";
/** True for the three terminal statuses. */
export function isTerminal(status: JobStatus): boolean {
  return status === "completed" || status === "killed" || status === "failed";
}

/**
 * Producer-defined job kinds; also the job id prefix (`<kind>-N`). The registry
 * treats each value as an opaque id namespace.
 */
export type JobKind = string;

/**
 * Operator capability. The desktop panel and the message channel act for the
 * user who owns every session, so they see and control all jobs; a pi session
 * only ever sees its own. This is a Symbol on purpose — a caller id arriving
 * over NDJSON or HTTP is a string and can never forge it.
 */
export const OPERATOR: unique symbol = Symbol("kalo.jobs.operator");

/** Who is asking: a session id, the operator, or an anonymous caller. */
export type Caller = string | typeof OPERATOR | undefined;

/** Terminal result supplied by a producer through {@link JobHooks.done}. */
export interface JobOutcome {
  status: "completed" | "killed" | "failed";
  /** Kind-specific detail rendered into status lines ("exit code: 3"). */
  detail?: string;
  /** Final output for jobs without `readOutput`; stream jobs leave it unset. */
  output?: string;
}

/** Hooks through which the runtime controls and observes producer work. */
export interface JobHooks {
  /**
   * Request termination. Must be synchronous, idempotent, and eventually
   * settle {@link done}. The optional reason is forwarded verbatim.
   */
  cancel(reason?: string): void;
  /**
   * Resolves after the producer releases its resources, not merely when the
   * work finishes. Must not reject; a rejection is converted to `failed`.
   */
  done: Promise<JobOutcome>;
  /**
   * Consume output produced since the previous call. Absence marks a
   * final-output-only job; each job has one consuming cursor.
   */
  readOutput?(): string;
}

/**
 * Producer declaration passed to {@link JobRegistry.start}. The runtime owns
 * identity and lifecycle state; the producer owns execution resources.
 */
export interface JobStart {
  /** Producer kind — also the id prefix. */
  kind: JobKind;
  /** One-line model-facing label (usually the command). */
  label: string;
  /**
   * Owning session id. Access is fenced by it: whoever started a job is the
   * only one who can see or stop it. Omitting the owner creates an unowned
   * job, open to any caller until service disposal.
   */
  owner?: string;
  /** Optional UTF-8 byte cap for each complete completion notice or output read. */
  outputLimitBytes?: number;
  /**
   * Start the work and synchronously return its hooks. Called once; a throw
   * leaves nothing registered and the producer must clean up partial state.
   */
  run(): JobHooks;
}

/**
 * Read-only projection of one job — a fresh object per call, never live
 * registry state.
 */
export interface JobSnapshot {
  id: string;
  kind: JobKind;
  label: string;
  /** Owner session id used for authorization; absent for unowned jobs. */
  ownerSession?: string;
  status: JobStatus;
  /** Kind-specific status detail, present once the producer supplied one. */
  detail?: string;
  outputLimitBytes?: number;
  /** Epoch ms when the job was registered. */
  startedAt: number;
  /** Epoch ms when the job settled; absent while live. */
  finishedAt?: number;
  /**
   * True once a kill, read, wait, or teardown cancel has reported (or
   * committed to report) the terminal state. Completion reporters suppress
   * redundant notices when set.
   */
  reported: boolean;
}

/** Output plus post-read state returned by {@link JobRegistry.read}. */
export interface JobRead {
  /**
   * Stream kinds: the consuming delta since the previous read. Final-output
   * kinds: empty while live, the terminal output once settled (idempotent).
   */
  text: string;
  snapshot: JobSnapshot;
}

/** Completion callback receiving the terminal snapshot and its exact owner. */
export type JobDoneListener = (snapshot: JobSnapshot, owner: string | undefined) => void;

/**
 * Observation callback for a change to what one owner's list would return.
 * Owner-granular rather than job-granular: the change may be a removal, which
 * no per-job record can express, and consumers re-read the whole set anyway.
 */
export type JobsChangedListener = (owner: string | undefined) => void;

/**
 * The registry contract. Implementations must honor:
 *
 * - Registrations outlive the caller that created them; a job is not tied to
 *   the turn that started it.
 * - Owned-job access is fenced by owner session id. Ids are predictable, so
 *   authorization — not secrecy — is the boundary.
 * - Settlement is first-wins: one terminal record, released waiters, and one
 *   round of contained listener notification, even against a late producer
 *   outcome. Completion is announced last, after the record is committed.
 */
export interface JobRegistry {
  /**
   * Preflight, then start and atomically register work. Any preflight
   * rejection leaves no job id or execution resource; a throwing starter
   * leaves nothing registered.
   * @returns the registry-issued `<kind>-N` id.
   */
  start(spec: JobStart): string;

  /** List caller-owned and unowned jobs in registration order. */
  list(caller?: Caller): JobSnapshot[];

  /** Non-consuming snapshot. Throws for an unknown or foreign job. */
  get(id: string, caller?: Caller): JobSnapshot;

  /**
   * Read the next stream delta, or the idempotent final output after
   * settlement. A terminal read marks the job reported.
   */
  read(id: string, caller?: Caller): JobRead;

  /**
   * Request cancellation, then mark the job stopping and reported.
   * @returns `requested` for live work, otherwise `already-finished`.
   */
  kill(id: string, caller?: Caller, reason?: string): "requested" | "already-finished";

  /**
   * Wait for settlement or timeout without cancelling. After settlement the
   * terminal snapshot wins, so a notice suppressed for this waiter is still
   * delivered.
   */
  wait(id: string, timeoutMs: number, caller?: Caller, signal?: AbortSignal): Promise<JobSnapshot>;

  /** Register a completion listener. Returns a disposer. */
  onJobDone(listener: JobDoneListener): () => void;

  /** Register an observer of visible-set changes. Returns a disposer. */
  onJobsChanged(listener: JobsChangedListener): () => void;
}
