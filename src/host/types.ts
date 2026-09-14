export interface Context {
  instanceId: string; revitVersion: string; revitBuild: string; runtime: string;
  capturedAt?: string;
  document: null | { token: string; title: string; isFamily: boolean; isReadOnly: boolean; activeView: string; selection: string[] };
  documents?: NonNullable<Context['document']>[];
}
export interface Snippet { code: string; usings?: string[] }
export interface BatchStep extends Snippet { name: string }
export type ExecuteInput = (Snippet & { mode: 'query' | 'modify' | 'api'; documentToken?: string | null; steps?: never; verify?: never } | { mode: 'batch'; documentToken: string; steps: BatchStep[]; verify?: Snippet; code?: never; usings?: never }) & { transactionName?: string };
export type Operation = Omit<ExecuteInput, 'documentToken'> & {
  operationId: string; documentToken: string | null; createdAt: string; status: string;
  runId?: string; toolCallId?: string; documentTitle?: string; documentKind?: 'family' | 'project'; contextCapturedAt?: string; historicalDocumentReference?: boolean; executionMode?: 'execution' | 'manual';
  result?: unknown; logs?: string[]; diagnostics?: unknown[]; error?: string; transactionStatus?: string; elapsedMs?: number;
};
export interface Settings { provider: string; model: string; configured: boolean }
export interface Message { id: string; role: 'user' | 'assistant' | 'system'; text: string; runId?: string }
export interface ProviderSummary { id: string; name?: string; models: { id: string; name: string; supportsImages?: boolean }[]; authenticated?: boolean; authMethods?: { type: 'api_key' | 'oauth'; label: string }[]; credentialSource?: string; credentialLabel?: string; canLogout?: boolean }
export interface AuthState { provider?: string; busy: boolean; notice?: string; url?: string; userCode?: string; error?: string; completedCount: number; request?: { requestId: string; prompt: string; placeholder?: string; password?: boolean; type: 'text' | 'secret' | 'manual_code' | 'select'; options?: readonly { id: string; label: string; description?: string }[] } }
export interface CustomProvider { id: string; name?: string; baseUrl: string; apiKey?: string; models: { id: string; name?: string; supportsImages?: boolean }[] }
export interface Agent {
  providers: ProviderSummary[];
  login?(provider: string, authType: 'api_key' | 'oauth', interaction: import('@earendil-works/pi-ai').AuthInteraction): Promise<void>;
  logout?(provider: string): Promise<void>;
  refresh?(): Promise<void>;
  addProvider?(provider: CustomProvider): Promise<void>;
  configured(provider: string): boolean;
  setKey(provider: string, key: string): Promise<void>;
  prompt(text: string, settings: Settings, context: Context, history: Message[], execute: (input: ExecuteInput, signal?: AbortSignal) => Promise<Operation>, update: (text: string) => void, desktop?: import('./desktop-types.js').DesktopTools, services?: import('./skills.js').RunServices): Promise<void>;
  abort(): Promise<void>;
}
