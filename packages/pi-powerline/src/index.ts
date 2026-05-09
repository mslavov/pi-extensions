import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, summarizeConfig } from "./config.js";
import { PowerlineFooter } from "./footer.js";
import type { RuntimeMetrics } from "./segments.js";
import { createSubscriptionController, type SubscriptionRefreshOptions } from "./subscription.js";

const SUBSCRIPTION_REFRESH_TIMER_MS = 60_000;

export default function powerlineExtension(pi: ExtensionAPI): void {
	let footer: PowerlineFooter | undefined;
	let metrics: RuntimeMetrics = { sessionStartedAt: Date.now() };
	let subscriptionTimer: ReturnType<typeof setInterval> | undefined;
	const subscription = createSubscriptionController(refreshFooter);

	function installFooter(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setFooter((tui, _theme, footerData) => {
			footer = new PowerlineFooter({ pi, ctx, tui, footerData, metrics, subscription: subscription.state });
			return footer;
		});
	}

	function refreshFooter(): void {
		footer?.invalidate();
	}

	function refreshSubscription(ctx: ExtensionContext, options?: SubscriptionRefreshOptions): void {
		if (!ctx.hasUI) return;
		void subscription.refresh(ctx, options).catch(() => refreshFooter());
	}

	function startSubscriptionTimer(ctx: ExtensionContext): void {
		clearSubscriptionTimer();
		if (!ctx.hasUI) return;
		subscriptionTimer = setInterval(() => {
			refreshSubscription(ctx);
			refreshFooter();
		}, SUBSCRIPTION_REFRESH_TIMER_MS);
	}

	function clearSubscriptionTimer(): void {
		if (!subscriptionTimer) return;
		clearInterval(subscriptionTimer);
		subscriptionTimer = undefined;
	}

	pi.on("session_start", async (_event, ctx) => {
		metrics = { sessionStartedAt: Date.now() };
		installFooter(ctx);
		startSubscriptionTimer(ctx);
		refreshSubscription(ctx, { allowStaleCache: true });
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearSubscriptionTimer();
		subscription.clear();
		if (ctx.hasUI) ctx.ui.setFooter(undefined);
		footer = undefined;
	});

	pi.on("agent_start", async () => {
		metrics.agentStartedAt = Date.now();
		refreshFooter();
	});

	pi.on("agent_end", async () => {
		if (metrics.agentStartedAt !== undefined) {
			metrics.lastAgentDurationMs = Date.now() - metrics.agentStartedAt;
			metrics.agentStartedAt = undefined;
		}
		refreshFooter();
	});

	pi.on("turn_end", async (_event, ctx) => {
		refreshSubscription(ctx);
		refreshFooter();
	});
	pi.on("tool_execution_end", async () => refreshFooter());
	pi.on("session_compact", async () => refreshFooter());
	pi.on("session_tree", async () => refreshFooter());
	pi.on("model_select", async (_event, ctx) => {
		refreshSubscription(ctx, { force: true, resetProvider: true });
		refreshFooter();
	});

	pi.registerCommand("powerline", {
		description: "Show, reload, or reset the pi-powerline footer config",
		handler: async (args, ctx) => {
			const command = args.trim().split(/\s+/)[0] || "status";

			if (!footer && ctx.hasUI) installFooter(ctx);

			if (command === "status" || command === "show") {
				ctx.ui.notify(footer ? footer.summary() : summarizeLoadedConfig(), "info");
				return;
			}

			if (command === "reload") {
				const loaded = footer?.reloadConfig() ?? loadConfig();
				const warnings = loaded.warnings.length > 0 ? `\n\nWarnings:\n${loaded.warnings.map((warning) => `- ${warning}`).join("\n")}` : "";
				ctx.ui.notify(`pi-powerline config reloaded.\n${summarizeConfig(loaded.config, loaded.path, loaded.loadedFromFile)}${warnings}`, "info");
				return;
			}

			if (command === "defaults") {
				footer?.restoreDefaults();
				ctx.ui.notify("pi-powerline restored default config in memory. Your config.json was not modified.", "info");
				return;
			}

			if (command === "help") {
				ctx.ui.notify("Usage: /powerline [status|reload|defaults|help]", "info");
				return;
			}

			ctx.ui.notify(`Unknown /powerline command '${command}'. Use /powerline help.`, "warning");
		},
	});
}

function summarizeLoadedConfig(): string {
	const loaded = loadConfig();
	const warnings = loaded.warnings.length > 0 ? `\nWarnings:\n${loaded.warnings.map((warning) => `- ${warning}`).join("\n")}` : "";
	return `${summarizeConfig(loaded.config, loaded.path, loaded.loadedFromFile)}${warnings}`;
}
