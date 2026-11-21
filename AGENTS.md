# BPG Studio: public contributor guidance

This is the public Community source repository.

## Engineering conventions

- Use TypeScript with strict type checking; no explicit `any`.
- Keep database/schema domain logic independent of Electron, React and AntV.
- Only expose narrow, validated IPC capabilities through preload.
- Never store credentials in renderer state, source files or logs.
- Test critical database operations using an isolated PostgreSQL instance.
- Do not run destructive SQL or migrations without explicit user confirmation.
- Prefer small changes, preserve established package boundaries, run relevant tests.
- Describe actual verification performed; do not claim passing tests without running them.

This repository intentionally contains no internal engineering roadmap, private implementation tasks or commercial plans. Contributor guidance belongs here and in the public README.
