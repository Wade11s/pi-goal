/** Rex labels are free text; keep them single line and readable. */
export function sanitizeLabel(text: string): string {
	return text
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function shortModel(model: string | undefined): string | undefined {
	if (!model) return undefined;
	const parts = model.split("/").filter((part) => part.length > 0);
	return parts.length > 0 ? parts[parts.length - 1] : undefined;
}

/**
 * Tab title: the task the agent was given, then the model and thinking level so
 * parallel runs of the same task stay distinguishable.
 */
export function runTitle(options: { name?: string; model?: string; thinking?: string; handle: string }): string {
	const task = sanitizeLabel(options.name ?? "") || shortModel(options.model) || `agent ${options.handle}`;
	const model = shortModel(options.model);
	const thinking = sanitizeLabel(options.thinking ?? "");
	const suffix = [model, thinking].filter((part) => part && part.length > 0).join(":");
	const title = suffix ? `${task} — ${suffix}` : task;
	// Rex accepts long labels; keep them short enough for a tab header.
	return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}

export function sessionLabel(group: string): string {
	const clean = sanitizeLabel(group) || "subagents";
	return `rex-${clean}`;
}
