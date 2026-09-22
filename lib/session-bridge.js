import { LiveTeamsError, translatePlatformError } from "./errors.js";
//#region src/session-bridge.ts
function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function text(value) {
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
function isSubagentHeader(header) {
	const value = record(header);
	return value.origin === "subagent" || text(value.parentSession) !== void 0;
}
function isMissingSession(error) {
	const value = record(error);
	if (value.code === "session/not-found") return true;
	if (typeof value.code === "string" && value.code.length > 0) return false;
	return /not found/i.test(String(value.message ?? ""));
}
function isSubagentOwnership(error) {
	const value = record(error);
	if (value.code !== "session/agent-busy") return false;
	const details = record(value.details);
	return /subagent/i.test(String(details.reason ?? value.message ?? ""));
}
function toBridgeError(error) {
	if (error instanceof LiveTeamsError) return error;
	const translated = translatePlatformError(error);
	if (!isSubagentOwnership(error)) return translated;
	return new LiveTeamsError("CAPABILITY_UNAVAILABLE", "Session is owned by subagent routing and cannot be a team member", translated.auditDetail === void 0 ? { cause: error } : {
		cause: error,
		auditDetail: translated.auditDetail
	});
}
function descriptorOf(inspection, liveAgent) {
	const liveSession = record(record(liveAgent).session);
	const meta = record(inspection.meta ?? inspection.header ?? liveSession.header);
	const session = record(liveAgent).session;
	const ownerHeader = record(session).header ?? meta;
	const events = Array.isArray(inspection.events) ? inspection.events : [];
	let title = text(meta.title);
	let seq = typeof meta.seq === "number" ? meta.seq : 0;
	for (const event of events) {
		const value = record(event);
		if (typeof value.seq === "number" && value.seq > seq) seq = value.seq;
		if (value.type === "session/title") title = text(record(value.data).title) ?? title;
	}
	const statusValue = record(liveAgent).status;
	return {
		sessionId: text(meta.id) ?? "",
		workspaceId: text(meta.workspaceId),
		cwd: text(meta.cwd),
		title,
		status: statusValue === "idle" || statusValue === "running" ? statusValue : "unknown",
		live: liveAgent !== void 0 && liveAgent !== null,
		subagentOwned: isSubagentHeader(ownerHeader),
		seq,
		agentPreset: text(meta.agentPreset)
	};
}
function createSessionBridge({ controller, agents }) {
	if (controller === null || typeof controller !== "object") throw new LiveTeamsError("CAPABILITY_UNAVAILABLE", "sessionController is not available in this composition");
	const liveAgentOf = (sessionId) => agents?.get?.(sessionId);
	const bridge = {
		async create(request) {
			const sessionId = text(request?.sessionId);
			if (sessionId === void 0) throw new LiveTeamsError("CAPABILITY_UNAVAILABLE", "create requires an explicit plugin-owned sessionId");
			const payload = { sessionId };
			if (text(request.workspaceId) !== void 0) payload.workspaceId = request.workspaceId;
			if (text(request.cwd) !== void 0) payload.cwd = request.cwd;
			if (text(request.agentPreset) !== void 0) payload.agentPreset = request.agentPreset;
			try {
				await controller.create(payload);
			} catch (error) {
				throw toBridgeError(error);
			}
			const descriptor = await bridge.inspect(sessionId);
			if (descriptor === void 0) throw new LiveTeamsError("SESSION_NOT_FOUND", `Session "${sessionId}" was not readable after create`, { auditDetail: "create succeeded but inspect could not observe the Session" });
			return descriptor;
		},
		async inspect(sessionId) {
			try {
				return descriptorOf(record(await controller.inspect(sessionId)), liveAgentOf(sessionId));
			} catch (error) {
				if (isMissingSession(error)) return void 0;
				throw toBridgeError(error);
			}
		},
		async validateAttachment(sessionId, workspaceId) {
			const descriptor = await bridge.inspect(sessionId);
			if (descriptor === void 0) throw new LiveTeamsError("SESSION_NOT_FOUND", `Session "${sessionId}" does not exist`, { auditDetail: "validateAttachment: inspect returned no Session" });
			if (descriptor.subagentOwned) throw new LiveTeamsError("CAPABILITY_UNAVAILABLE", `Session "${sessionId}" is owned by subagent routing`, { auditDetail: "validateAttachment: subagent-owned Session cannot be a member" });
			const expected = text(workspaceId);
			if (expected !== void 0 && descriptor.workspaceId !== expected) throw new LiveTeamsError("SESSION_WRONG_WORKSPACE", `Session "${sessionId}" is not attached to workspace "${expected}"`, { auditDetail: `observed workspaceId=${String(descriptor.workspaceId)}` });
			return descriptor;
		},
		async rename(sessionId, title) {
			try {
				const result = record(await controller.rename({
					sessionId,
					title
				}));
				return {
					title: text(result.title) ?? title,
					seq: typeof result.seq === "number" ? result.seq : void 0
				};
			} catch (error) {
				throw toBridgeError(error);
			}
		},
		selectModel() {
			throw new LiveTeamsError("CAPABILITY_UNAVAILABLE", "Model selection is intentionally unavailable in this build", { auditDetail: "Phase 2 policy omits member model selection because selectModel also rewrites the deployment-wide default model. This must not be worked around silently." });
		},
		async deliver(sessionId, envelope) {
			if (envelope.mode !== "queue" && envelope.mode !== "steer") throw new LiveTeamsError("DELIVERY_REJECTED", `Unsupported delivery mode "${String(envelope.mode)}"`);
			try {
				await controller.prompt({
					requestId: envelope.requestId,
					sessionId,
					mode: envelope.mode,
					content: envelope.content
				}, new AbortController().signal);
				return { accepted: true };
			} catch (error) {
				throw toBridgeError(error);
			}
		},
		async interrupt(sessionId, _reason) {
			try {
				controller.cancel({ sessionId });
				return { accepted: true };
			} catch (error) {
				throw toBridgeError(error);
			}
		},
		async reconcile(sessionIds) {
			const descriptors = [];
			for (const sessionId of sessionIds) {
				const descriptor = await bridge.inspect(sessionId);
				if (descriptor !== void 0) descriptors.push(descriptor);
			}
			return descriptors;
		}
	};
	return Object.freeze(bridge);
}
//#endregion
export { createSessionBridge, toBridgeError };
