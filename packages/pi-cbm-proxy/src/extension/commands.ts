import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CbmServices } from "../pi-tools/definitions.js";

type CommandUi = {
  select(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error" | "success"): void;
};

export function registerCommands(pi: ExtensionAPI, services: CbmServices) {
  pi.registerCommand("cbm", {
    description: "Open the pi-cbm settings menu. Usage: /cbm [menu|status|stats|enable-non-git|disable-non-git]",
    handler: async (args, ctx) => {
      const action = args.trim() || "menu";

      if (action === "menu") {
        await openSettingsMenu(services, ctx.ui);
        return;
      }

      if (action === "status") {
        ctx.ui.notify(buildStatus(services), "info");
        return;
      }

      if (action === "stats") {
        ctx.ui.notify(buildStats(services), "info");
        return;
      }

      if (action === "enable-non-git") {
        services.settings.setAutoIndexNonGitDirectories(true);
        ctx.ui.notify("pi-cbm: auto-indexing safe non-git directories is enabled. Root, home, and system paths are still blocked.", "info");
        return;
      }

      if (action === "disable-non-git") {
        services.settings.setAutoIndexNonGitDirectories(false);
        ctx.ui.notify("pi-cbm: auto-indexing non-git directories is disabled. Git repositories will still be indexed.", "info");
        return;
      }

      ctx.ui.notify(`Unknown /cbm action: ${action}. Use menu, status, stats, enable-non-git, or disable-non-git.`, "warning");
    },
  });
}

async function openSettingsMenu(services: CbmServices, ui: CommandUi) {
  while (true) {
    const choice = await ui.select("pi-cbm settings", [
      `auto-index non-git directories: ${services.settings.autoIndexNonGitDirectories ? "enabled" : "disabled"} — toggle`,
      "show status",
      "show stats",
      "done",
    ]);

    if (!choice || choice === "done") return;

    if (choice.startsWith("auto-index non-git directories:")) {
      const enabled = !services.settings.autoIndexNonGitDirectories;
      services.settings.setAutoIndexNonGitDirectories(enabled);
      ui.notify(
        enabled
          ? "pi-cbm: auto-indexing safe non-git directories is enabled. Root, home, and system paths are still blocked."
          : "pi-cbm: auto-indexing non-git directories is disabled. Git repositories will still be indexed.",
        "info",
      );
      continue;
    }

    if (choice === "show status") {
      ui.notify(buildStatus(services), "info");
    }

    if (choice === "show stats") {
      ui.notify(buildStats(services), "info");
    }
  }
}

function buildStatus(services: CbmServices): string {
  return [
    "pi-cbm status",
    "  auto-index:",
    "    git repositories: enabled",
    `    non-git directories: ${services.settings.autoIndexNonGitDirectories ? "enabled" : "disabled"}`,
    "    unsafe path guard: enabled",
    "",
    ...services.stats.summaryLines(),
  ].join("\n");
}

function buildStats(services: CbmServices): string {
  return services.stats.summaryLines().join("\n");
}
