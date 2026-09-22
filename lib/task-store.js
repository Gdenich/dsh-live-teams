import { ERROR_CODES, LiveTeamsError } from "./errors.js";
import { atomicWrite, atomicWriteJson, clone, fileExists, readJson, withProcessLock } from "./storage.js";
import { TEAM_ROOT } from "./team-store.js";
import { CODING_KINDS, literalPrefix, normalizeScope, normalizeScopePath, outsideScope, scopesIntersect } from "./scope.js";
import { diffSnapshots } from "./tree-snapshot.js";
import { MIGRATIONS, applyMigration, planMigration } from "./migrations.js";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { promises, readFileSync } from "node:fs";
//#region src/task-store.ts
const TASK_KINDS = [
	"work",
	"research",
	"requirements",
	"implementation",
	"verification",
	"review",
	"repair",
	"integration"
];
const TASK_STATUSES = [
	"draft",
	"ready",
	"claimed",
	"in_progress",
	"waiting",
	"needs_human",
	"completed",
	"failed",
	"cancelled"
];
const MAX_TITLE = 200;
const MAX_BODY = 2e4;
const MAX_TASKS = 100;
/** A task with more dependencies than this is a plan, not a task. */
const MAX_DEPENDENCIES = 8;
const FINDING_SEVERITIES = [
	"low",
	"medium",
	"high",
	"blocker"
];
const REVIEW_VERDICTS = [
	"pass",
	"needs_revision",
	"escalate"
];
function objectRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function nonEmpty(value) {
	return typeof value === "string" && value.trim().length > 0;
}
function chars(value) {
	return Array.from(value).length;
}
function candidateId(value) {
	return value.length > 0 && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\");
}
function fail(message) {
	throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, message);
}
function memberById(team, id) {
	return team.members.find((member) => member.memberId === id);
}
function isLead(team, actor) {
	if (team.leadMemberId !== void 0) return team.leadMemberId === actor && memberById(team, actor) !== void 0;
	const leads = team.members.filter((member) => member.role === "lead");
	return leads.length === 1 && leads[0]?.memberId === actor;
}
/** The desktop route is the owning human's lead-level operation. */
function isLeadOrHuman(team, actor) {
	return actor === "human:desktop" || actor === "local:unverified" || isLead(team, actor);
}
function leadMemberIdForMessage(team) {
	return team.leadMemberId ?? team.members.find((member) => member.role === "lead")?.memberId ?? "the lead";
}
function validateRoute(route, team, assignee) {
	if (objectRecord(route)?.type === "interactive") fail("the interactive route shape is not implemented: use {\"type\":\"review\",\"reviewer\":\"<member id>\"} or {\"type\":\"report\",\"to\":\"human\"}");
	const value = objectRecord(route);
	if (value === void 0 || typeof value.type !== "string") fail("route must be a report, review, interactive, or custom route");
	if (value.type === "report") {
		if (value.to !== "human" && (typeof value.to !== "string" || memberById(team, value.to) === void 0)) fail("report route must name a current member or human");
		return {
			type: "report",
			to: value.to
		};
	}
	if (value.type === "review") {
		if (typeof value.reviewer !== "string" || memberById(team, value.reviewer) === void 0) fail("review route must name a current member");
		if (assignee !== void 0 && value.reviewer === assignee) fail("reviewer cannot be the assignee; nobody reviews their own work");
		return {
			type: "review",
			reviewer: value.reviewer
		};
	}
	if (value.type === "interactive") {
		if (value.then === void 0) fail("interactive route requires a follow-up route");
		return {
			type: "interactive",
			then: validateRoute(value.then, team, assignee)
		};
	}
	if (value.type === "custom") {
		if (!nonEmpty(value.description)) fail("custom route description must be non-empty");
		return {
			type: "custom",
			description: value.description.trim()
		};
	}
	fail(`unsupported task route: ${value.type}`);
}
/**
* Validate the dependency list of a task contract.
*
* Checked against the tasks that exist *now*, because a dependency naming a task
* that does not exist is a typo that would block the work forever, and a cycle
* would block it just as permanently while looking legitimate.
*/
function validateDependencies(value, selfId, tasks) {
	if (value === void 0) return void 0;
	if (!Array.isArray(value)) fail("dependsOn must be an array of task ids");
	if (value.length === 0) return void 0;
	if (value.length > MAX_DEPENDENCIES) fail(`a task may depend on at most ${MAX_DEPENDENCIES} tasks`);
	const ids = [];
	for (const entry of value) {
		if (typeof entry !== "string" || !candidateId(entry)) fail("dependsOn must contain task ids");
		if (entry === selfId) fail("a task cannot depend on itself");
		if (ids.includes(entry)) fail(`dependsOn repeats ${entry}`);
		if (!tasks.some((task) => task.id === entry)) fail(`dependsOn names an unknown task: ${entry}`);
		ids.push(entry);
	}
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const seen = /* @__PURE__ */ new Set();
	const pending = [...ids];
	while (pending.length > 0) {
		const id = pending.pop();
		if (id === selfId) fail(`dependsOn would create a cycle through ${id}`);
		if (seen.has(id)) continue;
		seen.add(id);
		for (const next of byId.get(id)?.dependsOn ?? []) pending.push(next);
	}
	return ids;
}
/**
* The dependencies that still stand between a task and its claim, in the order
* the contract lists them. A dependency in a terminal non-completed state is
* included on purpose: it blocks forever and the human must see that.
*/
function blockedBy(task, tasks) {
	const ids = task.dependsOn ?? [];
	if (ids.length === 0) return [];
	const byId = new Map(tasks.map((entry) => [entry.id, entry]));
	return ids.filter((id) => byId.get(id)?.status !== "completed").map((id) => ({
		id,
		title: byId.get(id)?.title ?? id,
		status: byId.get(id)?.status ?? "failed"
	}));
}
function validateTaskRecord(value, teamId, archiveDirectory) {
	const candidate = objectRecord(value);
	const humanContact = candidate?.humanContact;
	const archivedPath = candidate?.archivedPath;
	const archiveRoot = archiveDirectory === void 0 ? void 0 : path.resolve(archiveDirectory);
	const resolvedArchive = typeof archivedPath !== "string" || archiveRoot === void 0 ? void 0 : path.isAbsolute(archivedPath) ? path.resolve(archivedPath) : path.resolve(path.dirname(archiveRoot), archivedPath);
	const archivePathValid = archivedPath === void 0 || typeof archivedPath === "string" && archivedPath.length > 0 && resolvedArchive !== void 0 && (resolvedArchive === archiveRoot || resolvedArchive.startsWith(`${archiveRoot}${path.sep}`));
	if (candidate === void 0 || typeof candidate.id !== "string" || !candidateId(candidate.id) || candidate.teamId !== teamId || typeof candidate.title !== "string" || candidate.title.trim().length === 0 || !TASK_KINDS.includes(candidate.kind) || !TASK_STATUSES.includes(candidate.status) || !Array.isArray(candidate.acceptance) || !candidate.acceptance.every((entry) => typeof entry === "string") || candidate.status === "ready" && (candidate.assignee === void 0 || candidate.route === void 0 || candidate.acceptance.length === 0 || candidate.acceptance.some((entry) => entry.trim().length === 0)) || candidate.assignee !== void 0 && typeof candidate.assignee !== "string" || candidate.why !== void 0 && typeof candidate.why !== "string" || candidate.body !== void 0 && (typeof candidate.body !== "string" || chars(candidate.body) > MAX_BODY) || candidate.checks !== void 0 && (!Array.isArray(candidate.checks) || !candidate.checks.every((entry) => typeof entry === "string" && entry.trim().length > 0)) || candidate.dependsOn !== void 0 && (!Array.isArray(candidate.dependsOn) || candidate.dependsOn.length === 0 || candidate.dependsOn.length > MAX_DEPENDENCIES || !candidate.dependsOn.every((entry) => typeof entry === "string" && candidateId(entry)) || new Set(candidate.dependsOn).size !== candidate.dependsOn.length || candidate.dependsOn.includes(candidate.id)) || candidate.paths !== void 0 && normalizeScope(candidate.paths) === void 0 || candidate.contractRevision !== void 0 && (!Number.isInteger(candidate.contractRevision) || Number(candidate.contractRevision) < 1) || !archivePathValid || humanContact !== void 0 && humanContact !== "none" && humanContact !== "expected" && humanContact !== "required" || candidate.activeAttemptId !== void 0 && (typeof candidate.activeAttemptId !== "string" || !candidateId(candidate.activeAttemptId)) || !Number.isInteger(candidate.roundLimit) || Number(candidate.roundLimit) < 1 || Number(candidate.roundLimit) > 20 || typeof candidate.createdBy !== "string" || candidate.createdBy.length === 0 || !Number.isInteger(candidate.createdAt) || !Number.isInteger(candidate.updatedAt) || !Number.isInteger(candidate.revision) || Number(candidate.revision) < 1) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, "invalid task record");
	return candidate;
}
function parseTasksState(value, teamId, archiveDirectory) {
	const candidate = objectRecord(value);
	if (candidate !== void 0 && Number.isInteger(candidate.schemaVersion) && Number(candidate.schemaVersion) !== 1) {
		const plan = planMigration(candidate.schemaVersion, 1, "task state");
		if (plan.kind === "future") throw plan.error;
	}
	if (candidate === void 0 || !Number.isInteger(candidate.schemaVersion) || Number(candidate.schemaVersion) > 1 || candidate.teamId !== teamId || !Number.isInteger(candidate.revision) || Number(candidate.revision) < 0 || !Array.isArray(candidate.tasks)) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, "invalid task state");
	const tasks = candidate.tasks.map((entry) => validateTaskRecord(entry, teamId, archiveDirectory));
	return {
		...candidate,
		revision: Number(candidate.revision),
		tasks
	};
}
function validateAttempt(value, teamId) {
	const candidate = objectRecord(value);
	if (candidate === void 0 || typeof candidate.id !== "string" || !candidateId(candidate.id) || typeof candidate.taskId !== "string" || !candidateId(candidate.taskId) || candidate.memberId === void 0 || typeof candidate.memberId !== "string" || candidate.memberId.length === 0 || typeof candidate.sessionId !== "string" || candidate.sessionId.length === 0 || !Number.isInteger(candidate.bindingGeneration) || Number(candidate.bindingGeneration) < 0 || !Number.isInteger(candidate.generation) || Number(candidate.generation) < 1 || candidate.status !== "active" && candidate.status !== "revoking" && candidate.status !== "revoked" && candidate.status !== "completed" && candidate.status !== "failed" || !Number.isInteger(candidate.startedAt) || !Number.isInteger(candidate.revision) || Number(candidate.revision) < 1 || candidate.humanIntervenedAt !== void 0 && !Number.isInteger(candidate.humanIntervenedAt) || candidate.humanIntervenedContractRevision !== void 0 && !Number.isInteger(candidate.humanIntervenedContractRevision) || candidate.gitBase !== void 0 && (objectRecord(candidate.gitBase) === void 0 || typeof objectRecord(candidate.gitBase)?.ref !== "string" || typeof objectRecord(candidate.gitBase)?.baseTipSha !== "string") || candidate.stalled !== void 0 && (objectRecord(candidate.stalled) === void 0 || !Number.isInteger(objectRecord(candidate.stalled)?.at) || objectRecord(candidate.stalled)?.reason !== "unacknowledged" && objectRecord(candidate.stalled)?.reason !== "idle" || typeof objectRecord(candidate.stalled)?.detail !== "string")) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, `invalid task attempt in ${teamId}`);
	return candidate;
}
function parseAttemptsState(value, teamId) {
	const candidate = objectRecord(value);
	if (candidate === void 0 || !Number.isInteger(candidate.schemaVersion) || Number(candidate.schemaVersion) > 1 || candidate.teamId !== teamId || !Number.isInteger(candidate.revision) || Number(candidate.revision) < 0 || !Array.isArray(candidate.attempts)) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, "invalid attempts state");
	return {
		...candidate,
		revision: Number(candidate.revision),
		attempts: candidate.attempts.map((entry) => validateAttempt(entry, teamId))
	};
}
/**
* The fence of ADR 0005, applied where it was missing: a member acting on its own task must present
* the Session and binding generation it is bound to *now*. `submitTask` always checked the triple;
* `claimTask` and `acknowledgeTask` did not, so a rebind could leave an old Session's call landing on
* the new one's attempt (found by an external review).
*/
function fenceMember(member, request, memberId) {
	if (member === void 0) fail(`${memberId} is not a current team member`);
	if (member.sessionId === void 0) return;
	if (request.sessionId !== member.sessionId || request.bindingGeneration !== member.bindingGeneration) fail(`${memberId} is bound to Session ${member.sessionId} (generation ${member.bindingGeneration}); this call came from another binding. Re-read the task and act from the current Session`);
}
/** A readable, collision-free ref name for a pinned submission commit. */
function submissionGitRefSuffix(generation, headSha) {
	return `g${generation}-${headSha.slice(0, 12)}`;
}
function validateCheck(value) {
	const candidate = objectRecord(value);
	const keys = candidate === void 0 ? String(value) : Object.keys(candidate).join(", ");
	if (candidate === void 0 || typeof candidate.command !== "string" || candidate.command.trim().length === 0 || candidate.status !== "passed" && candidate.status !== "failed" || candidate.output !== void 0 && typeof candidate.output !== "string") fail(`check needs {"command":"…","status":"passed" | "failed"} and optionally {"output":"…"}; received keys: ${keys}`);
	return {
		command: candidate.command,
		status: candidate.status,
		...candidate.output === void 0 ? {} : { output: candidate.output }
	};
}
function validateSubmission(value, teamId) {
	const candidate = objectRecord(value);
	const artifact = objectRecord(candidate?.artifact);
	if (candidate === void 0 || typeof candidate.id !== "string" || !candidateId(candidate.id) || typeof candidate.taskId !== "string" || !candidateId(candidate.taskId) || typeof candidate.attemptId !== "string" || !candidateId(candidate.attemptId) || !Number.isInteger(candidate.attemptGeneration) || Number(candidate.attemptGeneration) < 1 || artifact === void 0 || artifact.type !== "report" && artifact.type !== "files" || typeof candidate.summary !== "string" || !Array.isArray(candidate.checks) || !Number.isInteger(candidate.createdAt) || !Number.isInteger(candidate.revision) || Number(candidate.revision) < 1) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, `invalid submission in ${teamId}`);
	if (artifact.type === "report" && (typeof artifact.bodyRef !== "string" || typeof artifact.bodyDigest !== "string")) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, "invalid report submission artifact");
	if (artifact.type === "files" && (!Array.isArray(artifact.paths) || !artifact.paths.every((entry) => typeof entry === "string") || typeof artifact.manifestDigest !== "string")) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, "invalid files submission artifact");
	if (candidate.git !== void 0) {
		const git = objectRecord(candidate.git);
		if (git === void 0 || typeof git.baseRef !== "string" || typeof git.baseTipSha !== "string" || typeof git.headSha !== "string" || !Array.isArray(git.commitPaths) || !git.commitPaths.every((entry) => typeof entry === "string") || git.mergeBaseSha !== void 0 && typeof git.mergeBaseSha !== "string") throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, "invalid Git submission artifact");
	}
	const scope = objectRecord(candidate.scope);
	const normalizedScope = scope === void 0 ? void 0 : {
		...scope,
		state: scope.state === "collision" ? "shared-tree" : scope.state,
		...scope.sharedTree === void 0 && Array.isArray(scope.collision) ? { sharedTree: scope.collision } : {}
	};
	if (normalizedScope !== void 0) delete normalizedScope.collision;
	return {
		...candidate,
		...normalizedScope === void 0 ? {} : { scope: normalizedScope },
		artifact: clone(artifact),
		checks: candidate.checks.map(validateCheck)
	};
}
function parseSubmissionsState(value, teamId) {
	const candidate = objectRecord(value);
	if (candidate === void 0 || !Number.isInteger(candidate.schemaVersion) || Number(candidate.schemaVersion) > 1 || candidate.teamId !== teamId || !Number.isInteger(candidate.revision) || Number(candidate.revision) < 0 || !Array.isArray(candidate.submissions)) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, "invalid submissions state");
	return {
		...candidate,
		revision: Number(candidate.revision),
		submissions: candidate.submissions.map((entry) => validateSubmission(entry, teamId))
	};
}
function validateFinding(value) {
	const candidate = objectRecord(value);
	const keys = candidate === void 0 ? String(value) : Object.keys(candidate).join(", ");
	if (candidate === void 0 || !FINDING_SEVERITIES.includes(candidate.severity) || typeof candidate.problem !== "string" || candidate.problem.trim().length === 0 || typeof candidate.requiredFix !== "string" || candidate.requiredFix.trim().length === 0 || candidate.artifactLocation !== void 0 && typeof candidate.artifactLocation !== "string") fail(`finding needs {"severity":"low" | "medium" | "high" | "blocker","problem":"…","requiredFix":"…"}; received keys: ${keys}`);
	return {
		severity: candidate.severity,
		problem: candidate.problem,
		requiredFix: candidate.requiredFix,
		...candidate.artifactLocation === void 0 ? {} : { artifactLocation: candidate.artifactLocation }
	};
}
function validateReview(value, teamId) {
	const candidate = objectRecord(value);
	if (candidate === void 0 || typeof candidate.id !== "string" || !candidateId(candidate.id) || typeof candidate.taskId !== "string" || !candidateId(candidate.taskId) || typeof candidate.submissionId !== "string" || !candidateId(candidate.submissionId) || typeof candidate.reviewerMemberId !== "string" || candidate.reviewerMemberId.length === 0 || !Number.isInteger(candidate.round) || Number(candidate.round) < 1 || !REVIEW_VERDICTS.includes(candidate.verdict) || !Array.isArray(candidate.findings) || !Array.isArray(candidate.evidence) || !Number.isInteger(candidate.createdAt) || !Number.isInteger(candidate.revision) || Number(candidate.revision) < 1) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, `invalid review in ${teamId}`);
	return {
		...candidate,
		findings: candidate.findings.map(validateFinding),
		evidence: candidate.evidence.map(validateCheck)
	};
}
function parseReviewsState(value, teamId) {
	const candidate = objectRecord(value);
	if (candidate === void 0 || !Number.isInteger(candidate.schemaVersion) || Number(candidate.schemaVersion) > 1 || candidate.teamId !== teamId || !Number.isInteger(candidate.revision) || Number(candidate.revision) < 0 || !Array.isArray(candidate.rounds)) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, "invalid reviews state");
	return {
		...candidate,
		revision: Number(candidate.revision),
		rounds: candidate.rounds.map((entry) => validateReview(entry, teamId))
	};
}
function routeText(route, team) {
	if (route === void 0) return "—";
	if (route.type === "report") {
		if (route.to === "human") return "report → human";
		return `report → ${memberById(team, route.to)?.displayName ?? route.to}`;
	}
	if (route.type === "review") return `review → ${memberById(team, route.reviewer)?.displayName ?? route.reviewer}`;
	if (route.type === "custom") return `custom → ${route.description}`;
	return `interactive → ${routeText(route.then, team)}`;
}
function assignmentRouteText(route, team) {
	if (route === void 0) return "not set";
	if (route.type === "report") return route.to === "human" ? "report to the human" : `report to ${memberById(team, route.to)?.displayName ?? route.to}`;
	if (route.type === "review") return `review by ${memberById(team, route.reviewer)?.displayName ?? route.reviewer}, then the result goes to the lead`;
	if (route.type === "custom") return `custom route: ${route.description}`;
	return `interactive route, then ${assignmentRouteText(route.then, team)}`;
}
function deriveRouteContacts(task, team) {
	if (task.assignee === void 0 || task.route === void 0) return [];
	if (![
		"ready",
		"claimed",
		"in_progress",
		"waiting",
		"needs_human"
	].includes(task.status)) return [];
	if (task.route.type === "report") return task.route.to === "human" ? ["human"] : [task.route.to];
	if (task.route.type === "review") return [task.assignee, task.route.reviewer];
	if (task.route.type === "interactive") return deriveRouteContacts({
		...task,
		route: task.route.then
	}, team);
	return [];
}
function routeAllowsContact(task, from, to, team) {
	if (task.assignee === void 0 || task.route === void 0 || ![
		"ready",
		"claimed",
		"in_progress",
		"waiting",
		"needs_human"
	].includes(task.status)) return false;
	if (task.route.type === "report") return from === task.assignee && task.route.to === to;
	if (task.route.type === "review") return from === task.assignee && to === task.route.reviewer || from === task.route.reviewer && to === task.assignee;
	if (task.route.type === "interactive") return routeAllowsContact({
		...task,
		route: task.route.then
	}, from, to, team);
	return false;
}
function taskDocumentPath(workspacePath, teamId, taskId) {
	return path.join(path.resolve(workspacePath), ".dsh-live-teams", "teams", teamId, "tasks", `${taskId}.md`);
}
function renderDocument(task, team, fields = {}) {
	const why = fields.why ?? task.why;
	const body = fields.body ?? task.body;
	const taskChecks = fields.checks ?? task.checks ?? [];
	const assignee = task.assignee === void 0 ? "—" : `${memberById(team, task.assignee)?.displayName ?? task.assignee} (${task.assignee})`;
	const checks = taskChecks.length === 0 ? "- —" : taskChecks.map((check) => `- \`${check}\``).join("\n");
	const acceptance = task.acceptance.length === 0 ? "- —" : task.acceptance.map((criterion) => `- ${criterion}`).join("\n");
	const tasks = fields.tasks ?? [];
	const dependsOn = (task.dependsOn ?? []).length === 0 ? "" : `\n\n## Depends on\n${(task.dependsOn ?? []).map((id) => {
		const dependency = tasks.find((entry) => entry.id === id);
		return `- ${id}${dependency === void 0 ? "" : ` — ${dependency.title} (${dependency.status})`}`;
	}).join("\n")}`;
	const paths = (task.paths ?? []).length === 0 ? "" : `\n\n## Paths\nStay inside these; anything else is outside this task's scope.\n${(task.paths ?? []).map((entry) => `- \`${entry}\``).join("\n")}`;
	return `# ${task.title}\n\n- **Task:** ${task.id}\n- **Kind:** ${task.kind}\n- **Assignee:** ${assignee}\n- **Route:** ${routeText(task.route, team)}\n- **Round limit:** ${task.roundLimit}\n\n## Why\n${why === void 0 || why.trim().length === 0 ? "—" : why}\n\n## What to do\n${body === void 0 || body.length === 0 ? "—" : body}${dependsOn}${paths}\n\n## Checks\n${checks}\n\n## Acceptance\n${acceptance}\n\n## Finish\nRun the checks. Report to your lead, or submit for review, according to the route.\nA task without a route is a defect: ask your lead rather than choosing one.\n`;
}
var TaskStore = class {
	location;
	workspacePath;
	appendAudit;
	deliverEscalation;
	deliverClosing;
	deliverDirection;
	interruptSession;
	awaitQuiescence;
	quiescenceTimeoutMs;
	changedPaths;
	git;
	migrations;
	workspaceMode;
	snapshotTree;
	/** `null` means "no port": the answer is cached because a store lives with one workspace. */
	resolvedMode;
	constructor(options) {
		this.deliverEscalation = options.deliverEscalation;
		this.deliverClosing = options.deliverClosing;
		this.deliverDirection = options.deliverDirection;
		this.interruptSession = options.interruptSession;
		this.awaitQuiescence = options.awaitQuiescence;
		this.quiescenceTimeoutMs = options.quiescenceTimeoutMs ?? 5e3;
		this.changedPaths = options.changedPaths;
		this.git = options.git;
		this.migrations = options.migrations ?? MIGRATIONS;
		this.workspaceMode = options.workspaceMode;
		this.snapshotTree = options.snapshotTree;
		const workspacePath = path.resolve(options.workspacePath);
		this.workspacePath = workspacePath;
		const directory = path.join(workspacePath, ".dsh-live-teams", "teams", options.teamId);
		this.location = {
			directory,
			file: path.join(directory, "tasks.json"),
			attemptsFile: path.join(directory, "attempts.json"),
			submissionsFile: path.join(directory, "submissions.json"),
			reviewsFile: path.join(directory, "reviews.json"),
			teamFile: path.join(directory, "team.json"),
			tasksDirectory: path.join(directory, "tasks"),
			archiveDirectory: path.join(directory, "archive"),
			snapshotsDirectory: path.join(directory, "snapshots"),
			blobsDirectory: path.join(directory, "artifacts", "blobs")
		};
		this.appendAudit = options.appendAudit ?? (async () => void 0);
	}
	get filePath() {
		return this.location.file;
	}
	get directoryPath() {
		return this.location.directory;
	}
	async open() {
		return withProcessLock(this.location.teamFile, async () => this.readOrCreateLocked());
	}
	async listTasks(options = {}) {
		const includeArchived = typeof options === "boolean" ? options : options.includeArchived === true;
		return clone(await withProcessLock(this.location.teamFile, async () => {
			const state = await this.readOrCreateLocked();
			const reviews = await this.readReviewsIfPresentLocked();
			const latestRound = /* @__PURE__ */ new Map();
			for (const round of reviews.rounds) {
				const prior = latestRound.get(round.taskId);
				if (prior === void 0 || round.round > prior) latestRound.set(round.taskId, round.round);
			}
			const visible = includeArchived ? state.tasks : state.tasks.filter((task) => task.archivedPath === void 0);
			return (await Promise.all(visible.map(async (task) => {
				const round = latestRound.get(task.id);
				const withRound = round === void 0 ? task : {
					...task,
					round
				};
				const documentPath = task.archivedPath === void 0 ? this.documentPath(task.id) : this.archivedPathOf(task.archivedPath);
				return await fileExists(documentPath) ? withRound : {
					...withRound,
					documentMissing: true
				};
			}))).sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.revision - left.revision || left.id.localeCompare(right.id)).slice(0, MAX_TASKS);
		}));
	}
	async readTask(taskId) {
		if (!candidateId(taskId)) fail("invalid task id");
		return withProcessLock(this.location.teamFile, async () => {
			const task = (await this.readOrCreateLocked()).tasks.find((entry) => entry.id === taskId);
			if (task === void 0) fail(`task not found: ${taskId}`);
			const driftOf = async (submission) => {
				const artifact = submission.artifact;
				const checks = artifact.type === "report" ? [{
					path: artifact.bodyRef,
					expected: artifact.bodyDigest
				}] : (artifact.blobs ?? []).map((blob) => ({
					path: blob.path,
					expected: blob.digest
				}));
				const drift = [];
				for (const entry of checks) {
					const absolute = path.resolve(this.workspacePath, entry.path);
					let bytes;
					try {
						bytes = await promises.readFile(absolute);
					} catch {
						bytes = void 0;
					}
					const actual = bytes === void 0 ? null : createHash("sha256").update(bytes).digest("hex");
					if (actual !== entry.expected) drift.push({
						path: entry.path,
						expected: entry.expected,
						actual
					});
				}
				return drift;
			};
			const documentPath = task.archivedPath === void 0 ? this.documentPath(taskId) : this.archivedPathOf(task.archivedPath);
			let document;
			try {
				document = await promises.readFile(documentPath, "utf8");
			} catch (error) {
				throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, `task ${taskId} document is missing at ${documentPath}; ask the lead to restore the task document`, { cause: error });
			}
			const submissions = await Promise.all((await this.readSubmissionsIfPresentLocked()).submissions.filter((entry) => entry.taskId === taskId).map(async (submission) => {
				const drift = await driftOf(submission);
				return drift.length === 0 ? submission : {
					...submission,
					drift
				};
			}));
			const rounds = (await this.readReviewsIfPresentLocked()).rounds.filter((entry) => entry.taskId === taskId);
			const attempts = (await this.readAttemptsIfPresentLocked()).attempts.filter((entry) => entry.taskId === taskId);
			return {
				task: clone(task),
				document,
				submissions: clone(submissions),
				rounds: clone(rounds),
				attempts: clone(attempts)
			};
		});
	}
	async readAttempts() {
		return withProcessLock(this.location.teamFile, async () => this.readAttemptsIfPresentLocked());
	}
	async readSubmissions() {
		return withProcessLock(this.location.teamFile, async () => this.readSubmissionsIfPresentLocked());
	}
	async readReviews() {
		return withProcessLock(this.location.teamFile, async () => this.readReviewsIfPresentLocked());
	}
	async activeTaskForMember(memberId) {
		const active = (await withProcessLock(this.location.teamFile, async () => this.readOrCreateLocked())).tasks.filter((task) => task.assignee === memberId && [
			"ready",
			"claimed",
			"in_progress",
			"waiting",
			"needs_human"
		].includes(task.status));
		active.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
		return active[0] === void 0 ? void 0 : clone(active[0]);
	}
	activeTaskForMemberSync(memberId) {
		try {
			const active = parseTasksState(JSON.parse(readFileSync(this.location.file, "utf8")), this.teamId, this.location.archiveDirectory).tasks.filter((task) => task.assignee === memberId && [
				"ready",
				"claimed",
				"in_progress",
				"waiting",
				"needs_human"
			].includes(task.status));
			active.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
			return active[0] === void 0 ? void 0 : clone(active[0]);
		} catch (error) {
			if (error.code === "ENOENT") return void 0;
			throw error;
		}
	}
	/**
	* The latest attempt of one task, read synchronously for context assembly: the member
	* has to know that a human wrote into its Session mid-flight (B31).
	*/
	latestAttemptForTaskSync(taskId) {
		try {
			const attempts = parseAttemptsState(JSON.parse(readFileSync(this.location.attemptsFile, "utf8")), this.teamId).attempts.filter((attempt) => attempt.taskId === taskId);
			attempts.sort((left, right) => right.generation - left.generation);
			return attempts[0] === void 0 ? void 0 : clone(attempts[0]);
		} catch (error) {
			if (error.code === "ENOENT") return void 0;
			throw error;
		}
	}
	/**
	* Every task, read synchronously for context assembly. The authorization gate
	* scans all tasks — a reviewer holds a path to a task it is not the assignee of —
	* so the line a member reads about where it may send has to see the same set.
	*/
	listTasksSync() {
		try {
			const state = parseTasksState(JSON.parse(readFileSync(this.location.file, "utf8")), this.teamId, this.location.archiveDirectory);
			return clone(state.tasks.filter((task) => task.archivedPath === void 0));
		} catch (error) {
			if (error.code === "ENOENT") return [];
			throw error;
		}
	}
	/**
	* Close attempts whose task has already ended (F5 of the first live run).
	*
	* Both acceptance paths are supposed to close the attempt, but "supposed to" is how
	* the member stayed busy forever: a stale active attempt blocks every later task for
	* that member and keeps the intervention observer watching a finished Session. This
	* heals the class rather than the instance — a task in a terminal status cannot have
	* work in flight.
	*/
	async closeTerminalAttempts() {
		return await withProcessLock(this.location.teamFile, async () => {
			const attempts = await this.readAttemptsIfPresentLocked();
			const tasks = await this.readTasksIfPresentLocked();
			const terminal = new Map(tasks.tasks.filter((task) => task.status === "completed" || task.status === "cancelled" || task.status === "failed").map((task) => [task.id, task.status]));
			const stale = attempts.attempts.filter((attempt) => attempt.status === "active" && terminal.has(attempt.taskId));
			if (stale.length === 0) return { closed: [] };
			const closed = stale.map((attempt) => ({
				attemptId: attempt.id,
				taskId: attempt.taskId,
				memberId: attempt.memberId,
				status: terminal.get(attempt.taskId) === "completed" ? "completed" : "failed"
			}));
			const byId = new Map(closed.map((entry) => [entry.attemptId, entry.status]));
			const nextAttempts = {
				...attempts,
				schemaVersion: 1,
				revision: attempts.revision + 1,
				attempts: attempts.attempts.map((attempt) => byId.has(attempt.id) ? {
					...attempt,
					status: byId.get(attempt.id),
					revision: attempt.revision + 1
				} : attempt)
			};
			await atomicWriteJson(this.location.attemptsFile, nextAttempts);
			for (const entry of closed) await this.appendAudit({
				kind: "attempt/closed-stale",
				taskId: entry.taskId,
				attemptId: entry.attemptId,
				memberId: entry.memberId,
				status: entry.status,
				actor: "reconciler",
				at: Date.now(),
				revision: nextAttempts.revision
			});
			return { closed };
		});
	}
	/**
	* Record that a human wrote into this member's Session mid-attempt (B31). Idempotent:
	* the first observation wins, and the task revision at that moment is stored so that a
	* later formal restatement of the contract resolves the mark without a second write.
	*/
	async markHumanIntervention(attemptId, at) {
		if (!candidateId(attemptId) || !Number.isInteger(at)) fail("invalid human intervention request");
		return await withProcessLock(this.location.teamFile, async () => {
			const attempts = await this.readAttemptsIfPresentLocked();
			const index = attempts.attempts.findIndex((entry) => entry.id === attemptId);
			if (index < 0) fail(`unknown attempt: ${attemptId}`);
			const current = attempts.attempts[index];
			if (current.humanIntervenedAt !== void 0) return {
				attempt: clone(current),
				changed: false
			};
			const contractRevision = await this.contractRevisionLocked(current.taskId);
			const next = {
				...current,
				humanIntervenedAt: at,
				...contractRevision === void 0 ? {} : { humanIntervenedContractRevision: contractRevision },
				revision: current.revision + 1
			};
			const nextAttempts = {
				...attempts,
				revision: attempts.revision + 1,
				attempts: attempts.attempts.map((entry) => entry.id === attemptId ? next : entry)
			};
			await atomicWriteJson(this.location.attemptsFile, nextAttempts);
			await this.appendAudit({
				kind: "attempt/human-intervened",
				taskId: current.taskId,
				attemptId,
				memberId: current.memberId,
				at,
				actor: "reconciler",
				revision: nextAttempts.revision
			});
			return {
				attempt: clone(next),
				changed: true
			};
		});
	}
	async contractRevisionLocked(taskId) {
		const task = (await this.readTasksIfPresentLocked()).tasks.find((entry) => entry.id === taskId);
		return task === void 0 ? void 0 : task.contractRevision ?? 0;
	}
	async submitTask(request) {
		if (!candidateId(request.taskId) || request.memberId.length === 0 || request.sessionId.length === 0 || !Number.isInteger(request.bindingGeneration)) fail("invalid submission request");
		if (typeof request.summary !== "string" || request.summary.trim().length === 0) fail("submission summary must be non-empty");
		return withProcessLock(this.location.teamFile, async () => {
			const tasks = await this.readTasksIfPresentLocked();
			const task = tasks.tasks.find((entry) => entry.id === request.taskId);
			if (task === void 0) fail(`task not found: ${request.taskId}`);
			if (task.assignee !== request.memberId) fail("only the task assignee may submit work");
			if (task.status !== "claimed" && task.status !== "in_progress") fail(`task is not claimable for submission; current status is ${task.status}`);
			const attempts = await this.readAttemptsIfPresentLocked();
			const attempt = task.activeAttemptId === void 0 ? void 0 : attempts.attempts.find((entry) => entry.id === task.activeAttemptId && entry.status === "active");
			if (attempt === void 0 || attempt.memberId !== request.memberId || attempt.sessionId !== request.sessionId || attempt.bindingGeneration !== request.bindingGeneration) fail("submission requires the active attempt binding");
			const artifact = await this.freezeArtifact(request.artifact);
			const submissions = await this.readSubmissionsIfPresentLocked();
			const previous = submissions.submissions.filter((entry) => entry.taskId === task.id).sort((left, right) => left.createdAt - right.createdAt).at(-1);
			const lastRound = (await this.readReviewsIfPresentLocked()).rounds.filter((entry) => entry.taskId === task.id).sort((left, right) => left.round - right.round).at(-1);
			if (previous !== void 0 && lastRound?.verdict === "needs_revision") {
				if (previous.artifact.type === "report" && artifact.type === "report" ? previous.artifact.bodyDigest === artifact.bodyDigest : previous.artifact.type === "files" && artifact.type === "files" ? previous.artifact.manifestDigest === artifact.manifestDigest : false) fail("this submission is identical to the one the reviewer sent back; change something and say what, or escalate to the lead instead of spending another round");
			}
			const now = Date.now();
			const scope = await this.checkScope(task, tasks.tasks, attempts.attempts, artifact, attempt);
			let git;
			if (this.git !== void 0 && await this.mode() === "git" && CODING_KINDS.has(task.kind)) {
				if (attempt.gitBase === void 0) fail("the attempt has no recorded Git base; the submission cannot be frozen for review");
				const commitPaths = artifact.type === "files" ? artifact.paths : (scope?.changed ?? []).filter((entry) => !(scope?.unexpected ?? []).includes(entry));
				if (commitPaths.length === 0) fail("nothing changed under the declaration and the submission names no files; there is nothing to review");
				let base = {
					ref: attempt.gitBase.ref,
					sha: attempt.gitBase.baseTipSha
				};
				let rebasedFrom;
				const tip = await this.git.tip(this.workspacePath, base.ref).catch(() => void 0);
				if (tip !== void 0 && tip !== base.sha) {
					const moved = await this.git.changedBetween(this.workspacePath, base.sha, tip).catch(() => void 0);
					if (moved === void 0 || moved.some((entry) => {
						const path = normalizeScopePath(entry) ?? entry;
						return commitPaths.some((target) => scopesIntersect(literalPrefix(target), path));
					})) fail(`the base moved since this attempt started (${base.ref} is at ${tip}, the attempt began at ${base.sha}) and the commits in between touch the same paths; ask the lead to re-plan this task rather than review work that cannot land`);
					rebasedFrom = base.sha;
					base = {
						ref: base.ref,
						sha: tip
					};
				}
				const member = (await this.readTeamLocked()).members.find((entry) => entry.memberId === attempt.memberId);
				const message = [
					`${task.id}: ${task.title}`,
					"",
					request.summary.trim(),
					"",
					`Attempt: ${attempt.id} (generation ${attempt.generation})`,
					`Member: ${attempt.memberId}`
				].join("\n");
				const built = await this.git.commit(this.workspacePath, base, {
					paths: commitPaths,
					message,
					author: {
						name: member?.displayName ?? attempt.memberId,
						email: `${attempt.memberId}@live-teams.local`
					}
				});
				if (built === void 0) fail("the changed paths could not be frozen into a commit; nothing was recorded");
				git = {
					baseRef: base.ref,
					baseTipSha: base.sha,
					...rebasedFrom === void 0 ? {} : { rebasedFrom },
					headSha: built.headSha,
					commitPaths: [...built.commitPaths],
					...built.mergeBaseSha === void 0 ? {} : { mergeBaseSha: built.mergeBaseSha }
				};
				if (!await this.git.pin(this.workspacePath, `refs/live-teams/${task.id}/${submissionGitRefSuffix(attempt.generation, git.headSha)}`, git.headSha).catch(() => false)) fail("the reviewed commit could not be pinned in the repository; nothing was recorded");
			}
			if (git !== void 0 && scope !== void 0) scope.committed = [...git.commitPaths];
			const submission = {
				id: `submission-${randomUUID()}`,
				taskId: task.id,
				attemptId: attempt.id,
				attemptGeneration: attempt.generation,
				artifact,
				...git === void 0 ? {} : { git },
				summary: request.summary,
				checks: request.checks.map(validateCheck),
				...scope === void 0 ? {} : { scope },
				createdAt: now,
				revision: submissions.revision + 1
			};
			const nextSubmissions = {
				...submissions,
				schemaVersion: 1,
				revision: submissions.revision + 1,
				submissions: [...submissions.submissions, submission]
			};
			const nextTask = {
				...task,
				latestSubmissionId: submission.id,
				...task.route?.type === "report" ? { status: "waiting" } : {},
				updatedAt: now,
				revision: task.revision + 1
			};
			const nextTasks = {
				...tasks,
				revision: tasks.revision + 1,
				tasks: tasks.tasks.map((entry) => entry.id === task.id ? nextTask : entry)
			};
			await atomicWriteJson(this.location.submissionsFile, nextSubmissions);
			try {
				await atomicWriteJson(this.location.file, nextTasks);
			} catch (error) {
				await atomicWriteJson(this.location.submissionsFile, submissions);
				throw error;
			}
			await this.appendAudit({
				kind: "submission/created",
				taskId: task.id,
				submissionId: submission.id,
				attemptId: attempt.id,
				actor: request.memberId,
				at: now,
				revision: nextSubmissions.revision
			});
			if (scope?.state === "violation") await this.appendAudit({
				kind: "submission/scope-violation",
				taskId: task.id,
				submissionId: submission.id,
				attemptId: attempt.id,
				declared: scope.declared,
				unexpected: scope.unexpected ?? [],
				actor: request.memberId,
				at: now,
				revision: submissions.revision + 1
			});
			if (scope?.state === "shared-tree") await this.appendAudit({
				kind: "submission/scope-shared-tree",
				taskId: task.id,
				submissionId: submission.id,
				attemptId: attempt.id,
				declared: scope.declared,
				unexpected: scope.unexpected ?? [],
				sharedTree: scope.sharedTree ?? [],
				actor: request.memberId,
				at: now,
				revision: submissions.revision + 1
			});
			return { submission: clone(submission) };
		});
	}
	async acceptTask(request) {
		if (!candidateId(request.taskId) || request.actor.length === 0) fail("invalid accept request");
		if (request.note !== void 0 && typeof request.note !== "string") fail("acceptance note must be a string");
		let closing;
		const result = await withProcessLock(this.location.teamFile, async () => {
			const tasks = await this.readTasksIfPresentLocked();
			const task = tasks.tasks.find((entry) => entry.id === request.taskId);
			if (task === void 0) fail(`task not found: ${request.taskId}`);
			const team = await this.readTeamLocked();
			if (!isLeadOrHuman(team, request.actor)) fail(`only the lead may accept tasks; ask ${leadMemberIdForMessage(team)}`);
			if (task.status === "completed") fail("task is already completed");
			if (task.archivedPath !== void 0) fail("task is already archived");
			if (task.status !== "waiting" && task.status !== "needs_human") fail(`task cannot be accepted in status ${task.status}`);
			const attempts = await this.readAttemptsIfPresentLocked();
			const activeAttempt = task.activeAttemptId === void 0 ? void 0 : attempts.attempts.find((entry) => entry.id === task.activeAttemptId && entry.status === "active");
			if (activeAttempt === void 0) fail("task has no active attempt");
			if (task.assignee === void 0 || activeAttempt.memberId !== task.assignee) fail("task has no assignee attempt");
			const now = Date.now();
			const accepted = (await this.readSubmissionsIfPresentLocked()).submissions.find((entry) => entry.id === task.latestSubmissionId);
			const afterIntegration = accepted === void 0 ? task : await this.integrateSubmission(accepted, task);
			const currentTask = afterIntegration.integrationPending === void 0 ? afterIntegration : {
				...afterIntegration,
				integrationPending: void 0
			};
			const archivedPath = path.join("archive", `${now}-${task.id}.md`);
			const archiveTarget = path.join(this.location.directory, archivedPath);
			const sourcePath = this.documentPath(task.id);
			const document = await promises.readFile(sourcePath);
			if (await fileExists(archiveTarget)) fail("archive target already exists");
			const { integrationPending: _finished, ...settled } = currentTask;
			const nextTask = {
				...settled,
				status: "completed",
				...task.latestSubmissionId === void 0 ? {} : { acceptedSubmissionId: task.latestSubmissionId },
				archivedPath,
				contractRevision: (task.contractRevision ?? 0) + 1,
				updatedAt: now,
				revision: currentTask.revision + 1
			};
			const nextAttempts = {
				...attempts,
				schemaVersion: 1,
				revision: attempts.revision + 1,
				attempts: attempts.attempts.map((entry) => entry.id === activeAttempt.id ? {
					...entry,
					status: "completed",
					revision: entry.revision + 1
				} : entry)
			};
			const nextTasks = {
				...tasks,
				schemaVersion: 1,
				revision: tasks.revision + 1,
				tasks: tasks.tasks.map((entry) => entry.id === task.id ? nextTask : entry)
			};
			try {
				await atomicWrite(archiveTarget, document);
				await atomicWriteJson(this.location.attemptsFile, nextAttempts);
				await atomicWriteJson(this.location.file, nextTasks);
				await promises.unlink(sourcePath);
			} catch (error) {
				await atomicWriteJson(this.location.file, tasks).catch(() => void 0);
				await atomicWriteJson(this.location.attemptsFile, attempts).catch(() => void 0);
				await promises.unlink(archiveTarget).catch(() => void 0);
				await atomicWrite(sourcePath, document).catch(() => void 0);
				throw error;
			}
			await this.appendAudit({
				kind: "task/accepted",
				taskId: task.id,
				actor: request.actor,
				acceptedSubmissionId: nextTask.acceptedSubmissionId,
				archivedPath,
				...request.note === void 0 ? {} : { note: request.note },
				at: now,
				revision: nextTasks.revision
			});
			await this.appendAudit({
				kind: "task/archived",
				taskId: task.id,
				actor: request.actor,
				archivedPath,
				at: now,
				revision: nextTasks.revision
			});
			closing = {
				assignee: activeAttempt.memberId,
				taskId: task.id,
				...request.note === void 0 ? {} : { note: request.note }
			};
			return {
				task: clone(nextTask),
				archivedPath
			};
		});
		if (closing !== void 0) try {
			await this.deliverClosing?.(closing);
		} catch {}
		return result;
	}
	async reviseTask(request) {
		if (!candidateId(request.taskId) || request.actor.length === 0) fail("invalid revise request");
		if (typeof request.instructions !== "string" || request.instructions.trim().length === 0) fail("revision instructions must be non-empty");
		const instructions = request.instructions.trim();
		let direction;
		const result = await withProcessLock(this.location.teamFile, async () => {
			const tasks = await this.readTasksIfPresentLocked();
			const task = tasks.tasks.find((entry) => entry.id === request.taskId);
			if (task === void 0) fail(`task not found: ${request.taskId}`);
			const team = await this.readTeamLocked();
			if (!isLeadOrHuman(team, request.actor)) fail(`only the lead may revise tasks; ask ${leadMemberIdForMessage(team)}`);
			if (task.status !== "waiting" && task.status !== "needs_human") fail(`task cannot be revised in status ${task.status}`);
			if (task.assignee === void 0) fail("task has no assignee");
			const attempts = await this.readAttemptsIfPresentLocked();
			const activeAttempt = task.activeAttemptId === void 0 ? void 0 : attempts.attempts.find((entry) => entry.id === task.activeAttemptId && entry.status === "active");
			if (activeAttempt === void 0 || activeAttempt.memberId !== task.assignee) fail("task has no active attempt");
			const now = Date.now();
			const nextTask = {
				...task,
				status: "in_progress",
				contractRevision: (task.contractRevision ?? 0) + 1,
				updatedAt: now,
				revision: task.revision + 1
			};
			const nextTasks = {
				...tasks,
				schemaVersion: 1,
				revision: tasks.revision + 1,
				tasks: tasks.tasks.map((entry) => entry.id === task.id ? nextTask : entry)
			};
			await atomicWriteJson(this.location.file, nextTasks);
			await this.appendAudit({
				kind: "task/revised",
				taskId: task.id,
				actor: request.actor,
				instructions,
				at: now,
				revision: nextTasks.revision
			});
			direction = {
				assignee: task.assignee,
				taskId: task.id,
				instructions
			};
			return { task: clone(nextTask) };
		});
		if (direction !== void 0) try {
			await this.deliverDirection?.(direction);
		} catch {}
		return result;
	}
	async reviewTask(request) {
		if (!candidateId(request.taskId) || !candidateId(request.submissionId) || request.reviewerMemberId.length === 0 || !REVIEW_VERDICTS.includes(request.verdict)) fail("invalid review request");
		let escalation;
		const result = await withProcessLock(this.location.teamFile, async () => {
			const tasks = await this.readTasksIfPresentLocked();
			const task = tasks.tasks.find((entry) => entry.id === request.taskId);
			if (task === void 0) fail(`task not found: ${request.taskId}`);
			if (task.status === "completed" || task.status === "waiting" || task.status === "cancelled" || task.status === "failed") fail(`task cannot be reviewed in status ${task.status}`);
			if (task.route?.type !== "review" || task.route.reviewer !== request.reviewerMemberId) fail("only the task review-route member may review it");
			if (task.assignee === request.reviewerMemberId) fail("the assignee cannot review their own work");
			if (task.latestSubmissionId !== request.submissionId) fail("review must target the latest submission");
			const attempts = await this.readAttemptsIfPresentLocked();
			const submission = (await this.readSubmissionsIfPresentLocked()).submissions.find((entry) => entry.id === request.submissionId && entry.taskId === task.id);
			if (submission === void 0) fail("submission not found for task");
			const authoring = attempts.attempts.find((entry) => entry.id === submission.attemptId);
			if (authoring === void 0 || authoring.generation !== submission.attemptGeneration) fail("submission was produced by a superseded attempt");
			const reviews = await this.readReviewsIfPresentLocked();
			if (reviews.rounds.some((entry) => entry.submissionId === submission.id)) fail("submission already has a terminal review");
			const findings = (request.findings ?? []).map(validateFinding);
			const evidence = (request.evidence ?? []).map(validateCheck);
			if (request.verdict === "pass" && findings.some((finding) => finding.severity === "blocker" || finding.severity === "high")) fail("PASS is refused while blocker or high findings remain unresolved");
			if (request.verdict === "pass" && evidence.length === 0) fail("PASS needs at least one recorded check: run the verification and record the command with its output, so the verdict can be reproduced later");
			const priorRounds = reviews.rounds.filter((entry) => entry.taskId === task.id);
			const roundNumber = priorRounds.length + 1;
			if (request.verdict === "needs_revision" && priorRounds.filter((entry) => entry.verdict === "needs_revision").length >= task.roundLimit) fail(`round limit ${task.roundLimit} reached; escalate to the lead instead`);
			const now = Date.now();
			const round = {
				id: `review-${randomUUID()}`,
				taskId: task.id,
				submissionId: submission.id,
				reviewerMemberId: request.reviewerMemberId,
				round: roundNumber,
				verdict: request.verdict,
				findings,
				evidence,
				createdAt: now,
				revision: reviews.revision + 1
			};
			const nextReviews = {
				...reviews,
				schemaVersion: 1,
				revision: reviews.revision + 1,
				rounds: [...reviews.rounds, round]
			};
			const reviewedTask = request.verdict === "pass" ? await this.integrateSubmission(submission, task) : task;
			const { integrationPending: _pendingDrop, ...reviewedSettled } = reviewedTask;
			let nextTask = {
				...reviewedSettled,
				updatedAt: now,
				revision: reviewedTask.revision + 1
			};
			if (request.verdict === "pass") nextTask = {
				...nextTask,
				acceptedSubmissionId: submission.id,
				status: "completed",
				contractRevision: (task.contractRevision ?? 0) + 1
			};
			else if (request.verdict === "escalate") nextTask = {
				...nextTask,
				status: "waiting"
			};
			let archivedPath;
			if (request.verdict === "pass" && task.archivedPath === void 0) {
				archivedPath = path.join("archive", `${now}-${task.id}.md`);
				const target = path.join(this.location.directory, archivedPath);
				if (await fileExists(target)) fail("archive target already exists");
				await atomicWrite(target, await promises.readFile(this.documentPath(task.id)));
				nextTask = {
					...nextTask,
					archivedPath
				};
			}
			const closedAttempts = request.verdict === "pass" && task.activeAttemptId !== void 0 ? {
				...attempts,
				schemaVersion: 1,
				revision: attempts.revision + 1,
				attempts: attempts.attempts.map((entry) => entry.id === task.activeAttemptId && entry.status === "active" ? {
					...entry,
					status: "completed",
					revision: entry.revision + 1
				} : entry)
			} : void 0;
			await atomicWriteJson(this.location.reviewsFile, nextReviews);
			if (closedAttempts !== void 0) await atomicWriteJson(this.location.attemptsFile, closedAttempts);
			try {
				await atomicWriteJson(this.location.file, {
					...tasks,
					revision: tasks.revision + 1,
					tasks: tasks.tasks.map((entry) => entry.id === task.id ? nextTask : entry)
				});
			} catch (error) {
				if (archivedPath !== void 0) await promises.unlink(archivedPath).catch(() => void 0);
				await atomicWriteJson(this.location.reviewsFile, reviews);
				throw error;
			}
			if (archivedPath !== void 0) {
				await promises.unlink(this.documentPath(task.id)).catch(() => void 0);
				await this.appendAudit({
					kind: "task/archived",
					taskId: task.id,
					actor: request.reviewerMemberId,
					archivedPath,
					at: now,
					revision: tasks.revision + 1
				});
			}
			await this.appendAudit({
				kind: "review/round",
				taskId: task.id,
				submissionId: submission.id,
				reviewerMemberId: request.reviewerMemberId,
				verdict: request.verdict,
				round: round.round,
				at: now,
				revision: nextReviews.revision
			});
			if (request.verdict === "pass") await this.appendAudit({
				kind: "task/accepted",
				taskId: task.id,
				submissionId: submission.id,
				actor: request.reviewerMemberId,
				at: now,
				revision: tasks.revision + 1
			});
			if (request.verdict === "escalate") {
				const leadMemberId = leadMemberIdForMessage(await this.readTeamLocked());
				const problem = findings.map((finding) => finding.problem).join("; ") || "reviewer escalated without a finding";
				const tried = findings.map((finding) => finding.requiredFix).join("; ") || "review evidence recorded";
				await this.appendAudit({
					kind: "review/escalated",
					taskId: task.id,
					submissionId: submission.id,
					reviewerMemberId: request.reviewerMemberId,
					leadMemberId,
					problem,
					tried,
					at: now,
					revision: nextReviews.revision
				});
				escalation = {
					leadMemberId,
					taskId: task.id,
					submissionId: submission.id,
					round,
					reviewerMemberId: request.reviewerMemberId,
					problem,
					tried
				};
			}
			return {
				round: clone(round),
				task: clone(nextTask)
			};
		});
		if (escalation !== void 0) await this.deliverEscalation?.(escalation);
		return result;
	}
	/**
	* What the declaration was worth at submission time. Only a writing task that
	* declared paths is checked: with nothing declared there is nothing to violate, and
	* an unobservable workspace is reported as `unchecked` rather than as clean (B30).
	*/
	/**
	* Integrate a submission's commit into its base, refusing when the base moved.
	*
	* Nothing is checked out and nothing is merged: the working tree already holds the work, so
	* integration is one compare-and-swap ref update. `STALE_BASE` is a refusal — nothing is written,
	* and the decision has to be made again against the current base (ADR 0006).
	*/
	async integrateSubmission(submission, task) {
		const git = submission.git;
		if (git === void 0 || this.git === void 0) return task;
		const current = await this.writeIntegrationPendingLocked(task, git) ?? task;
		const outcome = await this.git.integrate(this.workspacePath, git.baseRef, git.headSha, git.baseTipSha, git.commitPaths).catch(() => "stale");
		if (outcome !== "integrated") await this.clearIntegrationPendingLocked(current);
		if (outcome === "index-failed") throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, `the base is at the reviewed commit ${String(git.headSha).slice(0, 12)} but the index could not be moved with it; retry the acceptance. If it persists, run: git reset -- ${git.commitPaths.join(" ")}`, { auditDetail: "index repair failed" });
		if (outcome === "stale") {
			const tip = await this.git.tip(this.workspacePath, git.baseRef).catch(() => void 0);
			throw new LiveTeamsError(ERROR_CODES.STALE_BASE, `the base moved since the review: ${git.baseRef} is at ${tip ?? "an unreadable tip"}, the reviewed base was ${git.baseTipSha}. Refresh the decision against the current base before accepting ${task.id}`, { auditDetail: "stale base" });
		}
		return current;
	}
	/**
	* Record the intent to integrate, and return the task as it now stands.
	*
	* `Locked` on purpose: the callers (both acceptance paths) already hold the team lock, and taking it
	* again deadlocks the process — which is exactly what the git suite reported, as a thirty-second
	* hang rather than a failure.
	*/
	async writeIntegrationPendingLocked(task, git) {
		const state = await this.readOrCreateLocked();
		const current = state.tasks.find((entry) => entry.id === task.id);
		if (current === void 0 || current.integrationPending !== void 0) return current;
		const next = {
			...current,
			integrationPending: {
				baseRef: git.baseRef,
				headSha: git.headSha,
				baseTipSha: git.baseTipSha,
				at: Date.now()
			},
			revision: current.revision + 1
		};
		await atomicWriteJson(this.location.file, {
			...state,
			revision: state.revision + 1,
			tasks: state.tasks.map((entry) => entry.id === task.id ? next : entry)
		});
		return next;
	}
	/** Forget the intent: either the integration did not happen, or the caller is about to finish it. */
	async clearIntegrationPendingLocked(task) {
		if (task.integrationPending === void 0) return;
		const state = await this.readOrCreateLocked();
		const current = state.tasks.find((entry) => entry.id === task.id);
		if (current === void 0 || current.integrationPending === void 0) return;
		const { integrationPending: _dropped, ...withoutPending } = current;
		await atomicWriteJson(this.location.file, {
			...state,
			revision: state.revision + 1,
			tasks: state.tasks.map((entry) => entry.id === task.id ? {
				...withoutPending,
				revision: current.revision + 1
			} : entry)
		});
	}
	/**
	* Where an archived document lives. New records store the path relative to the team directory;
	* records written before that change hold an absolute path and are still honoured.
	*/
	archivedPathOf(archivedPath) {
		return path.isAbsolute(archivedPath) ? archivedPath : path.resolve(this.location.directory, archivedPath);
	}
	/**
	* Record that an active attempt is not moving, once. Idempotent by design: a second call with the
	* same reason is a no-op, so the reconciler may call it on every pass without filling the journal.
	* Returns `true` when this call was the one that recorded it.
	*/
	async markAttemptStalled(request) {
		return await withProcessLock(this.location.teamFile, async () => {
			const attempts = await this.readAttemptsIfPresentLocked();
			const attempt = attempts.attempts.find((entry) => entry.id === request.attemptId);
			if (attempt === void 0 || attempt.status !== "active") return false;
			if (attempt.stalled !== void 0) return false;
			const at = Date.now();
			const next = {
				...attempts,
				schemaVersion: 1,
				revision: attempts.revision + 1,
				attempts: attempts.attempts.map((entry) => entry.id === request.attemptId ? {
					...entry,
					stalled: {
						at,
						reason: request.reason,
						detail: request.detail
					},
					revision: entry.revision + 1
				} : entry)
			};
			await atomicWriteJson(this.location.attemptsFile, next);
			await this.appendAudit({
				kind: "attempt/stalled",
				taskId: attempt.taskId,
				attemptId: attempt.id,
				memberId: attempt.memberId,
				reason: request.reason,
				detail: request.detail,
				actor: request.actor,
				at,
				revision: next.revision
			});
			return true;
		});
	}
	/**
	* Keep a copy of submitted bytes, addressed by their digest. Returns the path relative to the team
	* directory, or `undefined` when the copy could not be written — a submission is never refused for
	* this, but it is then read back from the workspace and the drift check says so.
	*/
	async storeBlob(digest, bytes) {
		const relative = path.join("artifacts", "blobs", digest);
		const target = path.join(this.location.directory, relative);
		try {
			if (!await fileExists(target)) {
				await promises.mkdir(this.location.blobsDirectory, { recursive: true });
				await promises.writeFile(target, bytes);
			}
			return relative;
		} catch {
			return;
		}
	}
	/** The frozen bytes of a submission artifact, or `undefined` when no copy was kept. */
	async readBlob(blobPath) {
		const resolved = path.resolve(this.location.directory, blobPath);
		const root = path.resolve(this.location.directory);
		if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return void 0;
		try {
			return await promises.readFile(resolved);
		} catch {
			return;
		}
	}
	/**
	* Reconcile an integration that was interrupted: the marker is on the task, and the branch tells
	* the rest of the story. Reports once, and clears the marker only when nothing happened — a branch
	* that is already at the reviewed commit means the acceptance still has to be finished, and that is
	* a decision, not a cleanup.
	*/
	async reconcilePendingIntegrations(request) {
		return await withProcessLock(this.location.teamFile, async () => {
			const state = await this.readOrCreateLocked();
			const pending = state.tasks.filter((task) => task.integrationPending !== void 0 && task.integrationPending.reportedAt === void 0);
			if (pending.length === 0) return [];
			const reported = [];
			const now = Date.now();
			let tasks = state.tasks;
			for (const task of pending) {
				const marker = task.integrationPending;
				const tip = await request.tipOf(marker.baseRef).catch(() => void 0);
				const outcome = tip === marker.headSha ? "moved" : tip === marker.baseTipSha ? "untouched" : "elsewhere";
				const detail = outcome === "moved" ? `the branch ${marker.baseRef} is already at the reviewed commit ${marker.headSha.slice(0, 12)}, but the acceptance never finished; retry it` : outcome === "untouched" ? `the branch ${marker.baseRef} never moved; the acceptance can simply be retried` : `the branch ${marker.baseRef} is at ${tip ?? "an unreadable tip"}, which is neither the reviewed base nor the reviewed commit; a human has to decide`;
				const next = outcome === "untouched" ? (() => {
					const { integrationPending: _cleared, ...rest } = task;
					return {
						...rest,
						revision: task.revision + 1
					};
				})() : {
					...task,
					integrationPending: {
						...marker,
						reportedAt: now
					},
					revision: task.revision + 1
				};
				tasks = tasks.map((entry) => entry.id === task.id ? next : entry);
				await this.appendAudit({
					kind: "integration/pending",
					taskId: task.id,
					state: outcome,
					detail,
					actor: request.actor,
					at: now,
					revision: state.revision + 1
				});
				reported.push({
					taskId: task.id,
					state: outcome,
					detail
				});
			}
			await atomicWriteJson(this.location.file, {
				...state,
				revision: state.revision + 1,
				tasks
			});
			return reported;
		});
	}
	/**
	* Bring every state file this store owns forward to the current schema version.
	*
	* Reading tolerates an older version, but nothing brought it forward: a field added later stayed
	* missing until something happened to write the file again, and no record said the state had been
	* read at an older version. A state from the future is refused with both versions named.
	*
	* The file is copied before it is rewritten, and the migration is recorded in the journal: a
	* migration is the one operation that changes history, and it should be possible to say when it
	* happened and to go back.
	*/
	async migrate() {
		const migrations = this.migrations;
		const files = [];
		const targets = [
			{
				file: this.location.file,
				what: "task state",
				stamp: (state) => ({
					...state,
					schemaVersion: 1
				})
			},
			{
				file: this.location.attemptsFile,
				what: "attempts state",
				stamp: (state) => ({
					...state,
					schemaVersion: 1
				})
			},
			{
				file: this.location.submissionsFile,
				what: "submissions state",
				stamp: (state) => ({
					...state,
					schemaVersion: 1
				})
			},
			{
				file: this.location.reviewsFile,
				what: "reviews state",
				stamp: (state) => ({
					...state,
					schemaVersion: 1
				})
			}
		];
		return await withProcessLock(this.location.teamFile, async () => {
			for (const target of targets) {
				let raw;
				try {
					raw = JSON.parse(await promises.readFile(target.file, "utf8"));
				} catch {
					continue;
				}
				const state = objectRecord(raw);
				if (state === void 0) continue;
				const plan = planMigration(state.schemaVersion, 1, target.what, migrations);
				if (plan.kind === "future") throw plan.error;
				if (plan.kind === "current") continue;
				const backup = `${target.file}.v${plan.from}.bak`;
				await promises.copyFile(target.file, backup);
				const migrated = target.stamp(objectRecord(applyMigration(state, plan, migrations)) ?? state);
				await atomicWriteJson(target.file, migrated);
				await this.appendAudit({
					kind: "state/migrated",
					file: path.basename(target.file),
					from: plan.from,
					to: plan.to,
					backup: path.basename(backup),
					actor: "reconciler",
					at: Date.now()
				});
				files.push({
					file: path.basename(target.file),
					from: plan.from,
					to: plan.to,
					backup: path.basename(backup)
				});
			}
			return { files };
		});
	}
	/** B32: resolved once per store; the answer cannot change while a store lives. */
	async mode() {
		if (this.resolvedMode === void 0) {
			if (this.workspaceMode === void 0) this.resolvedMode = this.changedPaths === void 0 ? null : "git";
			else this.resolvedMode = await this.workspaceMode(this.workspacePath).catch(() => void 0) ?? null;
		}
		return this.resolvedMode ?? void 0;
	}
	async snapshotPathFor(attemptId) {
		return path.join(this.location.snapshotsDirectory, `${attemptId}.json`);
	}
	/** Take the fingerprint a `files`-mode submission will be compared against. */
	async takeSnapshot(attemptId) {
		if (await this.mode() !== "files" || this.snapshotTree === void 0) return;
		const snapshot = await this.snapshotTree(this.workspacePath).catch(() => void 0);
		if (snapshot === void 0) return;
		await promises.mkdir(this.location.snapshotsDirectory, { recursive: true });
		await atomicWriteJson(await this.snapshotPathFor(attemptId), snapshot).catch(() => void 0);
	}
	/** Delete fingerprints whose attempt is no longer running: garbage, not evidence. */
	async pruneSnapshots() {
		let names;
		try {
			names = await promises.readdir(this.location.snapshotsDirectory);
		} catch {
			return 0;
		}
		if (names.length === 0) return 0;
		const attempts = await this.readAttemptsIfPresentLocked();
		const live = new Set(attempts.attempts.filter((attempt) => attempt.status === "active").map((attempt) => attempt.id));
		let removed = 0;
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const attemptId = name.slice(0, -5);
			if (live.has(attemptId)) continue;
			await promises.unlink(path.join(this.location.snapshotsDirectory, name)).catch(() => void 0);
			removed += 1;
		}
		return removed;
	}
	async checkScope(task, tasks, attempts, artifact, attempt) {
		const declared = task.paths;
		if (declared === void 0 || declared.length === 0 || !CODING_KINDS.has(task.kind)) return void 0;
		const mode = await this.mode();
		if (mode === void 0) return {
			declared,
			state: "unchecked",
			reason: "unreadable"
		};
		let changed;
		if (mode === "git") {
			if (this.changedPaths === void 0) return {
				declared,
				state: "unchecked",
				reason: "unreadable",
				mode
			};
			try {
				changed = await this.changedPaths(this.workspacePath);
			} catch {
				changed = void 0;
			}
			if (changed === void 0) return {
				declared,
				state: "unchecked",
				reason: "unreadable",
				mode
			};
		} else {
			if (this.snapshotTree === void 0) return {
				declared,
				state: "unchecked",
				reason: "unreadable",
				mode
			};
			let before;
			try {
				before = JSON.parse(await promises.readFile(await this.snapshotPathFor(attempt.id), "utf8"));
			} catch {
				before = void 0;
			}
			if (before === void 0) return {
				declared,
				state: "unchecked",
				reason: "no-snapshot",
				mode
			};
			const after = await this.snapshotTree(this.workspacePath).catch(() => void 0);
			if (after === void 0) return {
				declared,
				state: "unchecked",
				reason: "too-many-files",
				mode
			};
			changed = diffSnapshots(before, after);
		}
		const ignored = [TEAM_ROOT, ...artifact.type === "report" ? [artifact.bodyRef] : []];
		const normalizedChanged = (changed ?? []).map((entry) => normalizeScopePath(entry)).filter((entry) => entry !== void 0).filter((entry) => !ignored.some((skip) => entry === skip || entry.startsWith(`${skip}/`)));
		const unexpected = outsideScope(normalizedChanged, declared);
		if (unexpected.length === 0) return {
			declared,
			changed: normalizedChanged,
			state: "clean",
			mode
		};
		const sharedTree = unexpected.filter((candidate) => attempts.some((other) => other.status === "active" && other.taskId !== task.id && (tasks.find((entry) => entry.id === other.taskId)?.paths ?? []).some((entry) => scopesIntersect(literalPrefix(entry), candidate))));
		return {
			declared,
			changed: normalizedChanged,
			unexpected,
			...sharedTree.length === 0 ? {} : { sharedTree },
			state: sharedTree.length === 0 ? "violation" : "shared-tree",
			mode
		};
	}
	async freezeArtifact(artifact) {
		if (artifact.type === "report") {
			if (typeof artifact.bodyRef !== "string" || artifact.bodyRef.length === 0) fail("report bodyRef must be non-empty");
			const reportPath = path.resolve(this.workspacePath, artifact.bodyRef);
			if (reportPath !== this.workspacePath && !reportPath.startsWith(`${this.workspacePath}${path.sep}`)) fail("report bodyRef must stay inside the workspace");
			const body = await promises.readFile(reportPath);
			const bodyDigest = createHash("sha256").update(body).digest("hex");
			const blobPath = await this.storeBlob(bodyDigest, body);
			return {
				type: "report",
				bodyRef: artifact.bodyRef,
				bodyDigest,
				...blobPath === void 0 ? {} : { blobPath }
			};
		}
		if (!Array.isArray(artifact.paths) || artifact.paths.length === 0 || !artifact.paths.every((entry) => typeof entry === "string" && entry.length > 0)) fail("files artifact paths must be non-empty");
		const normalized = artifact.paths.map((file) => {
			const absolute = path.resolve(this.workspacePath, file);
			if (absolute !== this.workspacePath && !absolute.startsWith(`${this.workspacePath}${path.sep}`)) fail("file artifact paths must stay inside the workspace");
			return {
				input: file,
				absolute,
				relative: path.relative(this.workspacePath, absolute)
			};
		});
		if (new Set(normalized.map((entry) => entry.relative)).size !== normalized.length) fail("file artifact paths must be unique");
		const entries = [];
		const blobs = [];
		for (const file of normalized) {
			let bytes;
			try {
				bytes = await promises.readFile(file.absolute);
			} catch {
				fail(`the file artifact names ${file.relative}, which is not on disk; a deletion is submitted as a report`);
			}
			const digest = createHash("sha256").update(bytes).digest("hex");
			entries.push({
				path: file.relative,
				digest
			});
			const blobPath = await this.storeBlob(digest, bytes);
			if (blobPath !== void 0) blobs.push({
				path: file.relative,
				digest,
				blobPath
			});
		}
		entries.sort((left, right) => left.path.localeCompare(right.path));
		return {
			type: "files",
			paths: entries.map((entry) => entry.path),
			manifestDigest: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
			...blobs.length === entries.length ? { blobs } : {}
		};
	}
	/**
	* Edit the contract of one task (B27).
	*
	* Only while nobody is working on it: an attempt is bound to the contract its
	* assignee is working from, and a human decision owns every later transition.
	*/
	async updateTask(request) {
		if (!candidateId(request.taskId) || request.actor.length === 0) fail("invalid update request");
		return withProcessLock(this.location.teamFile, async () => {
			const tasks = await this.readTasksIfPresentLocked();
			const task = tasks.tasks.find((entry) => entry.id === request.taskId);
			if (task === void 0) fail(`task not found: ${request.taskId}`);
			const team = await this.readTeamLocked();
			if (!isLeadOrHuman(team, request.actor)) fail(`only the lead may update tasks; ask ${leadMemberIdForMessage(team)}`);
			if (request.expectedRevision !== void 0 && request.expectedRevision !== tasks.revision) throw new LiveTeamsError(ERROR_CODES.REVISION_CONFLICT, `expected revision ${request.expectedRevision}, actual ${tasks.revision}`);
			if (task.status !== "draft" && task.status !== "ready") fail(`task cannot be updated in status ${task.status}; ${task.status === "waiting" || task.status === "needs_human" ? "a human revision owns that transition" : "only work nobody has started can be edited"}`);
			if ([
				"title",
				"kind",
				"assignee",
				"route",
				"acceptance",
				"checks",
				"why",
				"body",
				"roundLimit",
				"humanContact",
				"dependsOn",
				"paths"
			].filter((field) => request[field] !== void 0).length === 0) fail("nothing to change");
			const merged = {
				title: request.title ?? task.title,
				kind: request.kind ?? task.kind,
				assignee: request.assignee === void 0 ? task.assignee : request.assignee ?? void 0,
				route: request.route === void 0 ? task.route : request.route ?? void 0,
				humanContact: request.humanContact ?? task.humanContact ?? "none",
				acceptance: request.acceptance ?? task.acceptance,
				checks: request.checks ?? task.checks,
				why: request.why ?? task.why,
				body: request.body ?? task.body,
				roundLimit: request.roundLimit ?? task.roundLimit,
				dependsOn: request.dependsOn === void 0 ? task.dependsOn : request.dependsOn ?? void 0,
				paths: request.paths === void 0 ? task.paths : request.paths ?? void 0
			};
			const normalized = this.validateContract(merged, team, tasks.tasks, task.id);
			const comparable = (field, value) => JSON.stringify(field === "checks" ? value ?? [] : value ?? null);
			const changed = [
				"title",
				"kind",
				"assignee",
				"route",
				"humanContact",
				"acceptance",
				"checks",
				"why",
				"body",
				"roundLimit",
				"dependsOn",
				"paths"
			].filter((field) => comparable(field, task[field]) !== comparable(field, normalized[field]));
			if (changed.length === 0) fail("nothing to change; the contract already matches");
			const now = Date.now();
			const nextTask = {
				...task,
				title: normalized.title,
				kind: normalized.kind,
				status: normalized.status,
				acceptance: normalized.acceptance,
				roundLimit: normalized.roundLimit,
				humanContact: normalized.humanContact,
				contractRevision: (task.contractRevision ?? 0) + 1,
				updatedAt: now,
				revision: task.revision + 1
			};
			const optional = [
				["assignee", normalized.assignee],
				["route", normalized.route],
				["dependsOn", normalized.dependsOn],
				["why", normalized.why],
				["body", normalized.body],
				["checks", normalized.checks === void 0 || normalized.checks.length === 0 ? void 0 : normalized.checks],
				["paths", normalized.paths]
			];
			for (const [field, value] of optional) if (value === void 0) delete nextTask[field];
			else Object.assign(nextTask, { [field]: value });
			const nextTasks = {
				...tasks,
				schemaVersion: 1,
				revision: tasks.revision + 1,
				tasks: tasks.tasks.map((entry) => entry.id === task.id ? nextTask : entry)
			};
			const document = renderDocument(nextTask, team, { tasks: tasks.tasks });
			await atomicWrite(this.documentPath(task.id), document);
			try {
				await atomicWriteJson(this.location.file, nextTasks);
			} catch (error) {
				await atomicWrite(this.documentPath(task.id), renderDocument(task, team, { tasks: tasks.tasks })).catch(() => void 0);
				throw error;
			}
			await this.appendAudit({
				kind: "task/updated",
				taskId: task.id,
				actor: request.actor,
				fields: changed,
				at: now,
				revision: nextTasks.revision
			});
			return {
				task: clone(nextTask),
				document,
				changed
			};
		});
	}
	async claimTask(request) {
		if (!candidateId(request.taskId) || request.memberId.length === 0 || request.sessionId.length === 0 || !Number.isInteger(request.bindingGeneration)) fail("invalid claim request");
		return withProcessLock(this.location.teamFile, async () => {
			const tasks = await this.readTasksIfPresentLocked();
			const task = tasks.tasks.find((entry) => entry.id === request.taskId);
			if (task === void 0) fail(`task not found: ${request.taskId}`);
			const attempts = await this.readAttemptsIfPresentLocked();
			const existing = task.activeAttemptId === void 0 ? void 0 : attempts.attempts.find((entry) => entry.id === task.activeAttemptId);
			if (existing?.status === "active" && existing.memberId === request.memberId) return {
				task: clone(task),
				attempt: clone(existing)
			};
			if (task.assignee !== request.memberId) fail("only the task assignee may claim it");
			fenceMember((await this.readTeamLocked()).members.find((entry) => entry.memberId === request.memberId), request, request.memberId);
			if (task.status !== "ready") fail(`task is not ready; current status is ${task.status}`);
			const blockers = blockedBy(task, tasks.tasks);
			if (blockers.length > 0) {
				const first = blockers[0];
				fail(`task is blocked by ${first.id} "${first.title}" (${first.status})${blockers.length > 1 ? ` and ${blockers.length - 1} more` : ""}`);
			}
			if (existing?.status === "active") fail("task already has an active attempt owned by another member");
			if (attempts.attempts.some((entry) => entry.memberId === request.memberId && entry.status === "active")) fail("member already has an active attempt");
			const now = Date.now();
			const priorGenerations = attempts.attempts.filter((entry) => entry.taskId === task.id).map((entry) => entry.generation);
			const generation = (priorGenerations.length === 0 ? 0 : Math.max(...priorGenerations)) + 1;
			const attempt = {
				id: `attempt-${randomUUID()}`,
				taskId: task.id,
				memberId: request.memberId,
				sessionId: request.sessionId,
				bindingGeneration: request.bindingGeneration,
				generation,
				status: "active",
				startedAt: now,
				revision: attempts.revision + 1
			};
			const nextTask = {
				...task,
				status: "claimed",
				activeAttemptId: attempt.id,
				updatedAt: now,
				revision: task.revision + 1
			};
			const nextTasks = {
				...tasks,
				revision: tasks.revision + 1,
				tasks: tasks.tasks.map((entry) => entry.id === task.id ? nextTask : entry)
			};
			const nextAttempts = {
				...attempts,
				revision: attempts.revision + 1,
				attempts: [...attempts.attempts, attempt]
			};
			await atomicWriteJson(this.location.file, nextTasks);
			try {
				await atomicWriteJson(this.location.attemptsFile, nextAttempts);
			} catch (error) {
				await atomicWriteJson(this.location.file, tasks);
				throw error;
			}
			await this.takeSnapshot(attempt.id);
			if (this.git !== void 0 && await this.mode() === "git") {
				const base = await this.git.base(this.workspacePath).catch(() => void 0);
				if (base !== void 0) {
					const current = await this.readAttemptsIfPresentLocked();
					const withBase = {
						...current,
						schemaVersion: 1,
						revision: current.revision + 1,
						attempts: current.attempts.map((entry) => entry.id === attempt.id ? {
							...entry,
							gitBase: {
								ref: base.ref,
								baseTipSha: base.sha
							},
							revision: entry.revision + 1
						} : entry)
					};
					await atomicWriteJson(this.location.attemptsFile, withBase);
				}
			}
			await this.appendAudit({
				kind: "task/claimed",
				taskId: task.id,
				memberId: request.memberId,
				attemptId: attempt.id,
				actor: request.memberId,
				at: now,
				revision: nextTasks.revision
			});
			await this.appendAudit({
				kind: "attempt/started",
				taskId: task.id,
				memberId: request.memberId,
				attemptId: attempt.id,
				actor: request.memberId,
				at: now,
				revision: nextAttempts.revision
			});
			return {
				task: clone(nextTask),
				attempt: clone(attempt)
			};
		});
	}
	/**
	* Take work away from its current attempt (B28, ADR 0005).
	*
	* The order matters and is the contract: the capability is invalidated and made
	* durable *before* the session is asked to stop, so a session that keeps running
	* cannot write anything; and `revoked` is only ever reported once quiescence has
	* actually been observed. When it has not, the attempt stays `revoking` and the
	* task goes to the human rather than claiming a stop that did not happen.
	*/
	async revokeTask(request) {
		if (!candidateId(request.taskId) || request.actor.length === 0) fail("invalid revoke request");
		if (typeof request.reason !== "string" || request.reason.trim().length === 0) fail("revocation reason must be non-empty");
		const reason = request.reason.trim();
		const { task, attempt } = await withProcessLock(this.location.teamFile, async () => {
			const tasks = await this.readTasksIfPresentLocked();
			const task = tasks.tasks.find((entry) => entry.id === request.taskId);
			if (task === void 0) fail(`task not found: ${request.taskId}`);
			const team = await this.readTeamLocked();
			if (!isLeadOrHuman(team, request.actor)) fail(`only the lead may revoke tasks; ask ${leadMemberIdForMessage(team)}`);
			if (request.expectedRevision !== void 0 && request.expectedRevision !== tasks.revision) throw new LiveTeamsError(ERROR_CODES.REVISION_CONFLICT, `expected revision ${request.expectedRevision}, actual ${tasks.revision}`);
			if (task.status !== "claimed" && task.status !== "in_progress") fail(`task cannot be revoked in status ${task.status}`);
			const attempts = await this.readAttemptsIfPresentLocked();
			const bound = task.activeAttemptId === void 0 ? void 0 : attempts.attempts.find((entry) => entry.id === task.activeAttemptId);
			const attempt = bound?.status === "active" || bound?.status === "revoking" ? bound : void 0;
			if (attempt === void 0) fail("task has no active attempt to revoke");
			if (request.nextAssignee !== void 0) {
				if (memberById(team, request.nextAssignee) === void 0) fail(`assignee is not a current team member: ${request.nextAssignee}`);
				if (task.route !== void 0) validateRoute(task.route, team, request.nextAssignee);
			}
			const now = Date.now();
			const revoking = {
				...attempt,
				status: "revoking",
				revision: attempt.revision + 1
			};
			const nextAttempts = {
				...attempts,
				schemaVersion: 1,
				revision: attempts.revision + 1,
				attempts: attempts.attempts.map((entry) => entry.id === attempt.id ? revoking : entry)
			};
			await atomicWriteJson(this.location.attemptsFile, nextAttempts);
			if (attempt.status === "active") await this.appendAudit({
				kind: "attempt/revoking",
				taskId: task.id,
				attemptId: attempt.id,
				memberId: attempt.memberId,
				reason,
				actor: request.actor,
				at: now,
				revision: nextAttempts.revision
			});
			return {
				task,
				attempt: revoking
			};
		});
		if (this.interruptSession === void 0 || this.awaitQuiescence === void 0) return this.settleRevocation(task, attempt, false, request, reason);
		try {
			await this.interruptSession(attempt.sessionId, reason);
		} catch {}
		const quiesced = await this.awaitQuiescence(attempt.sessionId, this.quiescenceTimeoutMs);
		return this.settleRevocation(task, attempt, quiesced, request, reason);
	}
	/** Mark the settled outcome: revoked and re-owned, or escalated to the human. */
	async settleRevocation(task, attempt, quiesced, request, reason) {
		return withProcessLock(this.location.teamFile, async () => {
			const tasks = await this.readTasksIfPresentLocked();
			const current = tasks.tasks.find((entry) => entry.id === task.id);
			if (current === void 0) fail(`task not found: ${task.id}`);
			const attempts = await this.readAttemptsIfPresentLocked();
			const stored = attempts.attempts.find((entry) => entry.id === attempt.id);
			if (stored === void 0) fail(`attempt not found: ${attempt.id}`);
			const team = await this.readTeamLocked();
			const now = Date.now();
			if (!quiesced) {
				const escalated = {
					...current,
					status: "needs_human",
					updatedAt: now,
					revision: current.revision + 1
				};
				const nextTasks = {
					...tasks,
					schemaVersion: 1,
					revision: tasks.revision + 1,
					tasks: tasks.tasks.map((entry) => entry.id === current.id ? escalated : entry)
				};
				await atomicWriteJson(this.location.file, nextTasks);
				await this.appendAudit({
					kind: "attempt/revoke-timeout",
					taskId: current.id,
					attemptId: attempt.id,
					memberId: attempt.memberId,
					reason,
					actor: request.actor,
					at: now,
					revision: nextTasks.revision
				});
				return {
					task: clone(escalated),
					attempt: clone(stored),
					quiesced: false,
					reassigned: false
				};
			}
			const revoked = {
				...stored,
				status: "revoked",
				revision: stored.revision + 1
			};
			const nextAttempts = {
				...attempts,
				schemaVersion: 1,
				revision: attempts.revision + 1,
				attempts: attempts.attempts.map((entry) => entry.id === stored.id ? revoked : entry)
			};
			const candidate = request.nextAssignee ?? current.assignee;
			const nextAssignee = candidate !== void 0 && memberById(team, candidate) !== void 0 ? candidate : void 0;
			const reassigned = nextAssignee !== void 0 && nextAssignee !== current.assignee;
			const ready = {
				...current,
				status: nextAssignee === void 0 || current.route === void 0 || current.acceptance.length === 0 ? "draft" : "ready",
				updatedAt: now,
				revision: current.revision + 1
			};
			if (nextAssignee === void 0) delete ready.assignee;
			else ready.assignee = nextAssignee;
			delete ready.activeAttemptId;
			const nextTasks = {
				...tasks,
				schemaVersion: 1,
				revision: tasks.revision + 1,
				tasks: tasks.tasks.map((entry) => entry.id === current.id ? ready : entry)
			};
			await atomicWriteJson(this.location.attemptsFile, nextAttempts);
			await atomicWriteJson(this.location.file, nextTasks);
			await this.appendAudit({
				kind: "attempt/revoked",
				taskId: current.id,
				attemptId: stored.id,
				memberId: stored.memberId,
				reason,
				quiesced,
				actor: request.actor,
				at: now,
				revision: nextAttempts.revision
			});
			if (reassigned) await this.appendAudit({
				kind: "task/reassigned",
				taskId: current.id,
				from: current.assignee,
				to: nextAssignee,
				actor: request.actor,
				at: now,
				revision: nextTasks.revision
			});
			return {
				task: clone(ready),
				attempt: clone(revoked),
				quiesced: true,
				reassigned
			};
		});
	}
	async acknowledgeTask(request) {
		if (!candidateId(request.taskId) || request.memberId.length === 0) fail("invalid acknowledge request");
		return withProcessLock(this.location.teamFile, async () => {
			const tasks = await this.readTasksIfPresentLocked();
			const task = tasks.tasks.find((entry) => entry.id === request.taskId);
			if (task === void 0) fail(`task not found: ${request.taskId}`);
			if (task.assignee !== request.memberId) fail("only the task assignee may acknowledge it");
			fenceMember((await this.readTeamLocked()).members.find((entry) => entry.memberId === request.memberId), request, request.memberId);
			if (task.status === "in_progress") return { task: clone(task) };
			if (task.status !== "claimed") fail(`task is not claimed; current status is ${task.status}`);
			const attempts = await this.readAttemptsIfPresentLocked();
			const attempt = task.activeAttemptId === void 0 ? void 0 : attempts.attempts.find((entry) => entry.id === task.activeAttemptId && entry.status === "active");
			if (attempt === void 0 || attempt.memberId !== request.memberId) fail("task has no active attempt for this member");
			const now = Date.now();
			const nextTask = {
				...task,
				status: "in_progress",
				updatedAt: now,
				revision: task.revision + 1
			};
			const nextTasks = {
				...tasks,
				revision: tasks.revision + 1,
				tasks: tasks.tasks.map((entry) => entry.id === task.id ? nextTask : entry)
			};
			await atomicWriteJson(this.location.file, nextTasks);
			await this.appendAudit({
				kind: "task/acknowledged",
				taskId: task.id,
				memberId: request.memberId,
				attemptId: attempt.id,
				actor: request.memberId,
				at: now,
				revision: nextTasks.revision
			});
			return { task: clone(nextTask) };
		});
	}
	async createTask(request) {
		return withProcessLock(this.location.teamFile, async () => {
			const team = await this.readTeamLocked();
			if (!isLeadOrHuman(team, request.actor)) fail(`only the lead may create tasks; ask ${leadMemberIdForMessage(team)}`);
			const current = await this.readTasksIfPresentLocked();
			if (request.expectedRevision !== void 0 && request.expectedRevision !== current.revision) throw new LiveTeamsError(ERROR_CODES.REVISION_CONFLICT, `expected revision ${request.expectedRevision}, actual ${current.revision}`);
			const normalized = this.validateCreate(request, team, current.tasks);
			const now = Date.now();
			const id = `task-${randomUUID()}`;
			const task = {
				id,
				teamId: this.teamId,
				title: normalized.title,
				kind: normalized.kind,
				status: normalized.status,
				...normalized.assignee === void 0 ? {} : { assignee: normalized.assignee },
				...normalized.route === void 0 ? {} : { route: normalized.route },
				humanContact: normalized.humanContact,
				...normalized.dependsOn === void 0 ? {} : { dependsOn: normalized.dependsOn },
				...normalized.why === void 0 ? {} : { why: normalized.why },
				...normalized.body === void 0 ? {} : { body: normalized.body },
				...normalized.checks.length === 0 ? {} : { checks: normalized.checks },
				...normalized.paths === void 0 ? {} : { paths: normalized.paths },
				acceptance: normalized.acceptance,
				roundLimit: normalized.roundLimit,
				contractRevision: 1,
				createdBy: request.actor,
				createdAt: now,
				updatedAt: now,
				revision: current.revision + 1
			};
			const documentPath = this.documentPath(id);
			const document = renderDocument(task, team, { tasks: current.tasks });
			await atomicWrite(documentPath, document);
			const next = {
				...current,
				schemaVersion: 1,
				revision: current.revision + 1,
				tasks: [...current.tasks, task]
			};
			try {
				await atomicWriteJson(this.location.file, next);
			} catch (error) {
				await promises.unlink(documentPath).catch(() => void 0);
				throw error;
			}
			const auditAt = Date.now();
			await this.appendAudit({
				kind: "task/created",
				id,
				taskId: id,
				title: task.title,
				assignee: task.assignee,
				routeType: task.route?.type,
				actor: request.actor,
				at: auditAt,
				revision: next.revision
			});
			await this.appendAudit({
				kind: "task/document",
				id,
				taskId: id,
				path: documentPath,
				actor: request.actor,
				at: Date.now()
			});
			return {
				task: clone(task),
				documentPath
			};
		});
	}
	get teamId() {
		return path.basename(this.location.directory);
	}
	documentPath(taskId) {
		return path.join(this.location.tasksDirectory, `${taskId}.md`);
	}
	async readOrCreateLocked() {
		await promises.mkdir(this.location.directory, { recursive: true });
		return this.readTasksIfPresentLocked();
	}
	async readTasksIfPresentLocked() {
		if (!await fileExists(this.location.file)) return {
			schemaVersion: 1,
			revision: 0,
			teamId: this.teamId,
			tasks: []
		};
		try {
			return parseTasksState(await readJson(this.location.file), this.teamId, this.location.archiveDirectory);
		} catch (error) {
			if (error instanceof LiveTeamsError) throw error;
			throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, `cannot read ${this.location.file}`, { cause: error });
		}
	}
	async readAttemptsIfPresentLocked() {
		if (!await fileExists(this.location.attemptsFile)) return {
			schemaVersion: 1,
			revision: 0,
			teamId: this.teamId,
			attempts: []
		};
		try {
			return parseAttemptsState(await readJson(this.location.attemptsFile), this.teamId);
		} catch (error) {
			if (error instanceof LiveTeamsError) throw error;
			throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, `cannot read ${this.location.attemptsFile}`, { cause: error });
		}
	}
	async readSubmissionsIfPresentLocked() {
		if (!await fileExists(this.location.submissionsFile)) return {
			schemaVersion: 1,
			revision: 0,
			teamId: this.teamId,
			submissions: []
		};
		try {
			return parseSubmissionsState(await readJson(this.location.submissionsFile), this.teamId);
		} catch (error) {
			if (error instanceof LiveTeamsError) throw error;
			throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, `cannot read ${this.location.submissionsFile}`, { cause: error });
		}
	}
	async readReviewsIfPresentLocked() {
		if (!await fileExists(this.location.reviewsFile)) return {
			schemaVersion: 1,
			revision: 0,
			teamId: this.teamId,
			rounds: []
		};
		try {
			return parseReviewsState(await readJson(this.location.reviewsFile), this.teamId);
		} catch (error) {
			if (error instanceof LiveTeamsError) throw error;
			throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, `cannot read ${this.location.reviewsFile}`, { cause: error });
		}
	}
	async readTeamLocked() {
		let value;
		try {
			value = await readJson(this.location.teamFile);
		} catch (error) {
			throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, `cannot read team state: ${this.location.teamFile}`, { cause: error });
		}
		const team = objectRecord(value);
		if (team === void 0 || team.teamId !== this.teamId || !Array.isArray(team.members)) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, "invalid team state");
		return team;
	}
	validateCreate(request, team, existing) {
		return this.validateContract({
			title: request.title,
			kind: request.kind,
			assignee: request.assignee,
			route: request.route,
			humanContact: request.humanContact ?? "none",
			acceptance: request.acceptance,
			checks: request.checks,
			why: request.why,
			body: request.body,
			roundLimit: request.roundLimit ?? 5,
			dependsOn: request.dependsOn,
			paths: request.paths
		}, team, existing, void 0);
	}
	/**
	* The one place the contract rules live, shared by creation (B19) and editing
	* (B27): a second copy of them is how the writer and the reader start to
	* disagree about what a valid contract is.
	*/
	validateContract(input, team, existing, selfId) {
		const request = input;
		if (!nonEmpty(request.title)) fail("title must be non-empty");
		const title = request.title.trim();
		if (chars(title) > MAX_TITLE) fail(`title must be at most ${MAX_TITLE} characters`);
		if (!TASK_KINDS.includes(request.kind)) fail(`unsupported task kind: ${String(request.kind)}`);
		if (request.assignee !== void 0) {
			if (typeof request.assignee !== "string" || memberById(team, request.assignee) === void 0) fail(`assignee is not a current team member: ${String(request.assignee)}`);
		}
		const route = request.route === void 0 ? void 0 : validateRoute(request.route, team, request.assignee);
		const humanContact = request.humanContact ?? "none";
		if (humanContact !== "none" && humanContact !== "expected" && humanContact !== "required") fail("humanContact must be none, expected, or required");
		if (!Array.isArray(request.acceptance)) fail("acceptance must be an array");
		const acceptance = request.acceptance.map((entry) => typeof entry === "string" ? entry.trim() : "");
		const status = request.assignee !== void 0 && route !== void 0 ? "ready" : "draft";
		if (!acceptance.every((entry) => entry.length > 0) && status === "ready") fail("acceptance criteria must be non-empty strings");
		if (status === "ready" && acceptance.length === 0) fail("ready tasks require non-empty acceptance");
		const roundLimit = request.roundLimit ?? 5;
		if (!Number.isInteger(roundLimit) || roundLimit < 1 || roundLimit > 20) fail("roundLimit must be an integer from 1 to 20");
		if (request.body !== void 0 && (typeof request.body !== "string" || chars(request.body) > MAX_BODY)) fail(`body must be at most ${MAX_BODY} characters`);
		if (request.why !== void 0 && typeof request.why !== "string") fail("why must be a string");
		if (request.checks !== void 0 && (!Array.isArray(request.checks) || !request.checks.every((entry) => typeof entry === "string"))) fail("checks must be an array of strings");
		const checks = request.checks === void 0 ? [] : request.checks.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
		const why = request.why === void 0 ? void 0 : request.why.trim();
		const body = request.body === void 0 ? void 0 : request.body;
		if (status === "ready" && (route === void 0 || acceptance.length === 0)) fail("ready tasks require route and acceptance");
		const dependsOn = validateDependencies(request.dependsOn, selfId, existing);
		let paths;
		if (request.paths !== void 0 && request.paths !== null) {
			paths = normalizeScope(request.paths);
			if (paths === void 0) fail(`paths must be 1 to 32 unique workspace-relative globs without ".." or an absolute path`);
		}
		return {
			title,
			kind: request.kind,
			...request.assignee === void 0 ? {} : { assignee: request.assignee },
			...route === void 0 ? {} : { route },
			humanContact,
			acceptance,
			checks,
			...why === void 0 ? {} : { why },
			...body === void 0 ? {} : { body },
			roundLimit,
			...dependsOn === void 0 ? {} : { dependsOn },
			...paths === void 0 ? {} : { paths },
			status
		};
	}
};
function createTaskStore(options) {
	return new TaskStore(options);
}
//#endregion
export { TaskStore, assignmentRouteText, blockedBy, createTaskStore, deriveRouteContacts, renderDocument, routeAllowsContact, routeText, taskDocumentPath };
