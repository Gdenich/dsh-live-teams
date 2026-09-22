import { ERROR_CODES, LiveTeamsError } from "./errors.js";
//#region src/migrations.ts
const MIGRATIONS = Object.freeze({});
/**
* What has to happen to read this state. `future` is a refusal with both numbers in it: a state
* written by a newer product is not corruption, and saying so is the difference between a person
* updating DSH and a person hunting a bug that is not there.
*/
function planMigration(stored, current, what, migrations = MIGRATIONS) {
	if (!Number.isInteger(stored) || stored < 0) return {
		kind: "future",
		error: new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, `${what} has no usable schemaVersion: ${String(stored)}`)
	};
	const from = stored;
	if (from === current) return { kind: "current" };
	if (from > current) return {
		kind: "future",
		error: new LiveTeamsError(ERROR_CODES.SCHEMA_UNSUPPORTED, `${what} was written by a newer DSH (schema ${from}, this build understands ${current}); update DSH rather than editing the state`)
	};
	const steps = [];
	for (let version = from; version < current; version += 1) {
		if (migrations[version] === void 0) return {
			kind: "future",
			error: new LiveTeamsError(ERROR_CODES.SCHEMA_UNSUPPORTED, `${what} is at schema ${from} and no migration from ${version} to ${version + 1} is registered; this build cannot read it`)
		};
		steps.push(version);
	}
	return {
		kind: "migrate",
		from,
		to: current,
		steps
	};
}
/** Run the plan's steps in order. Returns the state as the current version sees it. */
function applyMigration(state, plan, migrations = MIGRATIONS) {
	if (plan.kind !== "migrate") return state;
	let working = state;
	for (const step of plan.steps) {
		const migration = migrations[step];
		if (migration === void 0) throw new LiveTeamsError(ERROR_CODES.SCHEMA_UNSUPPORTED, `migration from ${step} to ${step + 1} disappeared while it was running`);
		working = migration(working);
	}
	return working;
}
//#endregion
export { MIGRATIONS, applyMigration, planMigration };
