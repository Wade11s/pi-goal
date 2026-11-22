/**
 * Issue #45: one provider-neutral V1 conformance suite, executed through the
 * deterministic fake's and released Rex v0.2.0's public custom-tool results.
 * No production accounting module imports either provider.
 */
import { rexAvailable, startRexConformanceProvider } from "./helpers/rex-acceptance.mjs";
import { startFakeConformanceProvider } from "./helpers/fake-subagent-acceptance.mjs";
import { runSubagentUsageConformance } from "./helpers/subagent-usage-conformance.mjs";

runSubagentUsageConformance({
	name: "deterministic fake provider",
	createProvider: startFakeConformanceProvider,
});

const live = rexAvailable();
runSubagentUsageConformance({
	name: "released Rex v0.2.0 provider",
	skip: { skip: live ? false : "needs a local `rex` CLI to run the isolated Rex server", timeout: 120_000 },
	createProvider: startRexConformanceProvider,
});
