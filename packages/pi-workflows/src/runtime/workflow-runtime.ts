import {
  createWorkflowChildSession,
  type WorkflowChildSession,
  type WorkflowChildSessionFactory,
} from "./child-session.js";

export const DEFAULT_AGENT_OUTPUT_BYTES = 256 * 1024;
export const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1_000;

export interface WorkflowRuntimeOptions {
  cwd: string;
  agentDir?: string;
  createChildSession?: WorkflowChildSessionFactory;
  maxAgentOutputBytes?: number;
}

export class WorkflowRuntime {
  readonly maxAgentOutputBytes: number;
  private readonly options: WorkflowRuntimeOptions;
  private childPromise?: Promise<WorkflowChildSession>;
  private abortPromise?: Promise<void>;
  private disposePromise?: Promise<void>;
  private closing = false;

  constructor(options: WorkflowRuntimeOptions) {
    this.options = options;
    this.maxAgentOutputBytes = options.maxAgentOutputBytes ?? DEFAULT_AGENT_OUTPUT_BYTES;
    if (!Number.isSafeInteger(this.maxAgentOutputBytes) || this.maxAgentOutputBytes < 1) {
      throw new Error("maxAgentOutputBytes must be a positive safe integer");
    }
  }

  getChildSession(): Promise<WorkflowChildSession> {
    if (this.closing) throw new Error("Workflow runtime is closing");
    this.childPromise ??= (this.options.createChildSession ?? createWorkflowChildSession)({
      cwd: this.options.cwd,
      agentDir: this.options.agentDir,
    });
    return this.childPromise;
  }

  async abort(): Promise<void> {
    if (!this.childPromise) return;
    this.abortPromise ??= this.childPromise.then((child) => child.abort());
    await this.abortPromise;
  }

  async dispose(): Promise<void> {
    this.closing = true;
    this.disposePromise ??= (async () => {
      if (!this.childPromise) return;
      const child = await this.childPromise.catch(() => undefined);
      child?.dispose();
    })();
    await this.disposePromise;
  }
}
