export type Provider = {
  id: string;
  name?: string;
  models: { id: string; name: string }[];
  authenticated?: boolean;
  authMethods?: { type: "api_key" | "oauth"; label: string }[];
  credentialSource?: string;
  credentialLabel?: string;
  canLogout?: boolean;
};

export type AuthState = {
  provider?: string;
  busy: boolean;
  notice?: string;
  url?: string;
  userCode?: string;
  error?: string;
  completedCount: number;
  request?: {
    requestId: string;
    prompt: string;
    placeholder?: string;
    password?: boolean;
    type: "text" | "secret" | "manual_code" | "select";
    options?: { id: string; label: string; description?: string }[];
  };
};
