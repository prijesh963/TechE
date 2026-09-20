import { describe, expect, it } from "vitest";

import { detectIntegrations } from "../packages/adapters/src/index.js";
import type { AdapterFile } from "../packages/adapters/src/index.js";

function file(path: string, text: string): AdapterFile {
  return { path, text };
}

/** Names detected, so assertions read as the stack a human would describe. */
function names(files: AdapterFile[]): string[] {
  return detectIntegrations(files).map((integration) => integration.name);
}

describe("detectIntegrations", () => {
  it("detects a Java + Oracle + Kafka + MQ combination from one pass", () => {
    const detected = detectIntegrations([
      file(
        "pom.xml",
        `<dependency><artifactId>ojdbc11</artifactId></dependency>
         <dependency><artifactId>spring-kafka</artifactId></dependency>
         <dependency><groupId>com.ibm.mq</groupId></dependency>`
      ),
      file(
        "src/main/resources/application.properties",
        "spring.datasource.url=jdbc:oracle:thin:@//db:1521/ORCL"
      )
    ]);

    // Composed per integration — no "java-oracle-kafka-mq" special case.
    expect(detected.map((integration) => integration.name).sort()).toEqual([
      "IBM MQ",
      "Kafka",
      "Oracle"
    ]);
    expect(detected.every((integration) => integration.confidence === "high")).toBe(
      true
    );
    expect(detected.find((i) => i.name === "Oracle")?.category).toBe("datastore");
    expect(detected.find((i) => i.name === "Kafka")?.category).toBe("messaging");
  });

  it("detects micro-frontend platforms", () => {
    expect(
      names([file("webpack.config.js", "new ModuleFederationPlugin({ remotes: {} })")])
    ).toContain("Module Federation");
    expect(
      names([file("src/root.js", "import { registerApplication } from 'single-spa';")])
    ).toContain("single-spa");
  });

  it("detects a Spring Cloud microservice platform", () => {
    const detected = names([
      file("pom.xml", "<artifactId>spring-cloud-starter-gateway</artifactId>"),
      file("src/App.java", "@EnableDiscoveryClient public class App {}"),
      file("src/Client.java", '@FeignClient(name = "orders") interface OrdersClient {}')
    ]);

    expect(detected).toEqual(
      expect.arrayContaining([
        "API Gateway",
        "OpenFeign",
        "Service Discovery",
        "Spring Cloud"
      ])
    );
  });

  it("detects Python and Node datastore clients, not just Java", () => {
    expect(names([file("requirements.txt", "pymongo==4.6.0")])).toContain("MongoDB");
    expect(
      names([file("package.json", '{"dependencies":{"kafkajs":"^2"}}')])
    ).toContain("Kafka");
  });

  it("treats a bare keyword as medium confidence, a real dependency as high", () => {
    // A passing mention in code is not proof the service talks to Mongo.
    const [weak] = detectIntegrations([
      file("src/Notes.java", "// TODO: evaluate mongodb for this cache")
    ]);
    expect(weak).toMatchObject({ name: "MongoDB", confidence: "medium" });

    const [strong] = detectIntegrations([
      file("pom.xml", "<artifactId>spring-boot-starter-data-mongodb</artifactId>")
    ]);
    expect(strong).toMatchObject({ name: "MongoDB", confidence: "high" });
  });

  it("ignores prose in documentation so a README cannot invent an integration", () => {
    expect(
      names([file("README.md", "We might migrate to Kafka and Oracle one day.")])
    ).toEqual([]);
    // requirements.txt is a manifest despite the .txt suffix.
    expect(names([file("requirements.txt", "confluent-kafka==2.3.0")])).toContain(
      "Kafka"
    );
  });

  it("returns nothing for a repo with no integrations", () => {
    expect(
      names([file("src/index.ts", "export const add = (a: number) => a + 1;")])
    ).toEqual([]);
  });
});

describe("orchestration and monorepo build tooling", () => {
  it("detects Kubernetes from manifest content, wherever the file lives", () => {
    // Manifests live under all sorts of folder names in practice, so this
    // has to work without a canonical path.
    const [detected] = detectIntegrations([
      file("config/api-deploy.yaml", "apiVersion: apps/v1\nkind: Deployment\n")
    ]);
    expect(detected).toMatchObject({
      name: "Kubernetes",
      category: "orchestration",
      confidence: "high"
    });
  });

  it("detects Kubernetes from a canonical path alone, with no text captured", () => {
    // The whole point of a path signal: a file the scan never read the
    // content of is still identified by its name, the same way `pom.xml`
    // implies Maven without reading it.
    expect(names([{ path: "k8s/service.yaml" } as unknown as AdapterFile])).toContain(
      "Kubernetes"
    );
  });

  it("does not treat a bare 'kind' field as Kubernetes", () => {
    // `kind` is a common field name outside Kubernetes too. Only a real
    // Kubernetes resource kind should count.
    expect(names([file("config/app.yaml", "kind: custom\nname: something\n")])).toEqual(
      []
    );
  });

  it("detects Helm by its required Chart.yaml, and Kubernetes alongside it", () => {
    // A Helm chart genuinely is a Kubernetes deployment — both names are
    // correct for the same file, not a duplicate.
    const detected = names([
      file("charts/api/Chart.yaml", "apiVersion: v2\nname: api\nversion: 0.1.0\n")
    ]);
    expect(detected).toEqual(expect.arrayContaining(["Helm", "Kubernetes"]));
  });

  it("detects Docker Compose by filename, including a compose override", () => {
    expect(names([file("docker-compose.yml", "services:\n  api: {}\n")])).toContain(
      "Docker Compose"
    );
    expect(names([file("docker-compose.override.yaml", "services: {}")])).toContain(
      "Docker Compose"
    );
    expect(names([file("compose.yml", "services: {}")])).toContain("Docker Compose");
  });

  it("detects Nx by nx.json, and by the workspace dependency without it", () => {
    expect(names([file("nx.json", "{}")])).toContain("Nx");
    expect(
      names([file("package.json", '{"devDependencies":{"@nx/workspace":"18.0.0"}}')])
    ).toContain("Nx");
  });

  it("detects Turborepo by turbo.json, and by the devDependency without it", () => {
    expect(names([file("turbo.json", '{"pipeline":{}}')])).toContain("Turborepo");
    expect(
      names([file("package.json", '{"devDependencies":{"turbo":"^2.0.0"}}')])
    ).toContain("Turborepo");
  });

  it("categorizes the new detections correctly", () => {
    const [k8s] = detectIntegrations([file("k8s/deploy.yaml", "kind: Deployment\n")]);
    expect(k8s.category).toBe("orchestration");

    const [nx] = detectIntegrations([file("nx.json", "{}")]);
    expect(nx.category).toBe("monorepo-tooling");
  });

  it("a Compose-flavored MFE + microservices repo composes from independent signals", () => {
    // The point of the whole detector: an arbitrary real-world combination —
    // here, a Module Federation frontend deployed alongside Feign-based
    // services under Compose — needs no special case.
    const detected = names([
      file("webpack.config.js", "new ModuleFederationPlugin({ remotes: {} })"),
      file("services/orders/Client.java", '@FeignClient(name = "orders")'),
      file("docker-compose.yml", "services:\n  gateway: {}\n  orders: {}\n")
    ]);
    expect(detected).toEqual(
      expect.arrayContaining(["Module Federation", "OpenFeign", "Docker Compose"])
    );
  });
});
