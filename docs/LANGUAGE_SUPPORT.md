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

## Integrations — A Separate Axis From Language

Language/framework detection answers "what is this repo written in". Integration
detection answers "what does it talk to", and runs as one pass over all files
rather than per adapter — the same broker shows up in a Maven pom, an npm
`package.json`, a `requirements.txt` or a Spring `application.properties`.

| Category           | Detected                                                                |
| ------------------ | ----------------------------------------------------------------------- |
| **Datastore**      | Oracle, MongoDB, PostgreSQL, MySQL, SQL Server, Redis                   |
| **Messaging**      | Kafka, IBM MQ, JMS, ActiveMQ, RabbitMQ                                  |
| **Micro-frontend** | Module Federation, single-spa, Web Components                           |
| **Microservice**   | Spring Cloud, Service Discovery (Eureka/Consul), API Gateway, OpenFeign |

Because these compose, **arbitrary combinations need no special case**: a
"Java + Oracle + Kafka + IBM MQ" service is the Java adapter plus three
independent integration detections, and the plan's `Integrations` section gets
guidance for each. Adding a new integration to the table below benefits every
combination it can appear in.

Confidence is evidence-based: a declared dependency, driver class or connection
URL yields `high`; a bare keyword mention yields `medium`. Documentation files
are excluded — a README mentioning Kafka is not evidence the service uses it.

Detected integrations appear in `repo-map.json` under `integrations`, and the
Feature Planner, FeatureImplementer and CodeReviewer agents are instructed to
treat message payloads, REST contracts, persisted schemas and micro-frontend
exposed modules as published contracts when a change touches them.

### Validated against

Detection was checked against real public repositories rather than only
fixtures: `piomin/sample-spring-microservices` (Spring Cloud, Eureka, Gateway,
Feign),
`piomin/sample-spring-kafka-microservices` (Kafka),
`ibm-messaging/mq-dev-patterns` (IBM MQ, JMS),
`oracle-samples/oracle-db-examples` (Oracle),
`spring-guides/gs-accessing-data-mongodb` (MongoDB),
`module-federation/module-federation-examples` (Module Federation), and
`tiangolo/full-stack-fastapi-template` (FastAPI + React + PostgreSQL).

---

## Adding Support for a New Stack

1. Implement a class that satisfies the adapter interfaces in `packages/adapters/src/types.ts`.
2. Register it in `packages/adapters/src/default-registry.ts`.
3. Add sample files to `samples/` and tests to `tests/`.
4. Custom commands for specific per-repo needs can always be added without writing an adapter via `.copilot-architect/commands.json`.

To add a new **integration** instead, add one entry to `INTEGRATION_SIGNALS` in
`packages/adapters/src/integration-detector.ts` (and optionally a guidance line
to `INTEGRATION_GUIDANCE` in the planner) — no adapter changes required.

## Symbol Graph Coverage

The symbol/dependency graph (`npm run cli -- graph`) powers graph-based search
ranking and the "why relevant" citations in plans.

| Language              | Extraction                                                                             |
| --------------------- | -------------------------------------------------------------------------------------- |
| TypeScript/JavaScript | Real TypeScript AST (`.ts`, `.tsx`, `.js`, `.jsx`)                                     |
| **Java**              | Declaration scanner (`.java`) — package, imports, types, heritage, methods, call sites |
| Everything else       | File-level nodes only; search falls back to keyword, path and git-recency signals      |

### Why Java uses a scanner rather than a parser

The TS path uses the real TypeScript AST because `typescript` is already a
dependency. For Java, the only viable pure-JS parser (`java-parser`) pins
chevrotain 11, which carries a high-severity lodash advisory, and forcing a
newer chevrotain breaks it — adopting it would have taken this repo from zero
known vulnerabilities to six. Since the graph only needs declaration-level
facts, `packages/graph/src/java-extractor.ts` scans for them directly after
blanking comments and string literals (so a `{` in a comment or a `}` in a
string cannot throw off brace matching).

Java resolution is package-aware rather than path-based: imports resolve
through a repo-wide qualified-name index, a call receiver is mapped from the
field's declared type (`repo.save(…)` → `OrderRepository.save`), and an
inherited call is found by walking resolved supertypes. A call that resolves to
no known method — a JDK or third-party call — is dropped rather than pointed at
the enclosing class.

Known limits, consistent with the TS path's "best effort, degrade gracefully"
contract: annotations are not modelled, anonymous and local classes get no node
of their own, and overloads collapse to one method node. A file it cannot make
sense of yields fewer nodes, never wrong ones.

No benchmark of the Java scanner is committed, so no counts are claimed here.
What is covered is in `tests/java-graph.test.ts`: class, interface and method
nodes, `extends` chains across files, and controller → repository call edges.
A figure quoted without an artifact that reproduces it is the kind of claim
this tool exists to flag, so it is not quoted.
