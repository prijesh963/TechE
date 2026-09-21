import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";
import {
  AdvancedAnalysisService,
  WorkspaceService
} from "../packages/core/src/index.js";
import { FeaturePlanningService } from "../packages/planner/src/index.js";
import {
  CURRENT_SCHEMA_VERSION,
  getArtifactDirectoryPath
} from "../packages/shared/src/index.js";

const execFileAsync = promisify(execFile);

function createCapture() {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    io: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message)
    }
  };
}

describe("Phase 21 advanced intelligence", () => {
  it("detects React architecture, routes, dependency manifests, and component tests", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({
        scripts: { build: "vite build", test: "vitest run" },
        dependencies: {
          react: "^18.2.0",
          "react-router-dom": "^6.22.0"
        }
      }),
      "src/App.tsx":
        "import { Route } from 'react-router-dom'; export function App() { return <Route path=\"/invoices\" element={<InvoicePage />} />; }",
      "src/InvoicePage.tsx": "export function InvoicePage() { return null; }",
      "src/InvoicePage.test.tsx": "test('invoice page', () => {})"
    });

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: repoRoot,
      request: "Add invoice approval workflow"
    });

    expect(analysis.architecturePatterns.map((pattern) => pattern.name)).toContain(
      "React app"
    );
    expect(analysis.dependencyManifests).toContainEqual(
      expect.objectContaining({ filePath: "package.json", ecosystem: "javascript" })
    );
    expect(analysis.routes).toContainEqual(
      expect.objectContaining({ kind: "react", routePath: "/invoices" })
    );
    expect(analysis.testRelationships).toContainEqual(
      expect.objectContaining({
        kind: "component",
        sourceFile: "src/InvoicePage.tsx",
        testFile: "src/InvoicePage.test.tsx"
      })
    );
    expect(analysis.riskScores.map((risk) => risk.category)).toEqual(
      expect.arrayContaining(["security", "missing-test", "dependency"])
    );
  });

  it("detects Angular routes and service/component test relationships", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({
        scripts: { build: "ng build", test: "ng test" },
        dependencies: { "@angular/core": "^17.0.0", "@angular/router": "^17.0.0" },
        devDependencies: { "@angular/cli": "^17.0.0" }
      }),
      "angular.json": JSON.stringify({
        projects: {
          app: { projectType: "application", root: "", sourceRoot: "src" }
        }
      }),
      "src/app/app-routing.module.ts":
        "const routes = [{ path: 'invoices', component: InvoiceComponent }];",
      "src/app/invoice.component.ts": "export class InvoiceComponent {}",
      "src/app/invoice.component.spec.ts": "describe('invoice', () => {})",
      "src/app/invoice.service.ts": "export class InvoiceService {}",
      "src/app/invoice.service.spec.ts": "describe('service', () => {})"
    });

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: repoRoot
    });

    expect(analysis.architecturePatterns.map((pattern) => pattern.name)).toContain(
      "Angular app"
    );
    expect(analysis.routes).toContainEqual(
      expect.objectContaining({ kind: "angular", routePath: "/invoices" })
    );
    expect(analysis.testRelationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceFile: "src/app/invoice.component.ts",
          testFile: "src/app/invoice.component.spec.ts"
        }),
        expect.objectContaining({
          sourceFile: "src/app/invoice.service.ts",
          testFile: "src/app/invoice.service.spec.ts"
        })
      ])
    );
  });

  it("detects Python service API routes and route tests", async () => {
    const repoRoot = await createRepo({
      "pyproject.toml": "[project]\nname = 'api'\ndependencies = ['fastapi']",
      "requirements.txt": "fastapi\npytest\n",
      "app/main.py":
        "from fastapi import FastAPI\napp = FastAPI()\n@app.post('/invoices/{invoice_id}/approve')\ndef approve_invoice(invoice_id: str): return {'ok': True}",
      "tests/test_invoice_routes.py": "def test_approve_invoice(): assert '/invoices' "
    });

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: repoRoot,
      request: "Add invoice approval workflow"
    });

    expect(analysis.architecturePatterns.map((pattern) => pattern.name)).toContain(
      "Python service"
    );
    expect(analysis.routes).toContainEqual(
      expect.objectContaining({
        kind: "fastapi",
        method: "POST",
        routePath: "/invoices/{invoice_id}/approve"
      })
    );
    expect(analysis.dependencyManifests.map((manifest) => manifest.filePath)).toEqual(
      expect.arrayContaining(["pyproject.toml", "requirements.txt"])
    );
    expect(analysis.testRelationships).toContainEqual(
      expect.objectContaining({
        kind: "api-route",
        routePath: "/invoices/{invoice_id}/approve",
        testFile: "tests/test_invoice_routes.py"
      })
    );
  });

  it("detects Java Spring services, controller routes, and dependency manifests", async () => {
    const repoRoot = await createRepo({
      "pom.xml":
        "<project><artifactId>spring-boot-starter-web</artifactId><artifactId>junit-jupiter</artifactId></project>",
      "src/main/java/com/acme/InvoiceController.java": [
        "import org.springframework.web.bind.annotation.*;",
        "@RestController",
        '@RequestMapping("/invoices")',
        "public class InvoiceController {",
        '@PostMapping("/{id}/approve")',
        "void approve() {}",
        "}"
      ].join("\n"),
      "src/test/java/com/acme/InvoiceControllerTests.java":
        "class InvoiceControllerTests { void approveInvoice() {} }"
    });

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: repoRoot
    });

    expect(analysis.architecturePatterns.map((pattern) => pattern.name)).toContain(
      "Java Spring service"
    );
    expect(analysis.routes).toContainEqual(
      expect.objectContaining({
        kind: "spring",
        method: "POST",
        routePath: "/invoices/{id}/approve"
      })
    );
    expect(analysis.dependencyManifests).toContainEqual(
      expect.objectContaining({ filePath: "pom.xml", ecosystem: "java" })
    );
  });

  it("adds advanced analysis, risk scores, and plan quality to plans", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({
        scripts: { build: "vite build", test: "vitest run" },
        dependencies: { react: "^18.2.0", "react-router-dom": "^6.22.0" }
      }),
      "src/App.tsx":
        "import { Route } from 'react-router-dom'; export function App() { return <Route path=\"/invoices\" element={<InvoicePage />} />; }",
      "src/InvoicePage.tsx": "export function InvoicePage() { return null; }",
      "src/InvoicePage.test.tsx": "test('invoice page', () => {})"
    });

    const result = await new FeaturePlanningService().createPlan({
      startPath: repoRoot,
      request: "Add invoice approval workflow"
    });
    const latestMarkdown = await readFile(result.latestMarkdownPath, "utf8");

    expect(result.plan.advancedAnalysis.routes.length).toBeGreaterThan(0);
    expect(result.plan.riskScores.length).toBeGreaterThanOrEqual(5);
    expect(result.plan.planQuality.score).toBeGreaterThan(0);
    expect(result.plan.impactAnalysis.risks.map((risk) => risk.title)).toEqual(
      expect.arrayContaining([expect.stringContaining("missing-test risk score")])
    );
    expect(latestMarkdown).toContain("## Advanced Architecture Signals");
    expect(latestMarkdown).toContain("## Risk Scores");
    expect(latestMarkdown).toContain("## Plan Quality");
    expect(
      existsSync(
        path.join(getArtifactDirectoryPath(repoRoot, "plans"), "latest-plan.json")
      )
    ).toBe(true);
  });

  it("reports repo readiness through the diagnostics CLI", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({
        dependencies: { express: "^4.18.0" }
      }),
      "src/server.ts":
        "import express from 'express'; const app = express(); app.get('/health', handler);"
    });
    const capture = createCapture();

    const result = await runCli(
      ["diagnostics", "--path", repoRoot, "--json"],
      capture.io
    );
    const report = JSON.parse(capture.stdout.join("\n"));

    expect(result.exitCode).toBe(0);
    expect(capture.stderr).toEqual([]);
    expect(report.status).toBe("warning");
    expect(
      report.diagnostics.map((diagnostic: { code: string }) => diagnostic.code)
    ).toEqual(
      expect.arrayContaining([
        "MISSING_REPO_MAP",
        "MISSING_BUILD_SCRIPT",
        "MISSING_TESTS",
        "STALE_INDEX"
      ])
    );
    expect(report.advancedAnalysis.routes).toContainEqual(
      expect.objectContaining({ kind: "express", routePath: "/health" })
    );
  });

  it("does not flag MISSING_TESTS for a repo covered only by Cucumber features", async () => {
    // Regression: a root-level features/ folder was invisible to the old
    // isTestFile — the folder check required a leading slash a root-relative
    // path never has — so a Cucumber-only repo read as untested.
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({
        scripts: { test: "cucumber-js" },
        devDependencies: { "@cucumber/cucumber": "^10.0.0" }
      }),
      "features/login.feature":
        "Feature: Login\n  Scenario: Successful login\n    Given I am on the login page\n",
      "src/login.ts": "export function login() {}\n"
    });
    const capture = createCapture();

    const result = await runCli(
      ["diagnostics", "--path", repoRoot, "--json"],
      capture.io
    );
    const report = JSON.parse(capture.stdout.join("\n"));

    expect(result.exitCode).toBe(0);
    expect(
      report.diagnostics.map((diagnostic: { code: string }) => diagnostic.code)
    ).not.toContain("MISSING_TESTS");
  });

  it("returns no git activity when the repo has no .git directory", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "no-git" }),
      "src/index.ts": "export const value = 1;"
    });

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: repoRoot
    });

    expect(analysis.gitActivity).toEqual([]);
  });

  it("ranks git activity by commit frequency and surfaces recency", async () => {
    if (!(await gitAvailable())) {
      return;
    }

    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "git-activity" }),
      "src/hot.ts": "export const hot = 1;",
      "src/cold.ts": "export const cold = 1;"
    });
    await initializeGitRepo(repoRoot);
    // Two extra commits touching src/hot.ts, none touching src/cold.ts again.
    for (let index = 0; index < 2; index += 1) {
      await writeFile(
        path.join(repoRoot, "src/hot.ts"),
        `export const hot = ${index + 2};`,
        "utf8"
      );
      await commitAll(repoRoot, `update hot ${index}`);
    }

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: repoRoot
    });
    const hot = analysis.gitActivity.find(
      (activity) => activity.filePath === "src/hot.ts"
    );
    const cold = analysis.gitActivity.find(
      (activity) => activity.filePath === "src/cold.ts"
    );

    expect(hot?.commitCount).toBe(3);
    expect(cold?.commitCount).toBe(1);
    expect(hot?.lastChangedDaysAgo).toBe(0);
    expect(analysis.gitActivity[0]?.filePath).toBe("src/hot.ts");
  });

  it("flags an untested hotspot in the missing-test risk score's reasons", async () => {
    if (!(await gitAvailable())) {
      return;
    }

    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "hotspot-risk" }),
      "src/payment-service.ts": "export const process = () => true;"
    });
    await initializeGitRepo(repoRoot);
    for (let index = 0; index < 2; index += 1) {
      await writeFile(
        path.join(repoRoot, "src/payment-service.ts"),
        `export const process = () => ${index + 2};`,
        "utf8"
      );
      await commitAll(repoRoot, `touch payment-service ${index}`);
    }

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: repoRoot
    });
    const missingTestRisk = analysis.riskScores.find(
      (risk) => risk.category === "missing-test"
    );

    expect(missingTestRisk?.score).toBe(90);
    expect(missingTestRisk?.reasons.join(" ")).toContain("src/payment-service.ts");
    expect(missingTestRisk?.reasons.join(" ")).toContain("untested hotspots");
  });
});

describe("multi-repo advanced analysis", () => {
  it("analyzes every registered repo, not only the first (repos[0] regression)", async () => {
    const fixture = await createMultiRepoWorkspaceFixture();
    const workspaceService = new WorkspaceService();

    await workspaceService.createWorkspaceMap({ startPath: fixture.workspaceRoot });

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: fixture.workspaceRoot
    });

    // Routes from BOTH repos must be present, not only api-repo (repos[0]).
    expect(analysis.routes).toContainEqual(
      expect.objectContaining({
        routePath: "/invoices",
        repoName: "api-repo"
      })
    );
    expect(
      analysis.architecturePatterns.some((pattern) => pattern.repoName === "web-repo")
    ).toBe(true);

    // Test relationships from both repos, each tagged with its own repo.
    const relationshipRepoNames = new Set(
      analysis.testRelationships.map((relationship) => relationship.repoName)
    );
    expect(relationshipRepoNames.has("api-repo")).toBe(true);
    expect(relationshipRepoNames.has("web-repo")).toBe(true);
    expect(
      analysis.testRelationships.some(
        (relationship) =>
          relationship.repoName === "api-repo" &&
          relationship.sourceFile === "src/server.ts" &&
          relationship.testFile === "src/server.test.ts"
      )
    ).toBe(true);

    // Risk scores are computed per repo, tagged, and merged.
    expect(
      analysis.riskScores.filter((risk) => risk.category === "security")
    ).toHaveLength(2);
    expect(
      analysis.riskScores.some(
        (risk) => risk.category === "security" && risk.repoName === "api-repo"
      )
    ).toBe(true);
    expect(
      analysis.riskScores.some(
        (risk) => risk.category === "security" && risk.repoName === "web-repo"
      )
    ).toBe(true);

    // A polyrepo workspace (physically separate repos) is not evidence that
    // any single member of it is itself a monorepo.
    expect(
      analysis.architecturePatterns.some((pattern) => pattern.name === "monorepo")
    ).toBe(false);

    // Repo-map/index freshness is a workspace-wide artifact, checked once —
    // not once per registered repo.
    expect(
      analysis.diagnostics.filter((diagnostic) => diagnostic.code === "STALE_INDEX")
    ).toHaveLength(1);
    expect(analysis.diagnostics.find((d) => d.code === "STALE_INDEX")?.repoName).toBe(
      undefined
    );

    expect(analysis.repoRoot).toBe(fixture.workspaceRoot);
  });

  it("matches an HTTP client call in one repo to a route in another", async () => {
    const fixture = await createMultiRepoWorkspaceFixture();
    await writeFile(
      path.join(fixture.webRepo, "src", "invoiceClient.ts"),
      "import axios from 'axios'; export function loadInvoices() { return axios.get('/invoices'); }",
      "utf8"
    );
    const workspaceService = new WorkspaceService();
    await workspaceService.createWorkspaceMap({ startPath: fixture.workspaceRoot });

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: fixture.workspaceRoot
    });

    expect(analysis.interlinks).toContainEqual(
      expect.objectContaining({
        kind: "http-route",
        method: "GET",
        path: "/invoices",
        fromRepo: "web-repo",
        fromFile: "src/invoiceClient.ts",
        toRepo: "api-repo",
        toFile: "src/server.ts",
        confidence: "high"
      })
    );
  });

  it("does not report an interlink for a call matching a route in its own repo", async () => {
    const fixture = await createMultiRepoWorkspaceFixture();
    // api-repo calling its own /invoices route is not a cross-repo interlink.
    await writeFile(
      path.join(fixture.apiRepo, "src", "selfCall.ts"),
      "import axios from 'axios'; export function loadInvoices() { return axios.get('/invoices'); }",
      "utf8"
    );
    const workspaceService = new WorkspaceService();
    await workspaceService.createWorkspaceMap({ startPath: fixture.workspaceRoot });

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: fixture.workspaceRoot
    });

    expect(
      analysis.interlinks.some((interlink) => interlink.fromRepo === "api-repo")
    ).toBe(false);
  });

  it("treats a Feign client's declared methods as calls, not exposed routes", async () => {
    const fixture = await createFeignWorkspaceFixture();
    const workspaceService = new WorkspaceService();
    await workspaceService.createWorkspaceMap({ startPath: fixture.workspaceRoot });

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: fixture.workspaceRoot
    });

    // The Feign client interface must not be reported as a route this repo
    // exposes — it declares a call to another service, the opposite claim.
    expect(analysis.routes.some((route) => route.repoName === "order-service")).toBe(
      false
    );
    expect(analysis.routes).toContainEqual(
      expect.objectContaining({
        routePath: "/invoices/{id}/approve",
        repoName: "invoice-service"
      })
    );
    expect(analysis.interlinks).toContainEqual(
      expect.objectContaining({
        kind: "http-route",
        method: "POST",
        fromRepo: "order-service",
        toRepo: "invoice-service",
        confidence: "high"
      })
    );
  });
});

describe("messaging interlinks", () => {
  it("matches a Kafka producer in one repo to a consumer in another", async () => {
    const fixture = await createTwoRepoWorkspace("order-service", "invoice-service", {
      "order-service": {
        "package.json": JSON.stringify({ dependencies: { kafkajs: "^2.0.0" } }),
        "src/orderProducer.ts": [
          "import { Kafka } from 'kafkajs';",
          "const producer = new Kafka({}).producer();",
          "export async function publish() {",
          "  await producer.send({ topic: 'order.created', messages: [] });",
          "}"
        ].join("\n")
      },
      "invoice-service": {
        "pom.xml": "<project><artifactId>spring-kafka</artifactId></project>",
        "src/main/java/com/acme/OrderListener.java": [
          "package com.acme;",
          "import org.springframework.kafka.annotation.KafkaListener;",
          "public class OrderListener {",
          '  @KafkaListener(topics = "order.created")',
          "  public void onOrderCreated(String payload) { }",
          "}"
        ].join("\n")
      }
    });

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: fixture.workspaceRoot
    });

    expect(analysis.interlinks).toContainEqual(
      expect.objectContaining({
        kind: "messaging",
        method: "kafka",
        path: "order.created",
        fromRepo: "order-service",
        fromFile: "src/orderProducer.ts",
        toRepo: "invoice-service",
        toFile: "src/main/java/com/acme/OrderListener.java",
        confidence: "high"
      })
    );
  });

  it("matches confluent-kafka's produce(), not only kafka-python's send()", async () => {
    const fixture = await createTwoRepoWorkspace("pricing-service", "invoice-service", {
      "pricing-service": {
        "requirements.txt": "confluent-kafka\n",
        "src/producer.py": [
          "from confluent_kafka import Producer",
          "producer = Producer({})",
          "def publish(order):",
          "    producer.produce('price.updated', order)"
        ].join("\n")
      },
      "invoice-service": {
        "requirements.txt": "confluent-kafka\n",
        "src/consumer.py": [
          "from confluent_kafka import Consumer",
          "consumer = Consumer({})",
          "consumer.subscribe(['price.updated'])"
        ].join("\n")
      }
    });

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: fixture.workspaceRoot
    });

    expect(analysis.interlinks).toContainEqual(
      expect.objectContaining({
        kind: "messaging",
        method: "kafka",
        path: "price.updated",
        fromRepo: "pricing-service",
        toRepo: "invoice-service",
        confidence: "high"
      })
    );
  });

  it("matches a RabbitMQ producer in Java to a consumer in Python", async () => {
    const fixture = await createTwoRepoWorkspace("payment-service", "ledger-service", {
      "payment-service": {
        "pom.xml":
          "<project><artifactId>spring-boot-starter-amqp</artifactId></project>",
        "src/main/java/com/acme/PaymentPublisher.java": [
          "package com.acme;",
          "public class PaymentPublisher {",
          "  private RabbitTemplate rabbitTemplate;",
          "  public void publish(String order) {",
          '    rabbitTemplate.convertAndSend("payment.completed", order);',
          "  }",
          "}"
        ].join("\n")
      },
      "ledger-service": {
        "requirements.txt": "pika\n",
        "src/consumer.py": [
          "import pika",
          "channel = pika.channel()",
          "def start():",
          "    channel.basic_consume(queue='payment.completed', on_message_callback=handle)"
        ].join("\n")
      }
    });

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: fixture.workspaceRoot
    });

    expect(analysis.interlinks).toContainEqual(
      expect.objectContaining({
        kind: "messaging",
        method: "rabbitmq",
        path: "payment.completed",
        fromRepo: "payment-service",
        toRepo: "ledger-service",
        confidence: "high"
      })
    );
  });

  it("matches a JMS producer to a consumer, covering IBM MQ/ActiveMQ's own API", async () => {
    const fixture = await createTwoRepoWorkspace("shipping-service", "notify-service", {
      "shipping-service": {
        "pom.xml":
          "<project><artifactId>spring-boot-starter-artemis</artifactId></project>",
        "src/main/java/com/acme/ShippingPublisher.java": [
          "package com.acme;",
          "public class ShippingPublisher {",
          "  private JmsTemplate jmsTemplate;",
          "  public void publish(String id) {",
          '    jmsTemplate.convertAndSend("shipment.dispatched", id);',
          "  }",
          "}"
        ].join("\n")
      },
      "notify-service": {
        "pom.xml":
          "<project><artifactId>spring-boot-starter-artemis</artifactId></project>",
        "src/main/java/com/acme/DispatchListener.java": [
          "package com.acme;",
          "import org.springframework.jms.annotation.JmsListener;",
          "public class DispatchListener {",
          '  @JmsListener(destination = "shipment.dispatched")',
          "  public void onDispatched(String id) { }",
          "}"
        ].join("\n")
      }
    });

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: fixture.workspaceRoot
    });

    expect(analysis.interlinks).toContainEqual(
      expect.objectContaining({
        kind: "messaging",
        method: "jms",
        path: "shipment.dispatched",
        fromRepo: "shipping-service",
        toRepo: "notify-service",
        confidence: "high"
      })
    );
  });

  it("does not match a producer and consumer on different channel names", async () => {
    const fixture = await createTwoRepoWorkspace("order-service", "invoice-service", {
      "order-service": {
        "package.json": JSON.stringify({ dependencies: { kafkajs: "^2.0.0" } }),
        "src/producer.ts": "producer.send({ topic: 'order.created', messages: [] });"
      },
      "invoice-service": {
        "pom.xml": "<project><artifactId>spring-kafka</artifactId></project>",
        "src/main/java/com/acme/Listener.java": [
          "package com.acme;",
          "import org.springframework.kafka.annotation.KafkaListener;",
          "public class Listener {",
          '  @KafkaListener(topics = "invoice.created")',
          "  public void onMessage(String payload) { }",
          "}"
        ].join("\n")
      }
    });

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: fixture.workspaceRoot
    });

    expect(
      analysis.interlinks.filter((interlink) => interlink.kind === "messaging")
    ).toEqual([]);
  });

  it("does not report a messaging interlink within the same repo", async () => {
    const fixture = await createTwoRepoWorkspace("order-service", "unrelated-service", {
      "order-service": {
        "package.json": JSON.stringify({ dependencies: { kafkajs: "^2.0.0" } }),
        "src/producer.ts": "producer.send({ topic: 'order.created', messages: [] });",
        "src/consumer.ts": "consumer.subscribe({ topic: 'order.created' });"
      },
      "unrelated-service": {
        "package.json": JSON.stringify({ name: "unrelated" }),
        "src/index.ts": "export const noop = () => {};"
      }
    });

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: fixture.workspaceRoot
    });

    expect(
      analysis.interlinks.some(
        (interlink) =>
          interlink.kind === "messaging" && interlink.fromRepo === "order-service"
      )
    ).toBe(false);
  });

  it("resolves a Kafka topic held in a named constant, not only a repeated literal", async () => {
    const fixture = await createTwoRepoWorkspace("order-service", "invoice-service", {
      "order-service": {
        "pom.xml": "<project><artifactId>spring-kafka</artifactId></project>",
        "src/main/java/com/acme/OrderPublisher.java": [
          "package com.acme;",
          "public class OrderPublisher {",
          '  private static final String ORDER_TOPIC = "order.created";',
          "  private KafkaTemplate kafkaTemplate;",
          "  public void publish(String order) {",
          "    kafkaTemplate.send(ORDER_TOPIC, order);",
          "  }",
          "}"
        ].join("\n")
      },
      "invoice-service": {
        "pom.xml": "<project><artifactId>spring-kafka</artifactId></project>",
        "src/main/java/com/acme/OrderListener.java": [
          "package com.acme;",
          "import org.springframework.kafka.annotation.KafkaListener;",
          "public class OrderListener {",
          '  @KafkaListener(topics = "order.created")',
          "  public void onOrderCreated(String payload) { }",
          "}"
        ].join("\n")
      }
    });

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: fixture.workspaceRoot
    });

    expect(analysis.interlinks).toContainEqual(
      expect.objectContaining({
        kind: "messaging",
        method: "kafka",
        path: "order.created",
        fromRepo: "order-service",
        toRepo: "invoice-service",
        confidence: "high"
      })
    );
  });

  it("resolves an HTTP client path held in a JS constant", async () => {
    const fixture = await createTwoRepoWorkspace("web-app", "api-repo", {
      "web-app": {
        "package.json": JSON.stringify({ dependencies: { axios: "^1.6.0" } }),
        "src/invoiceClient.ts": [
          "import axios from 'axios';",
          "const INVOICES_PATH = '/invoices';",
          "export function loadInvoices() {",
          "  return axios.get(INVOICES_PATH);",
          "}"
        ].join("\n")
      },
      "api-repo": {
        "package.json": JSON.stringify({ dependencies: { express: "^4.18.0" } }),
        "src/server.ts":
          "import express from 'express'; const app = express(); app.get('/invoices', handler);"
      }
    });

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: fixture.workspaceRoot
    });

    expect(analysis.interlinks).toContainEqual(
      expect.objectContaining({
        kind: "http-route",
        method: "GET",
        path: "/invoices",
        fromRepo: "web-app",
        toRepo: "api-repo",
        confidence: "high"
      })
    );
  });

  it("does not fabricate a route path from an unresolved Spring mapping constant", async () => {
    const repoRoot = await createRepo({
      "pom.xml": "<project><artifactId>spring-boot-starter-web</artifactId></project>",
      "src/main/java/com/acme/InvoiceController.java": [
        "import org.springframework.web.bind.annotation.*;",
        "@RestController",
        "public class InvoiceController {",
        // INVOICE_PATH is referenced but never declared in this file --
        // unresolvable, so this must not become a route at "/INVOICE_PATH".
        "@GetMapping(INVOICE_PATH)",
        "void list() {}",
        "}"
      ].join("\n")
    });

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: repoRoot
    });

    expect(
      analysis.routes.some((route) => route.routePath.includes("INVOICE_PATH"))
    ).toBe(false);
  });
});

async function createTwoRepoWorkspace(
  firstName: string,
  secondName: string,
  repos: Record<string, Record<string, string>>
): Promise<{ workspaceRoot: string }> {
  const parent = await mkdtemp(path.join(tmpdir(), "copilot-advanced-messaging-"));
  const workspaceRoot = path.join(parent, "workspace");
  const repoRoots: Record<string, string> = {};

  await mkdir(workspaceRoot, { recursive: true });
  for (const [name, files] of Object.entries(repos)) {
    const repoRoot = path.join(parent, name);
    repoRoots[name] = repoRoot;
    await createRepoAt(repoRoot, files);
  }

  await mkdir(path.join(workspaceRoot, ".copilot-architect"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, ".copilot-architect", "workspace.json"),
    JSON.stringify(
      {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        workspaceName: "Messaging Workspace",
        workspaceRoot,
        artifactRoot: path.join(workspaceRoot, ".copilot-architect"),
        repos: [
          { name: firstName, path: repoRoots[firstName], role: "backend" },
          { name: secondName, path: repoRoots[secondName], role: "backend" }
        ],
        repoRoots: []
      },
      null,
      2
    ),
    "utf8"
  );

  await new WorkspaceService().createWorkspaceMap({ startPath: workspaceRoot });

  return { workspaceRoot };
}

async function createFeignWorkspaceFixture(): Promise<{
  workspaceRoot: string;
  invoiceService: string;
  orderService: string;
}> {
  const parent = await mkdtemp(path.join(tmpdir(), "copilot-advanced-feign-"));
  const workspaceRoot = path.join(parent, "workspace");
  const invoiceService = path.join(parent, "invoice-service");
  const orderService = path.join(parent, "order-service");

  await mkdir(workspaceRoot, { recursive: true });
  await createRepoAt(invoiceService, {
    "pom.xml": "<project><artifactId>spring-boot-starter-web</artifactId></project>",
    "src/main/java/com/acme/InvoiceController.java": [
      "import org.springframework.web.bind.annotation.*;",
      "@RestController",
      '@RequestMapping("/invoices")',
      "public class InvoiceController {",
      '@PostMapping("/{id}/approve")',
      "void approve() {}",
      "}"
    ].join("\n")
  });
  await createRepoAt(orderService, {
    "pom.xml":
      "<project><artifactId>spring-cloud-starter-openfeign</artifactId></project>",
    "src/main/java/com/acme/InvoiceClient.java": [
      "import org.springframework.cloud.openfeign.FeignClient;",
      "import org.springframework.web.bind.annotation.*;",
      '@FeignClient(name = "invoice-service")',
      "public interface InvoiceClient {",
      '@PostMapping("/invoices/{id}/approve")',
      "void approveInvoice(@PathVariable String id);",
      "}"
    ].join("\n")
  });
  await mkdir(path.join(workspaceRoot, ".copilot-architect"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, ".copilot-architect", "workspace.json"),
    JSON.stringify(
      {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        workspaceName: "Feign Workspace",
        workspaceRoot,
        artifactRoot: path.join(workspaceRoot, ".copilot-architect"),
        repos: [
          { name: "invoice-service", path: invoiceService, role: "backend" },
          { name: "order-service", path: orderService, role: "backend" }
        ],
        repoRoots: []
      },
      null,
      2
    ),
    "utf8"
  );

  return { workspaceRoot, invoiceService, orderService };
}

async function createMultiRepoWorkspaceFixture(): Promise<{
  workspaceRoot: string;
  apiRepo: string;
  webRepo: string;
}> {
  const parent = await mkdtemp(path.join(tmpdir(), "copilot-advanced-workspace-"));
  const workspaceRoot = path.join(parent, "workspace");
  const apiRepo = path.join(parent, "api-repo");
  const webRepo = path.join(parent, "web-repo");

  await mkdir(workspaceRoot, { recursive: true });
  await createRepoAt(apiRepo, {
    "package.json": JSON.stringify({
      scripts: { build: "tsc", test: "vitest run" },
      dependencies: { express: "^4.18.0" }
    }),
    "src/server.ts":
      "import express from 'express'; const app = express(); app.get('/invoices', handler);",
    "src/server.test.ts": "test('server', () => {})"
  });
  await createRepoAt(webRepo, {
    "package.json": JSON.stringify({
      scripts: { build: "vite build", test: "vitest run" },
      dependencies: { react: "^18.2.0" }
    }),
    "src/App.tsx": "export function App() { return null; }",
    "src/App.test.tsx": "test('app', () => {})"
  });
  await mkdir(path.join(workspaceRoot, ".copilot-architect"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, ".copilot-architect", "workspace.json"),
    JSON.stringify(
      {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        workspaceName: "Multi Repo Workspace",
        workspaceRoot,
        artifactRoot: path.join(workspaceRoot, ".copilot-architect"),
        repos: [
          { name: "api-repo", path: apiRepo, role: "backend" },
          { name: "web-repo", path: webRepo, role: "frontend" }
        ],
        repoRoots: []
      },
      null,
      2
    ),
    "utf8"
  );

  return { workspaceRoot, apiRepo, webRepo };
}

async function createRepoAt(
  repoRoot: string,
  files: Record<string, string>
): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }
}

async function createRepo(files: Record<string, string>): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-advanced-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }

  return repoRoot;
}

async function initializeGitRepo(repoRoot: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await commitAll(repoRoot, "initial");
}

async function commitAll(repoRoot: string, message: string): Promise<void> {
  await execFileAsync("git", ["add", "."], { cwd: repoRoot });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Copilot Architect",
      "-c",
      "user.email=copilot-architect@example.test",
      "commit",
      "-m",
      message
    ],
    { cwd: repoRoot }
  );
}

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}
