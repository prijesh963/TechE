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

| Category             | Detected                                                                |
| -------------------- | ----------------------------------------------------------------------- |
| **Datastore**        | Oracle, MongoDB, PostgreSQL, MySQL, SQL Server, Redis                   |
| **Messaging**        | Kafka, IBM MQ, JMS, ActiveMQ, RabbitMQ                                  |
| **Micro-frontend**   | Module Federation, single-spa, Web Components                           |
| **Microservice**     | Spring Cloud, Service Discovery (Eureka/Consul), API Gateway, OpenFeign |
| **Orchestration**    | Kubernetes, Helm, Docker Compose                                        |
| **Monorepo tooling** | Nx, Turborepo                                                           |
| **Test automation**  | Playwright, Cucumber (`.feature` files), TestNG                         |

Because these compose, **arbitrary combinations need no special case**: a
"Java + Oracle + Kafka + IBM MQ" service is the Java adapter plus three
independent integration detections, and the plan's `Integrations` section gets
guidance for each. Adding a new integration to the table below benefits every
combination it can appear in.

Confidence is evidence-based: a declared dependency, driver class or connection
URL yields `high`; a bare keyword mention yields `medium`. Documentation files
are excluded — a README mentioning Kafka is not evidence the service uses it.

Orchestration and monorepo tooling are also detected by canonical filename —
`nx.json`, `turbo.json`, `docker-compose.yml`, `Chart.yaml` — the same
precedent as a Java adapter treating `pom.xml` itself as high-confidence
evidence for Maven, since a scan that never read the file's content still
knows what it is called. Kubernetes additionally checks manifest content
(`apiVersion` plus a real resource `kind`), since real manifests live under
all sorts of folder names in practice.

This is what catches a microservices or micro-frontend repo that is not
built on Spring Cloud or Module Federation at all — plain services wired
together by Kubernetes/Compose, or several frontends wired together by
Nx/Turborepo, is the more common shape outside the Java and webpack
ecosystems specifically.

Test automation (Playwright, Cucumber, TestNG) is kept on this axis rather
than folded into the language adapters' own framework lists (which is where
JUnit and pytest are detected), because Playwright and Cucumber both cross
language boundaries on their own — detecting them per adapter would mean
repeating the same signals in the JS, Python and Java adapters alike.

Cucumber's `.feature` files also get a second, independent fix: they are now
recognized by `isTestFile` — previously four separate, disagreeing
implementations, one of which required a leading `/` before `test/`,
`tests/` or `spec/` that a root-level folder in a repo-relative path never
has. A Cucumber-only repo, with its conventional root `features/` folder,
read as having no tests at all before this.

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
`module-federation/module-federation-examples` (Module Federation),
`tiangolo/full-stack-fastapi-template` (FastAPI + React + PostgreSQL),
`vercel/turborepo` (Turborepo's own `turbo.json`, and Module Federation and
Redis found incidentally inside it),
`docker/awesome-compose` (Docker Compose),
`kubernetes/examples` (raw Kubernetes manifests, not curated fixtures),
`nrwl/nx-examples` (Nx),
`microsoft/playwright-mcp` (Playwright's own `playwright.config.ts` and real
specs, as an external consumer would have it — Playwright's own monorepo
tests itself through internal fixtures rather than the published package, so
was not representative for this),
`cucumber/cucumber-js` (real `.feature` files), and
`testng-team/testng` (its own `testng.xml`).

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
through a repo-wide qualified-name index, a call receiver is mapped from its
declared type — a field, a method parameter, or a local variable declared in
the method body, checked in that order so a local correctly shadows a
same-named field — and an inherited call is found by walking resolved
supertypes. `repo.save(…)` reaches `OrderRepository.save` whether `repo` is a
field, a parameter, or `OrderRepository repo = new OrderRepositoryImpl();`
declared inside the method itself. A call that resolves to no known method —
a JDK or third-party call — is dropped rather than pointed at the enclosing
class.

The TypeScript/JavaScript path resolves a call receiver the same way: a class
field's own type annotation or constructor parameter property
(`constructor(private repo: OrderRepository)`), a plain parameter's
annotation, or a local variable's explicit annotation or its type inferred
from a `new ClassName(...)` initializer — checked in that order, local
shadowing a field included. `this.repo.save(...)` and a bare `repo.save(...)`
both resolve once `repo`'s declared type is known.

Known limits, consistent with the TS path's "best effort, degrade gracefully"
contract: annotations are not modelled, anonymous and local classes get no node
of their own, and overloads collapse to one method node. A file it cannot make
sense of yields fewer nodes, never wrong ones.

No benchmark of the Java scanner is committed, so no counts are claimed here.
What is covered is in `tests/java-graph.test.ts`: class, interface and method
nodes, `extends` chains across files, and controller → repository call edges
resolved through a field, a parameter, and a method-local variable, with a
local's type taking precedence over a same-named field's. `tests/graph.test.ts`
covers the same set for TypeScript, including a call reached through `this.`.
A figure quoted without an artifact that reproduces it is the kind of claim
this tool exists to flag, so it is not quoted.
