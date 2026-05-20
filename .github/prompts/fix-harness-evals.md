# Fix latest-Pi harness eval failures

You are repairing compatibility failures between this repository's pi extensions and the latest published Pi runtime.

Start by inspecting `.harness-evals/output/latest/results.json`. Then inspect the relevant `.harness-evals/runs/**/summary.json`, `result.json`, step logs, and event summaries for the failing evals.

Make the smallest extension-code changes needed to restore compatibility with the latest Pi runtime. Keep changes focused on runtime compatibility. Do not weaken, delete, or bypass evals to hide failures.

Use the existing package structure and conventions. Prefer direct fixes in the affected package over broad refactors.

Before finishing, run:

```bash
bun run check
```

When provider/model credentials are available, also run:

```bash
bun run evals:pi -- --provider "$PI_PROVIDER" --model "$PI_MODEL"
```

Leave branch creation, commits, and pull requests to the GitHub Actions workflow.
