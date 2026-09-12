import { useEffect, useRef, useState } from "react";

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
  const dialog = useRef<HTMLDialogElement>(null);
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
    dialog.current?.showModal();
  }, []);
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
    const models = [
      ...new Set(
        modelIds
          .split(/[\n,]/)
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ].map((id) => ({ id }));
    if (!models.length) {
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
        models,
        ...(!noAuth && apiKey ? { apiKey } : {}),
      },
      () => setView("success"),
    );
  }

  const modelPicker = models.length ? (
    <div className="provider-model-picker">
      <label htmlFor="provider-model">
        Model
        <select
          id="provider-model"
          value={chosenModel}
          onChange={(event) => setModelId(event.target.value)}
          disabled={busy}
        >
          {models.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name || item.id}
            </option>
          ))}
        </select>
      </label>
      <button
        className="primary-button"
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
      </button>
      <p className="key-help">
        Your current model stays selected until you choose another. Model access
        is checked when you send a message.
      </p>
    </div>
  ) : (
    <p>
      No models are available yet. Refresh the provider after completing setup.
    </p>
  );

  return (
    <div className="modal-backdrop">
      <dialog
        ref={dialog}
        aria-labelledby="settings-title"
        className="settings-dialog provider-dialog"
        onCancel={(event) => {
          event.preventDefault();
          void close();
        }}
      >
        <div className="section-heading">
          <h2 id="settings-title">
            {view === "overview"
              ? "Model providers"
              : view === "catalog"
                ? "Add provider"
                : view === "custom"
                  ? "Custom provider"
                  : view === "success"
                    ? "Provider connected"
                    : provider?.name || providerId || "Provider setup"}
          </h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close settings"
            disabled={pending}
            onClick={() => void close()}
          >
            ×
          </button>
        </div>
        <p>
          {view === "overview"
            ? "Manage the model providers available to Revcode."
            : view === "catalog"
              ? "Choose a provider supported by Pi."
              : view === "success"
                ? "Choose a model to use, or keep your current selection."
                : "Configure access and choose a model."}
        </p>
        {view !== "overview" && (
          <button
            type="button"
            className="text-button provider-back"
            disabled={busy}
            onClick={() =>
              navigate(
                view === "setup" || view === "custom" ? "catalog" : "overview",
              )
            }
          >
            ← Back
          </button>
        )}

        {view === "overview" && (
          <>
            <div className="provider-list">
              {providers
                .filter((item) => item.authenticated)
                .map((item) => (
                  <button
                    className="provider-row"
                    key={item.id}
                    disabled={busy}
                    onClick={() => choose(item)}
                  >
                    <span>
                      <strong>{item.name || item.id}</strong>
                      <small>
                        {credentialDescription(item)} · {item.models.length}{" "}
                        models
                      </small>
                    </span>
                    <span aria-hidden="true">›</span>
                  </button>
                ))}
            </div>
            {!providers.some((item) => item.authenticated) && (
              <div className="provider-empty">
                <strong>Connect your first provider</strong>
                <p>
                  Choose browser sign-in or an API key. Existing credentials
                  appear here when available to the local host.
                </p>
              </div>
            )}
            <div className="provider-footer">
              <button
                className="primary-button"
                disabled={busy}
                onClick={() => navigate("catalog")}
              >
                Add provider
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void action("/api/auth/refresh", {}, () =>
                    setNotice("Provider list refreshed."),
                  )
                }
              >
                Refresh providers
              </button>
            </div>
          </>
        )}

        {view === "catalog" && (
          <>
            <label className="sr-only" htmlFor="provider-search">
              Search providers
            </label>
            <input
              id="provider-search"
              placeholder="Search providers"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="provider-list catalog-list">
              {providers
                .filter((item) =>
                  `${item.name || ""} ${item.id}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .map((item) => (
                  <button
                    className="provider-row"
                    key={item.id}
                    onClick={() => choose(item)}
                  >
                    <span>
                      <strong>{item.name || item.id}</strong>
                      <small>
                        {item.authMethods
                          ?.map((option) => option.label)
                          .join(" · ") || "External configuration"}
                      </small>
                    </span>
                    <span className="provider-connected">
                      {item.authenticated ? "Connected" : "›"}
                    </span>
                  </button>
                ))}
            </div>
            {!providers.some((item) =>
              `${item.name || ""} ${item.id}`
                .toLowerCase()
                .includes(search.toLowerCase()),
            ) && <p>No matching providers.</p>}
            <button
              className="primary-button"
              onClick={() => navigate("custom")}
            >
              Custom provider
            </button>
          </>
        )}

        {view === "custom" && (
          <form onSubmit={saveCustom}>
            <p>
              Connect a local server or an OpenAI-compatible Chat Completions
              endpoint.
            </p>
            <label htmlFor="custom-name">
              Provider name
              <input
                id="custom-name"
                value={customName}
                onChange={(event) => setCustomName(event.target.value)}
                placeholder="My local server"
                maxLength={57}
                required
                disabled={busy}
              />
            </label>
            <label htmlFor="custom-url">
              Base URL
              <input
                id="custom-url"
                type="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="http://localhost:1234/v1"
                required
                disabled={busy}
              />
            </label>
            <label htmlFor="custom-models">
              Model IDs
              <textarea
                id="custom-models"
                value={modelIds}
                onChange={(event) => setModelIds(event.target.value)}
                placeholder="One model ID per line"
                required
                disabled={busy}
                rows={3}
              />
            </label>
            <p className="key-help">
              Use the exact model IDs served by your endpoint.
            </p>
            <label className="checkbox-label">
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
              <label htmlFor="custom-key">
                API key
                <input
                  id="custom-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  required
                  disabled={busy}
                />
              </label>
            )}
            <p className="key-help">
              Endpoint configuration and credentials are saved on your local
              host.
            </p>
            <button className="primary-button" disabled={busy}>
              {busy ? "Saving…" : "Save and continue"}
            </button>
          </form>
        )}

        {view === "success" && (
          <>
            <div className="auth-notice" role="status">
              {provider?.name || providerId} connected.
            </div>
            {modelPicker}
            <button
              className="text-button"
              disabled={busy}
              onClick={() => void close()}
            >
              Done
            </button>
          </>
        )}

        {view === "setup" && (
          <>
            {provider?.authenticated && (
              <div className="connected-provider">
                <span className="eyebrow">
                  CONNECTED · {credentialDescription(provider)}
                </span>
                {modelPicker}
                <div className="provider-footer">
                  <button
                    className="text-button"
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
                  </button>
                  {provider.canLogout && (
                    <button
                      className="text-button danger-text"
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
                    </button>
                  )}
                </div>
              </div>
            )}
            <form onSubmit={login}>
              {methods.length > 1 && (
                <label htmlFor="provider-method">
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
                  >
                    {methods.map((item) => (
                      <option value={item.type} key={item.type}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {method === "api_key" &&
                methods.some((item) => item.type === "api_key") && (
                  <label htmlFor="provider-key">
                    API key
                    <input
                      id="provider-key"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={key}
                      disabled={busy}
                      onChange={(event) => setKey(event.target.value)}
                      placeholder="Paste a key, or continue for guided setup"
                    />
                  </label>
                )}
              {methods.length ? (
                <>
                  <p className="key-help">
                    Credentials are managed by Pi on your local host and reused
                    across Revit sessions. Keys and sign-in responses are never
                    saved in browser storage.
                  </p>
                  <button
                    type="submit"
                    className="primary-button"
                    disabled={busy}
                  >
                    {busy
                      ? "Connecting…"
                      : method === "oauth"
                        ? `Sign in with ${provider?.name || providerId}`
                        : "Save and continue"}
                  </button>
                </>
              ) : (
                <>
                  <p>
                    This provider uses external configuration. Configure its
                    credentials in the host environment, then refresh providers.
                  </p>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy}
                    onClick={() =>
                      void action("/api/auth/refresh", { provider: providerId })
                    }
                  >
                    Check again
                  </button>
                </>
              )}
            </form>
          </>
        )}

        {activeAuth?.busy && (
          <div className="auth-notice" role="status">
            <p>
              {activeAuth.notice ||
                "Complete the provider sign-in to continue."}
            </p>
            {activeAuth.userCode && (
              <div className="device-code">
                <span>Device code</span>
                <code>{activeAuth.userCode}</code>
              </div>
            )}
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer noopener"
                className="auth-link"
              >
                Open sign-in ↗
              </a>
            )}
          </div>
        )}
        {activeAuth?.busy && activeAuth.request && (
          <form
            className="auth-response"
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
            <label htmlFor="auth-response">
              {activeAuth.request.prompt}
              {activeAuth.request.type === "select" ? (
                <select
                  id="auth-response"
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
                <input
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
            </label>
            <button
              className="primary-button"
              disabled={pending || !answer.trim()}
            >
              Continue sign-in
            </button>
          </form>
        )}
        {notice && (
          <p role="status" className="settings-message">
            {notice}
          </p>
        )}
        {(error || activeAuth?.error) && (
          <p role="alert" className="auth-error">
            {error || activeAuth?.error}
          </p>
        )}
        {auth?.busy && (
          <button
            type="button"
            className="stop-button cancel-setup"
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
          </button>
        )}
      </dialog>
    </div>
  );
}
