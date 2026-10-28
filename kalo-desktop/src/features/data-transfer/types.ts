export type TransferKind = "memory" | "archive" | "note" | "domain" | "attachment";
export type TransferChoice = "keepBoth" | "keepLocal" | "replace" | "stage";
export interface TransferScopes { memory: boolean; notes: boolean }
export interface TransferEntry { kind: TransferKind; path: string; bytes: number; sha256: string }
export interface TransferItem {
  source: string; target: string; kind: TransferKind; status: string; choice: TransferChoice;
  incomingHash: string; localHash: string | null; beforeHash: string | null; afterHash: string;
}
export interface TransferManifest {
  format: string; formatVersion: number; exportId: string; exportedAtMs: number; appVersion: string;
  scopes: TransferScopes; directories: string[]; entries: TransferEntry[]; warnings: string[];
}
export interface TransferPreview { operationId: string; mode: "export" | "import"; manifest: TransferManifest; items: TransferItem[]; revision: string }
export interface TransferJournal { id: string; createdAtMs: number; state: string; items: TransferItem[]; directories: string[] }
export interface TransferStatus { maintenance: boolean; armed: boolean; recoveryError: string | null }
export interface TransferProgress { phase: string; completed: number; total: number }
export interface TransferDetails { local: string; incoming: string }
export interface TransferDecision { path: string; choice: TransferChoice }
