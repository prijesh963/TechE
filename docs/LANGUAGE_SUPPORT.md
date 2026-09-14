# Language Support

Copilot Architect supports all repositories through a universal adapter system. It provides deep adapter-based support for common stacks and generic fallback support for unknown or custom repos through indexing, search, config detection, and custom commands.

---

## Deep Support — Adapter-Detected Stacks

### JavaScript / TypeScript

Detection signals: `package.json`, `tsconfig.json`, `jsconfig.json`, `vite.config.*`, `next.config.*`, `webpack.config.*`, `.eslintrc*`, `.prettierrc*`.

Package managers detected: `npm`, `pnpm`, `yarn`, `bun`, `deno`.

Commands extracted from `package.json` scripts: `build`, `test`, `lint`, `format`, `typecheck`, `e2e`, `start`, `dev`.

Executables allowed in validation: `npm`, `npx`, `pnpm`, `yarn`, `bun`, `deno`, `node`, `tsc`, `eslint`, `prettier`, `biome`, `vite`, `webpack`, `rollup`, `esbuild`, `turbo`, `nx`, `vitest`, `jest`, `mocha`, `jasmine`, `playwright`, `cypress`.

### React

Detection signals: `react` and `react-dom` dependencies, `@vitejs/plugin-react`, `next` dependency, `react-scripts`.

Detects: components, hooks, pages/routes, test files, `__tests__` folders.

### Angular

Detection signals: `angular.json`, `@angular/core` dependency, `@angular/cli`.

Detects: projects, apps, libraries, components, services, modules, guards, interceptors, spec files.

Commands: `ng build`, `ng test`, `npm run build`, `npm test`, `npm run lint`.

### Python

Detection signals: `pyproject.toml`, `requirements.txt`, `setup.py`, `setup.cfg`, `pytest.ini`, `tox.ini`, `poetry.lock`, `Pipfile`.

Frameworks detected where possible: FastAPI, Flask, Django, pytest, unittest.

Executables allowed in validation: `pytest`, `python`, `python3`, `py`, `poetry`, `pipenv`, `uv`, `ruff`, `mypy`, `flake8`, `black`.

Allowed `python`/`python3`/`py` invocations:

- `python -m pytest`
- `python -m unittest`
- `python -m mypy`
- `python -m flake8`
- `python -m black`
- `python -m ruff`
- `python -m isort`
- `python -m pylint`
- `python setup.py test`
- `python setup.py build`

### Java Maven

Detection signals: `pom.xml`, `mvnw`.

Frameworks detected: Spring Boot, JUnit.

Commands: `mvn test`, `mvn package`, `./mvnw test`, `./mvnw package`.

### Java Gradle

Detection signals: `build.gradle`, `settings.gradle`, `gradlew`.

Frameworks detected: Spring Boot, JUnit.

Commands: `gradle test`, `gradle build`, `./gradlew test`, `./gradlew build`.

---

## Extended Toolchain Support

These executables are recognized as safe by the validation engine even without a dedicated adapter:

| Ecosystem             | Executables                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| JavaScript/TypeScript | `npm`, `npx`, `pnpm`, `yarn`, `bun`, `deno`, `node`, `tsc`, `biome`                              |
| Build                 | `vite`, `webpack`, `rollup`, `esbuild`, `turbo`, `nx`                                            |
| Test                  | `vitest`, `jest`, `mocha`, `jasmine`, `playwright`, `cypress`                                    |
| Python                | `pytest`, `python`, `python3`, `py`, `poetry`, `pipenv`, `uv`, `ruff`, `mypy`, `flake8`, `black` |
| Java/JVM              | `maven`, `mvn`, `mvnw`, `gradle`, `gradlew`                                                      |
| Angular               | `ng`                                                                                             |
| Rust                  | `cargo`, `rustfmt`, `clippy`                                                                     |
| Go                    | `go`                                                                                             |
| .NET                  | `dotnet` (read-only operations only)                                                             |

Custom commands from `.copilot-architect/commands.json` are always allowed regardless of executable name.

---

## Generic Fallback — All Repos

Any repository that does not match a specific adapter is handled by `GenericTextAdapter`, which provides:

- File scanning with content hashing and size limits
- Docs detection (`README`, `*.md`, `docs/`)
- Config file detection
- Import/include scanning
- Test file pattern detection (`*.test.*`, `*.spec.*`, `__tests__/`, `test/`)
- Generic source and test folder detection

This ensures indexing, search, custom commands, and planning work on any repo regardless of stack.

---

## Monorepos and Multi-Repo Workspaces

The analyzer treats each project root as a candidate repo unit and preserves workspace-level context. A mixed frontend/backend repo may produce multiple project maps under one workspace map.

Multi-repo workspace config: `.copilot-architect/workspace.json`

```bash
npm run cli -- workspace init
npm run cli -- workspace add api-service ../api-service --role backend
npm run cli -- workspace add web-app ../web-app --role frontend
npm run cli -- workspace index
npm run cli -- workspace search "authentication"
npm run cli -- workspace plan "Add SSO login"
```

---

## Generic Fallback Targets

These languages receive generic fallback support through indexing, search, config detection, and custom commands:

- Go (extended: `go` executable also recognized as safe)
- Rust (extended: `cargo`, `rustfmt`, `clippy` recognized as safe)
- C / C++
- PHP
- Ruby
- Shell scripts
- SQL
- Any other language or unknown stack

---

## Adding Support for a New Stack

1. Implement a class that satisfies the adapter interfaces in `packages/adapters/src/types.ts`.
2. Register it in `packages/adapters/src/default-registry.ts`.
3. Add sample files to `samples/` and tests to `tests/`.
4. Custom commands for specific per-repo needs can always be added without writing an adapter via `.copilot-architect/commands.json`.
