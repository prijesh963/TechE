import type { IntegrationCategory, IntegrationInfo } from "@copilot-architect/shared";

import type { AdapterFile } from "./types.js";

/**
 * Integration detection is deliberately NOT part of the language adapters.
 * The same broker or datastore shows up in a Maven pom, an npm package.json, a
 * requirements.txt or a Spring `application.yml`, so detecting it per-adapter
 * would mean repeating every signal in every adapter. Running one pass over
 * all files instead means a Java + Oracle + Kafka repo composes from three
 * independent detections rather than needing a "java-oracle-kafka" case.
 */
interface IntegrationSignal {
  name: string;
  category: IntegrationCategory;
  ecosystem: string;
  /**
   * Strong signals (a declared dependency, a driver class, a connection URL)
   * are enough on their own for high confidence. Content-only, so it stays
   * `[]` for a signal that is identified by its filename instead — see
   * `strongPath`.
   */
  strong: RegExp[];
  /**
   * Weak signals (a bare keyword that could appear in prose or a comment) only
   * produce a medium-confidence result, and only when no strong signal matched.
   */
  weak?: RegExp[];
  /**
   * Matched against the file's path rather than its content, and checked over
   * every scanned file, not only the ones with readable text — a canonical
   * name like `nx.json` or `docker-compose.yml` is evidence on its own,
   * whether or not the scan captured what is inside it. Same precedent as
   * `context.hasFile("pom.xml")` elsewhere in the adapters: some markers are
   * the filename, not a pattern inside it.
   */
  strongPath?: RegExp[];
}

const INTEGRATION_SIGNALS: IntegrationSignal[] = [
  // --- Datastores -----------------------------------------------------------
  {
    name: "Oracle",
    category: "datastore",
    ecosystem: "any",
    strong: [
      /\bojdbc\d*\b/i,
      /oracle\.jdbc/i,
      /jdbc:oracle:/i,
      /\bOracleDriver\b/,
      /Oracle\w*Dialect/i,
      /com\.oracle\.database/i,
      /\boracledb\b/i
    ]
  },
  {
    name: "MongoDB",
    category: "datastore",
    ecosystem: "any",
    strong: [
      /spring-boot-starter-data-mongodb/i,
      /mongodb-driver/i,
      /\bmongoose\b/i,
      /\bpymongo\b/i,
      /\bmotor\b(?=["'\s,=:])/i,
      /mongodb(?:\+srv)?:\/\//i,
      /@Document\s*\(/,
      /MongoTemplate|MongoRepository/
    ],
    weak: [/\bmongodb\b/i]
  },
  {
    name: "PostgreSQL",
    category: "datastore",
    ecosystem: "any",
    strong: [
      /jdbc:postgresql:/i,
      /org\.postgresql/i,
      /\bpsycopg2?\b/i,
      /postgresql:\/\//i,
      /PostgreSQL\w*Dialect/i
    ]
  },
  {
    name: "MySQL",
    category: "datastore",
    ecosystem: "any",
    strong: [
      /jdbc:mysql:/i,
      /mysql-connector/i,
      /\bmysql2?\b(?=["'\s,=:])/i,
      /MySQL\w*Dialect/i
    ]
  },
  {
    name: "SQL Server",
    category: "datastore",
    ecosystem: "any",
    strong: [/jdbc:sqlserver:/i, /mssql-jdbc/i, /SQLServer\w*Dialect/i],
    weak: [/\bmssql\b/i]
  },
  {
    name: "Redis",
    category: "datastore",
    ecosystem: "any",
    strong: [
      /spring-boot-starter-data-redis/i,
      /\bioredis\b/i,
      /\bjedis\b/i,
      /\blettuce\b/i,
      /redis:\/\//i,
      /RedisTemplate/
    ]
  },

  // --- Messaging ------------------------------------------------------------
  {
    name: "Kafka",
    category: "messaging",
    ecosystem: "any",
    strong: [
      /spring-kafka/i,
      /kafka-clients/i,
      /\bkafkajs\b/i,
      /confluent[-_]kafka/i,
      /@KafkaListener/,
      /KafkaTemplate/,
      /bootstrap\.servers/i,
      /spring\.kafka/i,
      /\borg\.apache\.kafka\b/i
    ],
    weak: [/\bkafka\b/i]
  },
  {
    name: "IBM MQ",
    category: "messaging",
    ecosystem: "java",
    strong: [
      /com\.ibm\.mq/i,
      /mq-jms-spring/i,
      /MQQueueConnectionFactory/,
      /\bibmmq\b/i,
      /ibm\.mq\.jakarta/i
    ]
  },
  {
    name: "JMS",
    category: "messaging",
    ecosystem: "java",
    strong: [
      /javax\.jms/i,
      /jakarta\.jms/i,
      /@JmsListener/,
      /JmsTemplate/,
      /spring-boot-starter-artemis/i,
      /\bspring-jms\b/i,
      /ConnectionFactory\b.*\bQueue\b/
    ],
    weak: [/\bjms\b/i]
  },
  {
    name: "ActiveMQ",
    category: "messaging",
    ecosystem: "java",
    strong: [/spring-boot-starter-activemq/i, /org\.apache\.activemq/i],
    weak: [/\bactivemq\b/i]
  },
  {
    name: "RabbitMQ",
    category: "messaging",
    ecosystem: "any",
    strong: [
      /spring-boot-starter-amqp/i,
      /@RabbitListener/,
      /RabbitTemplate/,
      /\bamqplib\b/i,
      /\bpika\b(?=["'\s,=:])/i,
      /amqp:\/\//i
    ],
    weak: [/\brabbitmq\b/i]
  },

  // --- Micro-frontend -------------------------------------------------------
  {
    name: "Module Federation",
    category: "micro-frontend",
    ecosystem: "node",
    strong: [
      /ModuleFederationPlugin/,
      /@module-federation/i,
      /vite-plugin-federation/i,
      /@originjs\/vite-plugin-federation/i
    ]
  },
  {
    name: "single-spa",
    category: "micro-frontend",
    ecosystem: "node",
    strong: [
      /\bsingle-spa\b/i,
      /single-spa-react/i,
      /single-spa-angular/i,
      /registerApplication\s*\(/
    ]
  },
  {
    name: "Web Components",
    category: "micro-frontend",
    ecosystem: "node",
    strong: [/customElements\.define\s*\(/, /@angular\/elements/i, /\blit-element\b/i]
  },

  // --- Microservice platform ------------------------------------------------
  {
    name: "Spring Cloud",
    category: "microservice",
    ecosystem: "java",
    strong: [/spring-cloud-starter/i, /spring-cloud-dependencies/i]
  },
  {
    name: "Service Discovery",
    category: "microservice",
    ecosystem: "java",
    strong: [/\beureka\b/i, /@EnableDiscoveryClient/, /spring-cloud-starter-consul/i]
  },
  {
    name: "API Gateway",
    category: "microservice",
    ecosystem: "java",
    // Both `spring-cloud-gateway` and the more common
    // `spring-cloud-starter-gateway` artifact id.
    strong: [/spring-cloud-(?:starter-)?gateway/i, /@EnableZuulProxy/]
  },
  {
    name: "OpenFeign",
    category: "microservice",
    ecosystem: "java",
    strong: [/openfeign/i, /@FeignClient/]
  },

  // --- Orchestration ----------------------------------------------------------
  // How services are wired and deployed together, not how one is written. A
  // repo can be microservice-shaped without Spring Cloud at all — plain
  // services behind Kubernetes or Compose is the more common case outside
  // the Java ecosystem — so this is what actually catches that shape.
  {
    name: "Kubernetes",
    category: "orchestration",
    ecosystem: "any",
    strongPath: [
      /(^|\/)(k8s|kubernetes|manifests?)\/.*\.ya?ml$/i,
      /(^|\/)kustomization\.ya?ml$/i
    ],
    // Manifests live under all sorts of folder names in practice, so content
    // matters here too: `apiVersion` is close to unique to Kubernetes/Helm
    // YAML, and `kind` is checked against a real Kubernetes resource list
    // rather than left bare — a config file can have an unrelated `kind`
    // field for something else entirely.
    strong: [
      /^apiVersion:\s*\S+/m,
      /^kind:\s*(Deployment|Service|StatefulSet|DaemonSet|Ingress|Job|CronJob|Namespace|ConfigMap|ReplicaSet|PersistentVolumeClaim)\s*$/m
    ]
  },
  {
    name: "Helm",
    category: "orchestration",
    ecosystem: "any",
    // Chart.yaml is Helm's own required, canonical file — as reliable a
    // marker as pom.xml is for Maven.
    strongPath: [/(^|\/)Chart\.ya?ml$/i],
    strong: [/helm\.sh\/chart/i]
  },
  {
    name: "Docker Compose",
    category: "orchestration",
    ecosystem: "any",
    strongPath: [
      /(^|\/)docker-compose(\.[\w.-]+)?\.ya?ml$/i,
      /(^|\/)compose(\.[\w.-]+)?\.ya?ml$/i
    ],
    // No reliable content signal without parsing YAML — `services:` alone is
    // too generic to trust on its own — so this relies on the filename,
    // which in practice is unambiguous.
    strong: []
  },

  // --- Monorepo build tooling -------------------------------------------------
  // Wires multiple projects — several micro-frontends, or several services —
  // together in one repo with a real dependency graph between them, which is
  // exactly the thing "the change looked isolated but wasn't" comes from.
  {
    name: "Nx",
    category: "monorepo-tooling",
    ecosystem: "node",
    strongPath: [/(^|\/)nx\.json$/i],
    strong: [/"@nx\/workspace"|"@nrwl\/workspace"/, /"nx":\s*\{/]
  },
  {
    name: "Turborepo",
    category: "monorepo-tooling",
    ecosystem: "node",
    strongPath: [/(^|\/)turbo\.json$/i],
    strong: [/"turbo":\s*"[\^~]?\d/]
  }
];

/**
 * Files worth scanning for integration signals. Manifests and config carry the
 * declared dependency; source carries the annotations and client usage. Docs
 * are excluded on purpose — a README mentioning Kafka is not evidence that the
 * service talks to Kafka.
 */
function isScannable(file: AdapterFile): boolean {
  if (!file.text) return false;
  const lower = file.path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".rst") || lower.endsWith(".txt")) {
    return lower.endsWith("requirements.txt");
  }
  return true;
}

const MAX_EVIDENCE_FILES = 5;

export function detectIntegrations(files: AdapterFile[]): IntegrationInfo[] {
  const scannable = files.filter(isScannable);
  const detected: IntegrationInfo[] = [];

  for (const signal of INTEGRATION_SIGNALS) {
    const strongEvidence = new Set<string>();
    const weakEvidence = new Set<string>();

    // Path signals run over every scanned file, not only the ones with
    // readable text — see the strongPath doc comment on IntegrationSignal.
    if (signal.strongPath) {
      for (const file of files) {
        if (signal.strongPath.some((pattern) => pattern.test(file.path))) {
          strongEvidence.add(file.path);
        }
      }
    }

    for (const file of scannable) {
      const text = file.text as string;
      if (signal.strong.some((pattern) => pattern.test(text))) {
        strongEvidence.add(file.path);
      } else if (signal.weak?.some((pattern) => pattern.test(text))) {
        weakEvidence.add(file.path);
      }
    }

    if (strongEvidence.size === 0 && weakEvidence.size === 0) {
      continue;
    }

    const isStrong = strongEvidence.size > 0;
    detected.push({
      name: signal.name,
      category: signal.category,
      ecosystem: signal.ecosystem,
      confidence: isStrong ? "high" : "medium",
      evidence: [...(isStrong ? strongEvidence : weakEvidence)]
        .slice(0, MAX_EVIDENCE_FILES)
        .sort()
    });
  }

  return detected.sort(
    (left, right) =>
      left.category.localeCompare(right.category) || left.name.localeCompare(right.name)
  );
}
