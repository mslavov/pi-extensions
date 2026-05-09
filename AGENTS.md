# Repository Instructions

## Git

- Use author email `milko.slavov@gmail.com` for commits.
- Use conventional commit messages: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`.

## Monorepo

- This repo uses Bun workspaces and Turborepo.
- Packages live in `packages/`; each package is an independent pi extension.
- After code changes, run `bun run check` and fix type errors.
- Each publishable package should include `"keywords": ["pi-package"]` and a `"pi": { "extensions": [...] }` entry in `package.json`.

## Pi Extensions

- Extensions export a default function receiving `ExtensionAPI`.
- Types come from `@earendil-works/pi-coding-agent` and related pi packages.
- Pi compiles TypeScript directly; package `build` scripts should not add unnecessary build steps.
- Test an extension locally with `pi -e ./packages/<name>`.

## Code Quality

- Keep changes focused on the requested task.
- Prefer simple, direct implementations over unnecessary abstractions.
- Delete dead code instead of commenting it out.
- Comments should explain why, not restate what the code does.
