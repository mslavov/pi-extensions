import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const WORKFLOW_REPORT_MESSAGE = "pi-workflows:report";
export const WORKFLOW_RESULT_MESSAGE = "pi-workflows:result";
export const WORKFLOW_DIAGNOSTIC_MESSAGE = "pi-workflows:diagnostic";

export const NO_UI_EXECUTION_MESSAGE =
  "Workflows are not executable in pi print/JSON mode. Use pi-workflows run <id>.";

export function sendWorkflowMessage(
  pi: ExtensionAPI,
  customType: typeof WORKFLOW_REPORT_MESSAGE | typeof WORKFLOW_RESULT_MESSAGE | typeof WORKFLOW_DIAGNOSTIC_MESSAGE,
  content: string,
  details?: unknown,
): void {
  pi.sendMessage(
    {
      customType,
      content,
      display: true,
      details,
    },
    { triggerTurn: false },
  );
}

export function refuseNoUiExecution(pi: ExtensionAPI): void {
  sendWorkflowMessage(pi, WORKFLOW_DIAGNOSTIC_MESSAGE, NO_UI_EXECUTION_MESSAGE, {
    code: "ui-required",
  });
}

