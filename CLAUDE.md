@AGENTS.md

# Claude Code

## Workflow

- Read relevant project instructions before starting work.
- Use plan mode for architectural changes and complex tasks.
- Delegate independent, narrowly scoped tasks to subagents.
- Keep implementations minimal and consistent with existing architecture.
- Verify changes with relevant tests, typecheck and lint.
- Do not commit or push changes without explicit authorization.

## Architecture

- Follow established architectural decisions.
- Keep business logic independent of Electron and React.
- Before modifying shared contracts, identify and review all consumers.
- Preserve backward compatibility unless a breaking change is explicitly required.
- Ask for clarification only when requirements remain ambiguous after reviewing available documentation.

## Documentation

- Keep internal architecture, implementation plans, decisions and worklogs out of the public repository.
- Use private project documentation when available.
- Do not recreate missing private documentation in the public repository.
- Record architectural decisions and task progress in the designated private documentation when accessible.
- If required documentation is unavailable, report the limitation rather than inventing decisions.
