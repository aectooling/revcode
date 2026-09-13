export interface Context {
  instanceId: string; revitVersion: string; revitBuild: string; runtime: string;
  document: null | { token: string; title: string; isFamily: boolean; isReadOnly: boolean; activeView: string; selection: string[] };
  documents?: NonNullable<Context['document']>[];
}
export interface ExecuteInput { code: string; usings?: string[]; mode: 'query' | 'modify' | 'api'; documentToken?: string | null; transactionName?: string }
export interface Operation extends ExecuteInput {
  operationId: string; documentToken: string | null; createdAt: string; status: string;
  result?: unknown; logs?: string[]; diagnostics?: unknown[]; error?: string; transactionStatus?: string; elapsedMs?: number;
}
export interface Settings { provider: string; model: string; configured: boolean }
export interface Message { id: string; role: 'user' | 'assistant' | 'system'; text: string }
export interface ProviderSummary { id: string; name?: string; models: { id: string; name: string }[]; authenticated?: boolean; authMethods?: { type: 'api_key' | 'oauth'; label: string }[]; credentialSource?: string; credentialLabel?: string; canLogout?: boolean }
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
  prompt(text: string, settings: Settings, context: Context, history: Message[], execute: (input: ExecuteInput, signal?: AbortSignal) => Promise<Operation>, update: (text: string) => void): Promise<void>;
  abort(): Promise<void>;
}
