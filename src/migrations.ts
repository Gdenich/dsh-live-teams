import { ERROR_CODES, LiveTeamsError } from './errors.js'

/**
 * Bringing stored state forward.
 *
 * Every state file carries a `schemaVersion`. Reading already tolerates an older one — the fields
 * that exist are the fields the reader knows — but nothing *brings it forward*: a field added in a
 * later version would simply be missing until something happened to write the file again, and no
 * record said the state had been read at an older version. A version from the future was refused with
 * a bare "invalid state", which reads like corruption rather than "this was written by a newer DSH".
 *
 * A migration is a pure function from one version to the next. They are registered here by the
 * version they migrate *from*, so the chain is explicit and testable; the list is empty today because
 * version 1 is the first, and the framework exists so the first real change is a two-line addition
 * rather than a redesign.
 */
export type Migration = (state: unknown) => unknown

export const MIGRATIONS: Readonly<Record<number, Migration>> = Object.freeze({
  /**
   * 1 → 2: a task whose latest submission was never accepted is waiting for a decision.
   *
   * This is the best a single state can say: whether a *review* sent that submission back lives in
   * the reviews file, which a migration does not see. A task returned by a reviewer therefore lands
   * here too, and the panel offers accept or return with the rounds on screen — the human decides
   * with the evidence in front of them, which is what they can already do with everything else.
   */
  1: (state) => {
    const record = state !== null && typeof state === 'object' && !Array.isArray(state) ? state as Record<string, unknown> : undefined
    if (record === undefined || !Array.isArray(record.tasks)) return state
    return {
      ...record,
      tasks: record.tasks.map((entry) => {
        const task = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : undefined
        if (task === undefined) return entry
        const latest = task.latestSubmissionId
        if (typeof latest !== 'string' || latest.length === 0 || task.acceptedSubmissionId === latest) return task
        return { ...task, awaitsDecision: true }
      }),
    }
  },
})

export type MigrationPlan =
  | { readonly kind: 'current' }
  | { readonly kind: 'migrate'; readonly from: number; readonly to: number; readonly steps: readonly number[] }
  | { readonly kind: 'future'; readonly error: LiveTeamsError }

/**
 * What has to happen to read this state. `future` is a refusal with both numbers in it: a state
 * written by a newer product is not corruption, and saying so is the difference between a person
 * updating DSH and a person hunting a bug that is not there.
 */
export function planMigration(stored: unknown, current: number, what: string, migrations: Readonly<Record<number, Migration>> = MIGRATIONS): MigrationPlan {
  if (!Number.isInteger(stored) || (stored as number) < 0) {
    return { kind: 'future', error: new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, `${what} has no usable schemaVersion: ${String(stored)}`) }
  }
  const from = stored as number
  if (from === current) return { kind: 'current' }
  if (from > current) {
    return {
      kind: 'future',
      error: new LiveTeamsError(ERROR_CODES.SCHEMA_UNSUPPORTED, `${what} was written by a newer DSH (schema ${from}, this build understands ${current}); update DSH rather than editing the state`),
    }
  }
  const steps: number[] = []
  for (let version = from; version < current; version += 1) {
    if (migrations[version] === undefined) {
      return { kind: 'future', error: new LiveTeamsError(ERROR_CODES.SCHEMA_UNSUPPORTED, `${what} is at schema ${from} and no migration from ${version} to ${version + 1} is registered; this build cannot read it`) }
    }
    steps.push(version)
  }
  return { kind: 'migrate', from, to: current, steps }
}

/** Run the plan's steps in order. Returns the state as the current version sees it. */
export function applyMigration(state: unknown, plan: MigrationPlan, migrations: Readonly<Record<number, Migration>> = MIGRATIONS): unknown {
  if (plan.kind !== 'migrate') return state
  let working = state
  for (const step of plan.steps) {
    const migration = migrations[step]
    if (migration === undefined) throw new LiveTeamsError(ERROR_CODES.SCHEMA_UNSUPPORTED, `migration from ${step} to ${step + 1} disappeared while it was running`)
    working = migration(working)
  }
  return working
}
