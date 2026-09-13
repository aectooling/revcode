import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import type { AuthState, Provider } from "./components/provider-types";

export type { Provider, AuthState } from "./components/provider-types";

type Props = {
  providers: Provider[];
  auth?: AuthState;
  selected: { provider: string; model: string };
  api: <T>(path: string, body?: unknown) => Promise<T>;
  refresh: () => Promise<void>;
  onClose: () => void;
};

const selectClass =
  "h-8 w-full rounded-sm border border-line bg-surface px-2 text-[13px] outline-none transition-colors hover:border-line-strong focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50";

function credentialDescription(provider: Provider) {
  if (!provider.authenticated) return "Not connected";
  if (provider.credentialSource === "environment")
    return provider.credentialLabel || "From environment";
  if (provider.credentialSource?.startsWith("models_json"))
    return "From model configuration";
  return "Saved credentials";
}

function safeSignInUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="grid gap-1 text-xs font-medium text-ink-soft">
      {children}
    </label>
  );
}

function HelpText({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] leading-relaxed text-muted">{children}</p>;
}

// Follows Hoppercode's provider overview → catalog → setup → model selection flow.
// The local host owns all credentials and provider-specific Pi authentication prompts.
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
  const url = safeSignInUrl(activeAuth?.url);

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
    ].map((id) => ({ id }));
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
      <FieldLabel htmlFor="provider-model">
        Model
        <select
          id="provider-model"
          value={chosenModel}
          onChange={(event) => setModelId(event.target.value)}
          disabled={busy}
          className={selectClass}
        >
          {models.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name || item.id}
            </option>
          ))}
        </select>
      </FieldLabel>
      <Button
        type="button"
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
      <HelpText>
        Your current model stays selected until you choose another. Model access
        is checked when you send a message.
      </HelpText>
    </div>
  ) : (
    <p className="text-[13px] text-ink-soft">
      No models are available yet. Refresh the provider after completing setup.
    </p>
  );

  const providerRowClass =
    "flex w-full items-center justify-between gap-2 rounded-sm border border-line bg-surface px-3 py-2 text-left transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) void close();
      }}
    >
      <DialogContent
        aria-labelledby="settings-title"
        className="w-[min(440px,calc(100%-2rem))] gap-3"
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle id="settings-title">
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
        {view !== "overview" && (
          <Button
            variant="link"
            size="sm"
            className="-ml-0.5 justify-self-start"
            disabled={busy}
            onClick={() =>
              navigate(
                view === "setup" || view === "custom" ? "catalog" : "overview",
              )
            }
          >
            ← Back
          </Button>
        )}

        {view === "overview" && (
          <div className="grid gap-3">
            <div className="grid gap-1">
              {providers
                .filter((item) => item.authenticated)
                .map((item) => (
                  <button
                    className={providerRowClass}
                    key={item.id}
                    disabled={busy}
                    onClick={() => choose(item)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium text-ink">
                        {item.name || item.id}
                      </span>
                      <small className="block truncate text-[11px] text-muted">
                        {credentialDescription(item)} · {item.models.length}{" "}
                        models
                      </small>
                    </span>
                    <span aria-hidden="true" className="text-muted">
                      ›
                    </span>
                  </button>
                ))}
            </div>
            {!providers.some((item) => item.authenticated) && (
              <div className="rounded-sm bg-panel px-3 py-3">
                <strong className="text-[13px] text-ink">
                  Connect your first provider
                </strong>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">
                  Choose browser sign-in or an API key. Existing credentials
                  appear here when available to the local host.
                </p>
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <Button disabled={busy} onClick={() => navigate("catalog")}>
                Add provider
              </Button>
              <Button
                variant="link"
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
          </div>
        )}

        {view === "catalog" && (
          <div className="grid gap-3">
            <label className="sr-only" htmlFor="provider-search">
              Search providers
            </label>
            <Input
              id="provider-search"
              placeholder="Search providers"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="grid max-h-64 gap-1 overflow-y-auto">
              {providers
                .filter((item) =>
                  `${item.name || ""} ${item.id}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .map((item) => (
                  <button
                    className={providerRowClass}
                    key={item.id}
                    onClick={() => choose(item)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium text-ink">
                        {item.name || item.id}
                      </span>
                      <small className="block truncate text-[11px] text-muted">
                        {item.authMethods
                          ?.map((option) => option.label)
                          .join(" · ") || "External configuration"}
                      </small>
                    </span>
                    <span
                      className={
                        item.authenticated
                          ? "shrink-0 text-[11px] font-medium text-accent"
                          : "shrink-0 text-muted"
                      }
                    >
                      {item.authenticated ? "Connected" : "›"}
                    </span>
                  </button>
                ))}
            </div>
            {!providers.some((item) =>
              `${item.name || ""} ${item.id}`
                .toLowerCase()
                .includes(search.toLowerCase()),
            ) && (
              <p className="text-[13px] text-ink-soft">No matching providers.</p>
            )}
            <Button onClick={() => navigate("custom")} className="justify-self-start">
              Custom provider
            </Button>
          </div>
        )}

        {view === "custom" && (
          <form onSubmit={saveCustom} className="grid gap-3">
            <p className="text-[13px] leading-relaxed text-ink-soft">
              Connect a local server or an OpenAI-compatible Chat Completions
              endpoint.
            </p>
            <FieldLabel htmlFor="custom-name">
              Provider name
              <Input
                id="custom-name"
                value={customName}
                onChange={(event) => setCustomName(event.target.value)}
                placeholder="My local server"
                maxLength={57}
                required
                disabled={busy}
              />
            </FieldLabel>
            <FieldLabel htmlFor="custom-url">
              Base URL
              <Input
                id="custom-url"
                type="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="http://localhost:1234/v1"
                required
                disabled={busy}
              />
            </FieldLabel>
            <FieldLabel htmlFor="custom-models">
              Model IDs
              <textarea
                id="custom-models"
                value={modelIds}
                onChange={(event) => setModelIds(event.target.value)}
                placeholder="One model ID per line"
                required
                disabled={busy}
                rows={3}
                className="min-h-16 w-full rounded-sm border border-line bg-surface px-2.5 py-2 text-[13px] outline-none transition-colors placeholder:text-muted hover:border-line-strong focus-visible:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent/15 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </FieldLabel>
            <HelpText>Use the exact model IDs served by your endpoint.</HelpText>
            <label className="flex items-center gap-2 text-xs font-medium text-ink-soft">
              <input
                type="checkbox"
                checked={noAuth}
                onChange={(event) => {
                  setNoAuth(event.target.checked);
                  setKey("");
                }}
                disabled={busy}
                className="size-3.5 accent-accent"
              />
              This endpoint needs no authentication
            </label>
            {!noAuth && (
              <FieldLabel htmlFor="custom-key">
                API key
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
              </FieldLabel>
            )}
            <HelpText>
              Endpoint configuration and credentials are saved on your local
              host.
            </HelpText>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save and continue"}
            </Button>
          </form>
        )}

        {view === "success" && (
          <div className="grid gap-3">
            <div
              role="status"
              className="rounded-sm border border-accent/20 bg-accent-soft px-3 py-2 text-[13px] text-accent-hover"
            >
              {provider?.name || providerId} connected.
            </div>
            {modelPicker}
            <Button
              variant="link"
              size="sm"
              className="justify-self-start"
              disabled={busy}
              onClick={() => void close()}
            >
              Done
            </Button>
          </div>
        )}

        {view === "setup" && (
          <div className="grid gap-3">
            {provider?.authenticated && (
              <div className="grid gap-2 rounded-sm border border-line px-3 py-2.5">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted">
                  Connected · {credentialDescription(provider)}
                </span>
                {modelPicker}
                <div className="flex items-center justify-between gap-2">
                  <Button
                    variant="link"
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
                      variant="link"
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
            <form onSubmit={login} className="grid gap-3">
              {methods.length > 1 && (
                <FieldLabel htmlFor="provider-method">
                  Sign-in method
                  <select
                    id="provider-method"
                    value={method}
                    disabled={busy}
                    onChange={(event) => {
                      setMethod(event.target.value as typeof method);
                      setKey("");
                      setError("");
                    }}
                    className={selectClass}
                  >
                    {methods.map((item) => (
                      <option value={item.type} key={item.type}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </FieldLabel>
              )}
              {method === "api_key" &&
                methods.some((item) => item.type === "api_key") && (
                  <FieldLabel htmlFor="provider-key">
                    API key
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
                  </FieldLabel>
                )}
              {methods.length ? (
                <>
                  <HelpText>
                    Credentials are managed by Pi on your local host and reused
                    across Revit sessions. Keys and sign-in responses are never
                    saved in browser storage.
                  </HelpText>
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
                  <p className="text-[13px] leading-relaxed text-ink-soft">
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
          </div>
        )}

        {activeAuth?.busy && (
          <div
            role="status"
            className="grid gap-2 rounded-sm border border-accent/20 bg-accent-soft px-3 py-2.5 text-[13px] text-accent-hover"
          >
            <p>
              {activeAuth.notice || "Complete the provider sign-in to continue."}
            </p>
            {activeAuth.userCode && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-medium uppercase tracking-wider">
                  Device code
                </span>
                <code className="rounded-[3px] border border-line bg-surface px-2 py-0.5 font-mono text-[13px] text-ink">
                  {activeAuth.userCode}
                </code>
              </div>
            )}
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 font-semibold underline underline-offset-2"
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
            <FieldLabel htmlFor="auth-response">
              {activeAuth.request.prompt}
              {activeAuth.request.type === "select" ? (
                <select
                  id="auth-response"
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  disabled={pending}
                  required
                  className={selectClass}
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
            </FieldLabel>
            <Button type="submit" disabled={pending || !answer.trim()}>
              Continue sign-in
            </Button>
          </form>
        )}
        {notice && (
          <p role="status" className="text-xs text-muted">
            {notice}
          </p>
        )}
        {(error || activeAuth?.error) && (
          <p role="alert" className="text-xs text-danger">
            {error || activeAuth?.error}
          </p>
        )}
        {auth?.busy && (
          <Button
            type="button"
            variant="secondary"
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
      </DialogContent>
    </Dialog>
  );
}
