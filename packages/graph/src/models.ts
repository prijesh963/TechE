import type { DiagnosticMessage, GeneratedArtifact } from "@copilot-architect/shared";

export interface SymbolGraphOptions {
  startPath?: string;
  strictRoot?: boolean;
}

export interface SymbolGraphResult {
  repoRoot: string;
  graph: SymbolGraph;
  jsonPath: string;
}

export interface SymbolGraph extends GeneratedArtifact {
  repoRoot: string;
  /**
   * Present only when the graph spans a multi-repo workspace. Node ids are
   * then prefixed with the repo name, so `svc-orders/src/Main.java#Main`.
   */
  repos?: string[];
  nodes: SymbolNode[];
  edges: SymbolEdge[];
  diagnostics: DiagnosticMessage[];
}

/**
 * What a workspace-wide graph build learned, written beside the graph so a
 * caller can decide whether rebuilding is worth it without reading the graph.
 * `crossRepoEdgeCount: 0` means the registered repos share no code.
 */
export interface WorkspaceGraphState {
  schemaVersion: string;
  generatedAt: string;
  repos: string[];
  crossRepoEdgeCount: number;
}

export type SymbolNodeKind = "file" | "class" | "function" | "interface" | "method";

export interface SymbolNode {
  /** Stable: the file path for a file node, `${filePath}#${name}` for a
   *  top-level symbol, `${filePath}#${className}.${methodName}` for a method. */
  id: string;
  kind: SymbolNodeKind;
  name: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  exported: boolean;
}

export type SymbolEdgeKind = "imports" | "calls" | "extends" | "implements";

export interface SymbolEdge {
  kind: SymbolEdgeKind;
  /** SymbolNode id */
  from: string;
  /** SymbolNode id */
  to: string;
}
