/**
 * Shared scripting helper for the Blocker-identity contract (issue #26).
 *
 * The model, not the extension, decides whether two reports describe the same
 * condition, so an RPC scenario has to *pass the identity back* the way a real
 * model would after reading it from `get_goal`. The scripted provider re-reads its
 * script file on every request, and a `waitForFile` step holds its response until
 * the test creates the file. Chaining one gate per Goal turn makes that race-free
 * at every step:
 *
 * - the gate step's own content is already final, so holding it cannot change
 *   what it says;
 * - no request after a gate is made until the gate file exists, so rewriting the
 *   remaining turns with the identity the extension just published cannot be
 *   overtaken by the provider.
 *
 * The test therefore reads the current identity out of each report's structured
 * result, rewrites the later turns, and only then releases the gate — exactly the
 * sequence a model performs when it inspects `get_goal` and retries.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

/** An identity the extension never issued, for the rejection scenarios. */
export const FOREIGN_ID = "blocker_deadbeef";

/** The structured `{ goal }` payload of a finalized tool call. */
export function structuredGoal(result) {
	return result.structuredContent?.goal ?? result.details?.goal;
}

/** The audit of the newest persisted `goal-state` snapshot. */
export function lastAudit(entries) {
	let snapshot;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === "goal-state") snapshot = entry;
	}
	return snapshot?.data.goal.blockedAudit;
}

/** Assert one audit carries the description, the count, and an opaque identity. */
export function assertAudit(audit, blocker, turns) {
	assert.equal(audit.blocker, blocker);
	assert.equal(audit.turns, turns);
	assert.match(audit.blockerId, /^blocker_[0-9a-f]{8}$/, "the audit carries an opaque Blocker identity");
}

/**
 * Script one blocked-audit chain, ready to be run.
 *
 * `reports` is one entry per Goal turn, in order. The first entry omits its
 * identity, which is what makes the extension issue one. `id` on a later entry is
 * `"issued"` to pass the identity the extension currently has open, `"foreign"` to
 * pass {@link FOREIGN_ID}, and anything else (usually absent) to omit
 * `blocker_id` and report a genuinely different condition. `extra` appends provider
 * steps after the chain, for the scenarios that continue with a resume, a
 * completion, or an ordinary prompt.
 *
 * Call this *before* starting the Goal: the scripted provider reads the file on
 * every request, and the kickoff is the first one. Then call
 * {@link advanceAuditGate} once per Goal turn but the last, or use
 * {@link runAuditChain}, which does the whole loop.
 */
export function scriptAuditChain(session, reports, extra = []) {
	// One gate per Goal turn but the last: the last turn's trailing response ends
	// the chain, so nothing after it needs to be rewritten.
	const gates = reports.slice(0, -1).map((_, index) => join(session.cwd, `pi-goal-audit-gate-${index}`));
	const build = (currentId) => {
		const steps = [{ text: "Kickoff answer." }];
		for (const [index, report] of reports.entries()) {
			const args = { action: "blocked", blocker: report.blocker };
			if (report.id === "issued") args.blocker_id = currentId;
			else if (report.id === "foreign") args.blocker_id = FOREIGN_ID;
			steps.push({ toolCalls: [{ name: "update_goal", args }] });
			steps.push({
				text: `Waiting (Goal turn ${index + 1}).`,
				...(index < gates.length ? { waitForFile: gates[index] } : {}),
			});
		}
		return [...steps, ...extra];
	};
	writeFileSync(session.scriptPath, JSON.stringify(build(undefined)), "utf8");
	return { gates, build };
}

/**
 * Wait for Goal turn `index`'s report to be finalized, substitute the identity the
 * extension now has open into the remaining turns, and release that turn's gate.
 *
 * A rejected report publishes the identity that is still open, so this works for
 * refusals too: the next turn either reuses it or reports a different condition.
 * Returns the identity now open, or undefined when no audit is open.
 */
export async function advanceAuditGate(session, chain, index) {
	const result = await session.waitForToolResult("update_goal", index + 1);
	const currentId = structuredGoal(result.result)?.blockerId ?? undefined;
	writeFileSync(session.scriptPath, JSON.stringify(chain.build(currentId)), "utf8");
	writeFileSync(chain.gates[index], "", "utf8");
	return currentId;
}

/**
 * Script a chain, start the Goal, and run it to its settle: the common shape of
 * every blocked-audit RPC scenario. `start` is the caller's own Goal-creation
 * step, which must run *after* the script is written because the kickoff is the
 * scripted provider's first request.
 */
export async function runAuditChain(session, reports, extra = [], start) {
	const chain = scriptAuditChain(session, reports, extra);
	await start();
	let currentId;
	for (let index = 0; index < chain.gates.length; index++) {
		currentId = await advanceAuditGate(session, chain, index);
	}
	await session.waitForSettled(1);
	return currentId;
}

/** Provider steps a chain consumes: the kickoff, plus a report and a response per Goal turn. */
export function auditChainStepCount(reports) {
	return 1 + 2 * reports.length;
}
