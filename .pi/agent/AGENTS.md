## Git
- Commits must use email: milko.slavov@gmail.com
- Use conventional commit messages: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`

## Monorepo
- Bun workspaces + Turborepo
- Packages live in `packages/` — each is an independent pi extension
- After changes, run `bun run check` to type-check all packages
- Each package has `"keywords": ["pi-package"]` and `"pi": { "extensions": [...] }` in package.json

## Pi Extensions
- Extensions export a default function receiving `ExtensionAPI`
- Types come from `@mariozechner/pi-coding-agent` (peer dep, don't install locally)
- Pi compiles TypeScript directly — no build step needed
- Test by loading with `pi -e ./packages/<name>`
