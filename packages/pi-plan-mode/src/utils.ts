/**
 * Pure utility functions for plan mode.
 */

export interface PlanStep {
	step: number;
	text: string;
	description: string;
}

/**
 * Clean up step text for display as a task subject.
 */
export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 80) {
		cleaned = `${cleaned.slice(0, 77)}...`;
	}
	return cleaned;
}

/**
 * Extract plan steps from plan content.
 *
 * Handles two formats:
 *
 * 1. Planner subagent format (## Tasks section with **Task N**: descriptions):
 *    ## Tasks
 *    1. **Task 1**: Description
 *       - File: path/to/file.ts
 *       - Changes: what to modify
 *
 * 2. Simple numbered plan format:
 *    Plan:
 *    1. First step description
 *    2. Second step description
 */
export function extractPlanSteps(content: string): PlanStep[] {
	const items: PlanStep[] = [];

	// Try planner format first: ## Tasks section
	const tasksMatch = content.match(/^##\s+Tasks\s*$/m);
	if (tasksMatch && tasksMatch.index !== undefined) {
		const tasksSection = content.slice(tasksMatch.index + tasksMatch[0].length);
		// Find where the next ## section starts (or end of content)
		const nextSectionMatch = tasksSection.match(/^##\s+/m);
		const sectionEnd = nextSectionMatch?.index ?? tasksSection.length;
		const sectionText = tasksSection.slice(0, sectionEnd);

		// Parse numbered items: "1. **Task 1**: Description" or "1. Description"
		const pattern = /^(\d+)[.)]\s+(?:\*{1,2}[^*]+\*{1,2}[:\s]*)?(.+)/gm;
		let stepNum = 0;

		for (const match of sectionText.matchAll(pattern)) {
			stepNum++;
			const title = cleanStepText(match[2]);
			if (title.length < 3) continue;

			// Capture indented lines as description until next numbered item
			const matchEnd = (match.index ?? 0) + match[0].length;
			const remaining = sectionText.slice(matchEnd);
			const nextItemMatch = remaining.match(/^\d+[.)]\s+/m);
			const descEnd = nextItemMatch?.index ?? remaining.length;
			const descLines = remaining.slice(0, descEnd).trim();

			items.push({
				step: stepNum,
				text: title,
				description: descLines ? `${title}\n${descLines}` : title,
			});
		}

		if (items.length > 0) return items;
	}

	// Fallback: "Plan:" header format
	const planMatch = content.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (planMatch && planMatch.index !== undefined) {
		const planSection = content.slice(planMatch.index + planMatch[0].length);
		const pattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;
		let stepNum = 0;

		for (const match of planSection.matchAll(pattern)) {
			stepNum++;
			const text = match[2].trim().replace(/\*{1,2}$/, "").trim();
			if (text.length < 5) continue;
			const cleaned = cleanStepText(text);
			if (cleaned.length < 3) continue;

			items.push({ step: stepNum, text: cleaned, description: cleaned });
		}
	}

	// Last resort: any top-level numbered list
	if (items.length === 0) {
		const pattern = /^(\d+)[.)]\s+\*{0,2}(.+)/gm;
		let stepNum = 0;
		for (const match of content.matchAll(pattern)) {
			stepNum++;
			const text = match[2].trim().replace(/\*{1,2}$/, "").trim();
			if (text.length < 5) continue;
			const cleaned = cleanStepText(text);
			if (cleaned.length < 3) continue;
			items.push({ step: stepNum, text: cleaned, description: cleaned });
		}
	}

	return items;
}

