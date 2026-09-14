import type { RedactionResult } from "./models.js";

interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string | ((match: string, ...args: string[]) => string);
}

export class SecretRedactionService {
  redact(text: string): RedactionResult {
    const redactionsApplied = new Set<string>();
    let redacted = text;

    for (const rule of redactionRules) {
      redacted = redacted.replace(rule.pattern, (...args: string[]) => {
        redactionsApplied.add(rule.name);
        return typeof rule.replacement === "function"
          ? rule.replacement(args[0] ?? "", ...args.slice(1))
          : rule.replacement;
      });
    }

    return {
      text: redacted,
      redactionsApplied: [...redactionsApplied]
    };
  }
}

const redactionRules: RedactionRule[] = [
  {
    name: "env-secret",
    pattern:
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|AUTH_KEY|PRIVATE_KEY|CLIENT_SECRET|SIGNING_KEY|ENCRYPTION_KEY)[A-Z0-9_]*)=([^\s]+)/gi,
    replacement: (_match: string, key: string) => `${key}=[REDACTED]`
  },
  {
    name: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    replacement: "Bearer [REDACTED]"
  },
  {
    name: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9_]+/g,
    replacement: "[REDACTED_GITHUB_TOKEN]"
  },
  {
    name: "aws-access-key-id",
    pattern: /\b(?:AKIA|ASIA|AROA|AIPA|ANPA|ANVA|APKA)[A-Z0-9]{16}\b/g,
    replacement: "[REDACTED_AWS_KEY_ID]"
  },
  {
    name: "aws-secret-access-key",
    pattern:
      /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*[A-Za-z0-9/+=]{40}/gi,
    replacement: "[REDACTED_AWS_SECRET]"
  },
  {
    name: "gcp-api-key",
    pattern: /AIza[A-Za-z0-9_-]{35}/g,
    replacement: "[REDACTED_GCP_KEY]"
  },
  {
    name: "stripe-secret-key",
    pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{24,}/g,
    replacement: "[REDACTED_STRIPE_SECRET]"
  },
  {
    name: "stripe-publishable-key",
    pattern: /\bpk_(?:live|test)_[A-Za-z0-9]{24,}/g,
    replacement: "[REDACTED_STRIPE_PK]"
  },
  {
    name: "stripe-restricted-key",
    pattern: /\brk_(?:live|test)_[A-Za-z0-9]{24,}/g,
    replacement: "[REDACTED_STRIPE_RK]"
  },
  {
    name: "pem-private-key",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY_BLOCK]"
  },
  {
    name: "jwt-token",
    pattern: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replacement: "[REDACTED_JWT]"
  },
  {
    name: "db-connection-string",
    pattern: /(?:postgres|mysql|mongodb|redis|mssql|sqlserver):\/\/[^\s@]*:[^\s@]+@/gi,
    replacement: (_match: string) =>
      _match.replace(/\/\/[^\s@]*:[^\s@]+@/, "//[REDACTED]@")
  },
  {
    name: "npm-auth-token",
    pattern: /\b(?:_authToken|npm_token)\s*=\s*[A-Za-z0-9_-]{36,}/gi,
    replacement: "[REDACTED_NPM_TOKEN]"
  },
  {
    name: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]+/g,
    replacement: "[REDACTED_SLACK_TOKEN]"
  }
];
