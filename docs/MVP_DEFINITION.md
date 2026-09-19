# MVP Definition And Lock

## Goal

The MVP proves that a TypeScript/Node.js internal tool can analyze a local repository or small multi-repo workspace, create repo intelligence artifacts, help plan features, generate approved handoff prompts, run safe validation, and produce review reports.

The MVP is local-first, CLI-first, MCP-first, and intended for internal team sharing through a normal npm workflow.

## Locked MVP Scope

The MVP includes exactly these required capabilities:

1. TypeScript CLI.
2. Repo discovery.
3. JS/TS adapter.
4. React adapter.
5. Angular adapter.
6. Python adapter.
7. Java adapter.
8. Generic adapter.
9. Local indexing.
10. Search.
11. Feature planning.
12. Custom command config.
13. Validation engine.
14. Safety policy.
15. MCP server.
16. Custom Copilot agents.
17. Copilot instructions.
18. Handoff prompts.
19. Review reports.
20. Multi-repo workspace basics.
21. Basic VS Code extension shell.
22. Internal setup docs.

Copilot Chat support is delivered through the locked MVP surfaces above: custom agents, repository instructions, prompt files, and local MCP configuration. It does not add a separate cloud service or modify Copilot internals.

## MVP User Path

The supported MVP path is:

```bash
npm install
npm run build
npm test
npm run cli -- init
npm run cli -- analyze
npm run cli -- index
npm run cli -- search "invoice"
npm run cli -- plan "Add invoice approval workflow"
npm run cli -- agents install
npm run cli -- instructions generate
npm run cli -- handoff --plan latest --approve
npm run cli -- validate
npm run cli -- review
npm run cli -- mcp config
npm run cli -- mcp
```

The sample-matrix test covers the main flow from analysis through review. The Copilot Chat integration tests cover agent, instruction, prompt, and MCP configuration artifacts.

Phase 26 validation evidence and the MVP readiness decision are recorded in `docs/PHASE_26_VALIDATION_REPORT.md`.

## MVP Non-Goals

The MVP does not include:

1. Full autonomous code editing inside this tool.
2. Commercial distribution.
3. Visual Studio (the IDE) extensions — the VS Code `.vsix` built by `npm run package:vsix` is in scope and shipping.
4. Cloud sync.
5. Team dashboard.
6. Heavy vector database.
7. Perfect support for every framework.
8. PR automation.

The MVP is not a .NET product, does not include a Visual Studio VSIX, and does not assume target repositories are C#/.NET. "VSIX" in that sentence means the Visual Studio IDE; the VS Code extension package of the same file extension is the primary way this ships.

## Lock Rules

Until the MVP is stable:

- Do not add new major product scope beyond the locked MVP scope.
- Do not introduce a cloud backend, marketplace packaging, a Visual Studio (IDE) extension, a .NET engine, or a heavy vector database.
- Do not move business logic into UI shells.
- Do not claim perfect framework support.
- Do not claim autonomous implementation approval or completion.
- Do not bypass safety policy, human approval gates, or validation evidence.

Optional wrappers may exist only as thin shells over CLI, MCP, or package services. They are not allowed to become the primary implementation surface for MVP behavior.

## Acceptance Gates

The MVP is considered locked when all of these pass:

- `npm run format`
- `npm run lint`
- `npm run build`
- `npm test`
- `npm run cli -- doctor`
- `npm run cli -- version`

The test suite must continue to prove:

- Adapter and repo discovery coverage for supported stacks.
- The local index and search path.
- Feature planning and approval-gated handoff generation.
- Safety policy and validation command blocking.
- Review report generation from plan, diff, and validation evidence.
- Multi-repo workspace basics.
- Custom agent, instruction, prompt, and MCP configuration artifacts.
- The end-to-end MVP flow in `tests/sample-matrix.test.ts`.
