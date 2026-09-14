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
