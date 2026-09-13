import { ArrowLeft, ChevronRight, Loader2, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Textarea } from "./components/ui/textarea";
import { providerLabel, safeExternalUrl } from "./lib/utils";

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

type Props = {
  providers: Provider[];
  auth?: AuthState;
  selected: { provider: string; model: string };
  api: <T>(path: string, body?: unknown) => Promise<T>;
  refresh: () => Promise<void>;
  onClose: () => void;
};

function credentialDescription(provider: Provider) {
  if (!provider.authenticated) return "Not connected";
  if (provider.credentialSource === "environment")
    return provider.credentialLabel || "From environment";
  if (provider.credentialSource?.startsWith("models_json"))
    return "From model configuration";
  return "Saved credentials";
}

export function ProviderDialog({
  providers,
  auth,
  selected,
  api,
  refresh,
  onClose,
}: Props) {
  const [view, setView] = useState<
    "overview" | "catalog" | "setup" | "success" | "custom"
  >(auth?.busy ? "setup" : "overview");
  const [providerId, setProviderId] = useState(
    auth?.busy ? auth.provider || "" : "",
  );
  const [method, setMethod] = useState<"api_key" | "oauth">("oauth");
  const [key, setKey] = useState("");
  const [answer, setAnswer] = useState("");
  const [search, setSearch] = useState("");
  const [modelId, setModelId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [customName, setCustomName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelIds, setModelIds] = useState("");
  const [noAuth, setNoAuth] = useState(false);
  const completed = useRef(auth?.completedCount || 0);
  const submitted = useRef(!!auth?.busy);
  const requesting = useRef(false);
  const provider = providers.find((item) => item.id === providerId);
  const activeAuth = auth?.provider === providerId ? auth : undefined;
  const busy = pending || !!auth?.busy;
  const models = provider?.models || [];
  const chosenModel = models.some((item) => item.id === modelId)
    ? modelId
    : selected.provider === providerId &&
        models.some((item) => item.id === selected.model)
      ? selected.model
      : models[0]?.id || "";
  const methods = provider?.authMethods || [];
  const url = safeExternalUrl(activeAuth?.url);

  useEffect(() => {
    if ((auth?.completedCount || 0) !== completed.current) {
      completed.current = auth?.completedCount || 0;
      if (submitted.current) {
        setView("success");
        submitted.current = false;
        setNotice("");
      }
    }
  }, [auth?.completedCount]);
  useEffect(() => {
    if (auth?.busy || auth?.request) {
      setView("setup");
      if (auth.provider) setProviderId(auth.provider);
    }
  }, [auth?.busy, auth?.provider, auth?.request?.requestId]);
  useEffect(() => {
    setAnswer("");
  }, [activeAuth?.request?.requestId]);

  async function action(path: string, body: unknown = {}, done?: () => void) {
    if (requesting.current) return;
    requesting.current = true;
    setPending(true);
    setError("");
    setNotice("");
    try {
      await api(path, body);
      await refresh();
      done?.();
    } catch (reason) {
      submitted.current = false;
      setError(
        reason instanceof Error ? reason.message : "Provider request failed.",
      );
    } finally {
      requesting.current = false;
      setPending(false);
    }
  }

  async function close() {
    if (pending) return;
    setKey("");
    setAnswer("");
    if (auth?.busy) await action("/api/auth/cancel", {}, onClose);
    else onClose();
  }

  function navigate(next: typeof view) {
    if (busy) return;
    setKey("");
    setAnswer("");
    setError("");
    setNotice("");
    submitted.current = false;
    setView(next);
  }

  function choose(item: Provider) {
    if (busy) return;
    navigate("setup");
    setProviderId(item.id);
    setModelId("");
    setMethod(
      item.authMethods?.find((option) => option.type === "oauth")?.type ||
        item.authMethods?.[0]?.type ||
        "api_key",
    );
  }

  function login(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !provider) return;
    const apiKey = key.trim();
    setKey("");
    submitted.current = true;
    void action("/api/auth/login", {
      provider: providerId,
      authType: method,
      ...(method === "api_key" && apiKey ? { apiKey } : {}),
    });
  }

  function saveCustom(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const id = `custom-${customName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")}`;
    if (id.length <= 7 || id.length > 64) {
      setError(
        "Enter a provider name containing letters or numbers (up to 57 characters).",
      );
      return;
    }
    if (providers.some((item) => item.id === id)) {
      setError("A provider with this name already exists.");
      return;
    }
    const parsedModels = [
      ...new Set(
        modelIds
          .split(/[\n,]/)
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ].map((value) => ({ id: value }));
    if (!parsedModels.length) {
      setError("Enter at least one model ID.");
      return;
    }
    const apiKey = key.trim();
    setKey("");
    setProviderId(id);
    void action(
      "/api/auth/provider",
      {
        id,
        name: customName.trim(),
        baseUrl: baseUrl.trim(),
        models: parsedModels,
        ...(!noAuth && apiKey ? { apiKey } : {}),
      },
      () => setView("success"),
    );
  }

  const modelPicker = models.length ? (
    <div className="grid gap-2">
      <Label htmlFor="provider-model">Model</Label>
      <select
        id="provider-model"
        className="flex h-8 w-full rounded-sm border border-line bg-surface px-2.5 text-[13px] outline-none transition-colors hover:border-line-strong focus-visible:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent/15 disabled:cursor-not-allowed disabled:opacity-50"
        value={chosenModel}
        disabled={busy}
        onChange={(event) => setModelId(event.target.value)}
      >
        {models.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name || item.id}
          </option>
        ))}
      </select>
      <Button
        disabled={busy || !chosenModel}
        onClick={() =>
          void action(
            "/api/settings",
            { provider: providerId, model: chosenModel },
            onClose,
          )
        }
      >
        Use this model
      </Button>
      <p className="text-xs text-muted">
        Your current model stays selected until you choose another. Model access
        is checked when you send a message.
      </p>
    </div>
  ) : (
    <p className="text-sm text-muted">
      No models are available yet. Refresh the provider after completing setup.
    </p>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          {view !== "overview" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mb-1 w-fit -ml-2"
              disabled={busy}
              onClick={() =>
                navigate(
                  view === "setup" || view === "custom" ? "catalog" : "overview",
                )
              }
            >
              <ArrowLeft className="size-3.5" />
              Back
            </Button>
          )}
          <DialogTitle>
            {view === "overview"
              ? "Model providers"
              : view === "catalog"
                ? "Add provider"
                : view === "custom"
                  ? "Custom provider"
                  : view === "success"
                    ? "Provider connected"
                    : provider?.name || providerId || "Provider setup"}
          </DialogTitle>
          <DialogDescription>
            {view === "overview"
              ? "Manage the model providers available to Revcode."
              : view === "catalog"
                ? "Choose a provider supported by Pi."
                : view === "success"
                  ? "Choose a model to use, or keep your current selection."
                  : "Configure access and choose a model."}
          </DialogDescription>
        </DialogHeader>

        {view === "overview" && (
          <>
            <div className="grid gap-2">
              {providers
                .filter((item) => item.authenticated)
                .map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="flex items-center gap-3 rounded-md border border-line p-3 text-left hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    disabled={busy}
                    onClick={() => choose(item)}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{item.name || item.id}</p>
                      <p className="text-xs text-muted">
                        {credentialDescription(item)} · {item.models.length} models
                      </p>
                    </div>
                    <ChevronRight className="size-4 shrink-0 text-muted" />
                  </button>
                ))}
            </div>
            {!providers.some((item) => item.authenticated) && (
              <div className="rounded-md border border-dashed border-line p-6 text-center">
                <p className="text-sm font-medium">Connect your first provider</p>
                <p className="mt-1 text-xs text-muted">
                  Choose browser sign-in or an API key. Existing credentials appear
                  here when available to the local host.
                </p>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={busy} onClick={() => navigate("catalog")}>
                Add provider
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void action("/api/auth/refresh", {}, () =>
                    setNotice("Provider list refreshed."),
                  )
                }
              >
                Refresh providers
              </Button>
            </div>
          </>
        )}

        {view === "catalog" && (
          <>
            <div className="relative">
              <Search className="absolute left-3 top-2.5 size-4 text-muted" />
              <Input
                id="provider-search"
                aria-label="Search providers"
                className="pl-9"
                placeholder="Search providers"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <div className="grid max-h-72 gap-1 overflow-y-auto">
              {providers
                .filter((item) =>
                  `${item.name || ""} ${item.id}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="flex items-center gap-3 rounded-md p-3 text-left hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    onClick={() => choose(item)}
                  >
                    <div className="flex-1">
                      <p className="text-sm font-medium">{item.name || item.id}</p>
                      <p className="text-xs text-muted">
                        {item.authMethods
                          ?.map((option) => option.label)
                          .join(" · ") || "External configuration"}
                      </p>
                    </div>
                    <span className="text-xs text-accent">
                      {item.authenticated ? "Connected" : ""}
                    </span>
                    {!item.authenticated && (
                      <ChevronRight className="size-4 text-muted" />
                    )}
                  </button>
                ))}
            </div>
            {!providers.some((item) =>
              `${item.name || ""} ${item.id}`
                .toLowerCase()
                .includes(search.toLowerCase()),
            ) && <p className="text-sm text-muted">No matching providers.</p>}
            <Button onClick={() => navigate("custom")}>Custom provider</Button>
          </>
        )}

        {view === "custom" && (
          <form className="grid gap-3" onSubmit={saveCustom}>
            <p className="text-sm text-muted">
              Connect a local server or an OpenAI-compatible Chat Completions
              endpoint.
            </p>
            <div className="grid gap-1.5">
              <Label htmlFor="custom-name">Provider name</Label>
              <Input
                id="custom-name"
                value={customName}
                onChange={(event) => setCustomName(event.target.value)}
                placeholder="My local server"
                maxLength={57}
                required
                disabled={busy}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="custom-url">Base URL</Label>
              <Input
                id="custom-url"
                type="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="http://localhost:1234/v1"
                required
                disabled={busy}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="custom-models">Model IDs</Label>
              <Textarea
                id="custom-models"
                value={modelIds}
                onChange={(event) => setModelIds(event.target.value)}
                placeholder="One model ID per line"
                required
                disabled={busy}
                rows={3}
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-ink-soft">
              <input
                type="checkbox"
                checked={noAuth}
                onChange={(event) => {
                  setNoAuth(event.target.checked);
                  setKey("");
                }}
                disabled={busy}
              />
              This endpoint needs no authentication
            </label>
            {!noAuth && (
              <div className="grid gap-1.5">
                <Label htmlFor="custom-key">API key</Label>
                <Input
                  id="custom-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  required
                  disabled={busy}
                />
              </div>
            )}
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save and continue"}
            </Button>
          </form>
        )}

        {view === "success" && (
          <>
            <div
              className="rounded-md border border-accent/20 bg-accent-soft px-3 py-2 text-sm text-accent"
              role="status"
            >
              {provider?.name || providerId} connected.
            </div>
            {modelPicker}
            <Button variant="ghost" disabled={busy} onClick={() => void close()}>
              Done
            </Button>
          </>
        )}

        {view === "setup" && (
          <>
            {provider?.authenticated && (
              <div className="rounded-md border border-line p-4">
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted">
                  Connected · {credentialDescription(provider)}
                </p>
                <div className="mt-3">{modelPicker}</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void action(
                        "/api/auth/refresh",
                        { provider: providerId },
                        () => setNotice("Provider models refreshed."),
                      )
                    }
                  >
                    Refresh models
                  </Button>
                  {provider.canLogout && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-danger"
                      disabled={busy}
                      onClick={() =>
                        void action(
                          "/api/auth/logout",
                          { provider: providerId },
                          () => setNotice("Saved credentials removed."),
                        )
                      }
                    >
                      Remove saved credentials
                    </Button>
                  )}
                </div>
              </div>
            )}
            <form className="grid gap-3" onSubmit={login}>
              {methods.length > 1 && (
                <div className="grid gap-1.5">
                  <Label htmlFor="provider-method">Sign-in method</Label>
                  <select
                    id="provider-method"
                    className="flex h-8 w-full rounded-sm border border-line bg-surface px-2.5 text-[13px]"
                    value={method}
                    disabled={busy}
                    onChange={(event) => {
                      setMethod(event.target.value as typeof method);
                      setKey("");
                      setError("");
                    }}
                  >
                    {methods.map((item) => (
                      <option value={item.type} key={item.type}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {method === "api_key" &&
                methods.some((item) => item.type === "api_key") && (
                  <div className="grid gap-1.5">
                    <Label htmlFor="provider-key">API key</Label>
                    <Input
                      id="provider-key"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={key}
                      disabled={busy}
                      onChange={(event) => setKey(event.target.value)}
                      placeholder="Paste a key, or continue for guided setup"
                    />
                  </div>
                )}
              {methods.length ? (
                <>
                  <p className="text-xs text-muted">
                    Credentials are managed by Pi on your local host and reused
                    across Revit sessions. Keys and sign-in responses are never
                    saved in browser storage.
                  </p>
                  <Button type="submit" disabled={busy}>
                    {busy
                      ? "Connecting…"
                      : method === "oauth"
                        ? `Sign in with ${provider?.name || providerId}`
                        : "Save and continue"}
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-sm text-muted">
                    This provider uses external configuration. Configure its
                    credentials in the host environment, then refresh providers.
                  </p>
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void action("/api/auth/refresh", { provider: providerId })
                    }
                  >
                    Check again
                  </Button>
                </>
              )}
            </form>
          </>
        )}

        {activeAuth?.busy && (
          <div
            className="rounded-md border border-accent/20 bg-accent-soft px-3 py-2 text-sm text-accent"
            role="status"
          >
            <p>
              {activeAuth.notice ||
                "Complete the provider sign-in to continue."}
            </p>
            {activeAuth.userCode && (
              <div className="mt-2">
                <span className="text-[10px] uppercase tracking-wider">Device code</span>
                <code className="mt-1 block text-lg tracking-widest">
                  {activeAuth.userCode}
                </code>
              </div>
            )}
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-2 inline-block text-sm underline underline-offset-2"
              >
                Open sign-in ↗
              </a>
            )}
          </div>
        )}
        {activeAuth?.busy && activeAuth.request && (
          <form
            className="grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const value = answer;
              setAnswer("");
              void action("/api/auth/respond", {
                requestId: activeAuth.request!.requestId,
                value,
              });
            }}
          >
            <Label htmlFor="auth-response">{activeAuth.request.prompt}</Label>
            {activeAuth.request.type === "select" ? (
              <select
                id="auth-response"
                aria-label={activeAuth.request.prompt}
                className="flex h-8 w-full rounded-sm border border-line bg-surface px-2.5 text-[13px]"
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                disabled={pending}
                required
              >
                <option value="">Select an option</option>
                {activeAuth.request.options?.map((option) => (
                  <option value={option.id} key={option.id}>
                    {option.label}
                    {option.description ? ` — ${option.description}` : ""}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id="auth-response"
                aria-label={activeAuth.request.prompt}
                type={
                  activeAuth.request.password ||
                  activeAuth.request.type === "secret"
                    ? "password"
                    : "text"
                }
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  activeAuth.request.placeholder || "Paste your response"
                }
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                disabled={pending}
                required
              />
            )}
            <Button type="submit" disabled={pending || !answer.trim()}>
              Continue sign-in
            </Button>
          </form>
        )}
        {notice && (
          <p role="status" className="rounded-md bg-surface-muted px-3 py-2 text-sm text-ink-soft">
            {notice}
          </p>
        )}
        {(error || activeAuth?.error) && (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            {error || activeAuth?.error}
          </p>
        )}
        {auth?.busy && (
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => {
              submitted.current = false;
              setAnswer("");
              void action("/api/auth/cancel", {}, () =>
                setNotice("Setup cancelled."),
              );
            }}
          >
            Cancel setup
          </Button>
        )}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Loader2 className="size-3.5 animate-spin" />
            Working…
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
