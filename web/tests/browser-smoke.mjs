// Run after `npm run build`: node web/tests/browser-smoke.mjs
// Real production HTTP + ZeroMQ transport, simulated native Revit and Pi.
// This verifies the browser integration, not Revit API execution or provider billing.
import { chromium, expect } from "@playwright/test";
import { Dealer } from "zeromq";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHost } from "../../dist/host/server.js";

const dataDir = await mkdtemp(join(tmpdir(), "revcode-browser-"));
let key;
let commandCount = 0;
let lastCommand;
let heldOperation;
let desktopStops = 0;
let desktopStarts = 0, desktopRecovers = 0, desktopActive = false, desktopNeedsRecovery = false;
let finishDesktop;
const desktop = {
  request: async kind => {
    if (kind === 'start') { desktopStarts++; desktopActive = true; return { status: 'owned' }; }
    if (kind === 'recover') { desktopRecovers++; desktopNeedsRecovery = false; return { recovered: true }; }
    if (kind === 'action') return { status: 'dispatched', inserted: 3 };
    if (kind !== 'observe') throw new Error('Browser must not dispatch desktop input.');
    return { observationId: 'a'.repeat(32), windowRef: 'b'.repeat(32), title: 'Desktop smoke fixture', timestamp: new Date().toISOString(),
      bounds: { x: 0, y: 0, width: 1, height: 1 }, crop: { x: 0, y: 0, width: 1, height: 1 }, width: 1, height: 1, dpi: 96,
      cursor: { x: 0.5, y: 0.5 }, windows: [], actionable: desktopActive && !desktopNeedsRecovery, owned: desktopActive,
      recovery: desktopNeedsRecovery ? 'input' : undefined, backend: 'fixture', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=' };
  }, stop: async () => { desktopStops++; desktopActive = false; }, close: async () => {},
};
const agent = {
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      authenticated: false,
      canLogout: false,
      authMethods: [
        { type: "oauth", label: "Browser sign-in" },
        { type: "api_key", label: "API key" },
      ],
      models: [{ id: "smoke-model", name: "Smoke model" }],
    },
  ],
  configured: (provider) =>
    !!agent.providers.find((item) => item.id === provider)?.authenticated,
  setKey: async (_provider, value) => {
    if (value === "reject-test") throw new Error("Key save failed");
    key = value;
    agent.providers[0].authenticated = true;
    agent.providers[0].canLogout = true;
  },
  login: async (provider, method, interaction) => {
    if (method === "api_key") {
      const value = await interaction.prompt({
        type: "secret",
        message: "Enter your provider API key",
      });
      await agent.setKey(provider, value);
    } else {
      interaction.notify({
        type: "auth_url",
        url: "https://example.com/sign-in",
        instructions:
          "Simulated provider sign-in. Do not enter real credentials.",
      });
      interaction.notify({
        type: "device_code",
        verificationUri: "https://example.com/sign-in",
        userCode: "TEST-1234",
      });
      await interaction.prompt({
        type: "select",
        message: "Select test workspace",
        options: [{ id: "test", label: "Test workspace" }],
      });
      const value = await interaction.prompt({
        type: "manual_code",
        message: "Paste the authorization code",
        placeholder: "Test code",
      });
      if (value !== "test-authorization-code")
        throw new Error("Invalid test code");
      key = "simulated-oauth-credential";
      agent.providers[0].authenticated = true;
      agent.providers[0].canLogout = true;
    }
  },
  logout: async (provider) => {
    const item = agent.providers.find((item) => item.id === provider);
    item.authenticated = false;
    item.canLogout = false;
    key = undefined;
  },
  refresh: async () => {},
  addProvider: async (config) => {
    agent.providers.push({
      ...config,
      authenticated: true,
      canLogout: !!config.apiKey,
      authMethods: [{ type: "api_key", label: "API key" }],
    });
  },
  prompt: async (_text, _settings, _context, _history, execute, update, desktopTools) => {
    if (_text === 'Desktop recovery test') {
      const frame = await desktopTools.observe({});
      await desktopTools.action('browser-click-' + desktopStarts, { observationId: frame.observationId, action: 'click', x: 0.5, y: 0.5 });
      update('Desktop recovered and ready.');
      await new Promise(resolve => { finishDesktop = resolve; });
      return;
    }
    update("Inspecting the active document…");
    const operation = await execute({
      code: "return new { name = ctx.Doc.Title };",
      mode: "query",
    });
    update(`The model query ${operation.status}.`);
  },
  abort: async () => { finishDesktop?.(); finishDesktop = undefined; },
};
const host = await createHost({
  instanceId: "browser-smoke",
  nativeToken: "native-smoke-token",
  dataDir,
  webDir: resolve("dist/web"),
  agent,
  desktop,
});
const native = new Dealer({ linger: 0 });
native.connect(host.nativeEndpoint);
const context = {
  instanceId: "browser-smoke",
  revitVersion: "2026",
  revitBuild: "26.3.0.37",
  runtime: ".NET 8 (simulated)",
  document: {
    token: "test-doc",
    title: "Browser smoke · simulated model",
    isFamily: false,
    isReadOnly: false,
    activeView: "{3D}",
    selection: ["one", "two"],
  },
};
const send = (type, payload) =>
  native.send(JSON.stringify({ type, token: "native-smoke-token", payload }));
context.documents = [context.document, { ...context.document, token: "other-doc", title: "Other open project" }];
await send("context", context);
const heartbeat = setInterval(
  () => void send("context", context).catch(() => {}),
  1000,
);
const nativeLoop = (async () => {
  try {
    for await (const [frame] of native) {
      const message = JSON.parse(frame.toString());
      if (message.type !== "command") continue;
      const command = message.command;
      if (command.kind === "cancel") {
        if (heldOperation) {
          await send("operation", {
            operationId: heldOperation,
            status: "cancelled",
            transactionStatus: "RolledBack",
          });
          heldOperation = undefined;
        }
        continue;
      }
      commandCount++;
      lastCommand = command;
      await send("operation", {
        operationId: command.operationId,
        status: "running",
      });
      if (command.code.includes("HOLD_FOR_CANCEL")) {
        heldOperation = command.operationId;
        continue;
      }
      const rollback = command.code.includes("Intentional rollback");
      await send("operation", {
        operationId: command.operationId,
        status: rollback ? "failed" : "succeeded",
        ...(rollback
          ? { error: "Intentional rollback test. No level should remain." }
          : { result: [{ name: "Level 1", elevationMm: 0 }] }),
        transactionStatus:
          command.mode === "modify"
            ? rollback
              ? "RolledBack"
              : "Committed"
            : "None",
        elapsedMs: 17,
      });
    }
  } catch {
    /* Socket closes during teardown. */
  }
})();

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const manualHistory = page.locator("details").filter({ has: page.locator("summary").filter({ hasText: /^Manual console$/ }) });
const manualOperations = manualHistory.locator("section");
async function openManualHistory() {
  await expect(manualHistory).toBeVisible();
  if (await manualHistory.getAttribute("open") === null)
    await manualHistory.locator("summary").click();
}
try {
  await page.goto(host.url);
  await expect(
    page.getByRole("heading", { name: "Open Revcode from Revit" }),
  ).toBeVisible();
  await page.goto(`${host.url}/#${host.browserToken}`);
  await expect(
    page.getByText("Revit connected", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Screenshot', exact: true })).toHaveCount(0);
  await expect(page.getByText(/^Desktop:/)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Agent tools' }).getByRole('listitem')).toHaveText([
    /Execute Revit C#/, /Capture a view/, /Observe desktop/, /Control desktop/, /Author skills/,
  ]);
  await expect(page).toHaveURL(`${host.url}/`);
  await page.getByRole("link", { name: "Skip to message" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Message the assistant")).toBeFocused();
  expect((await page.waitForResponse((response) => new URL(response.url()).pathname === "/api/state")).status()).toBe(200);
  expect(await page.evaluate(() => sessionStorage.getItem("revcode.token"))).toBe(host.browserToken);
  await expect(page).toHaveURL(`${host.url}/`);
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  await page.locator(".console-button").click();
  context.document.isReadOnly = true;
  await send("context", context);
  await page.getByLabel("Execution mode").selectOption("modify");
  await expect(page.getByRole("button", { name: "Run C#" })).toBeDisabled();
  let executeRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/execute") executeRequests++;
  });
  await page.locator("#code").press("Control+Enter");
  // Let any request from the keyboard handler reach the host before checking.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
  expect(executeRequests).toBe(0);
  await page.getByLabel("Target document").selectOption("other-doc");
  await expect(page.getByRole("button", { name: "Run C#" })).toBeEnabled();
  await page.getByLabel("Execution mode").selectOption("api");
  await expect(page.getByRole("button", { name: "Run C#" })).toBeEnabled();
  await page.getByLabel("Execution mode").selectOption("query");
  await expect(page.getByRole("button", { name: "Run C#" })).toBeEnabled();
  await page.locator("#code").press("Control+Enter");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await openManualHistory();
  await expect(manualHistory.getByRole("heading", { name: "Execute Revit C# · succeeded", exact: true })).toBeVisible();
  await expect(manualOperations).toHaveCount(1);
  expect(lastCommand.documentToken).toBe("other-doc");
  await page.reload();
  await expect(manualOperations).toHaveCount(1);
  expect(commandCount).toBe(1);
  context.document.isReadOnly = false;
  await send("context", context);

  await page.locator(".console-button").click();
  await page
    .getByRole("button", { name: "Test rollback", exact: true })
    .click();
  await expect(page.getByLabel("Execution mode")).toHaveValue("modify");
  // A restored draft requires explicit target selection when session identity is unavailable.
  await page.getByLabel("Target document").selectOption("other-doc");
  await page.getByRole("button", { name: "Run C#" }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await openManualHistory();
  await expect(manualOperations.filter({ has: page.getByRole("heading", { name: "Execute Revit C# · failed", exact: true }) }))
    .toContainText('"error": "Intentional rollback test. No level should remain."');
  await expect(page.getByText(/Transaction: RolledBack/)).toBeVisible();
  await page.locator(".console-button").click();

  await page
    .locator("#code")
    .fill("ctx.CheckCancellation(); // HOLD_FOR_CANCEL\nreturn null;");
  await page.getByRole("button", { name: "Run C#" }).click();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => host.snapshot().operations.at(-1)?.status).toBe("cancelled");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await openManualHistory();
  await expect(manualHistory.getByRole("heading", { name: "Execute Revit C# · cancelled", exact: true })).toBeVisible();

  await page.getByRole("button", { name: /Set up a provider/ }).click();
  await expect(
    page.getByRole("heading", { name: "Model providers" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  await page.getByLabel("Search providers").fill("Anthropic");
  await page.getByRole("button", { name: /Anthropic/ }).click();
  await expect(page.getByLabel("Sign-in method")).toHaveValue("oauth");
  await page.getByLabel("Sign-in method").selectOption("api_key");
  await page.getByLabel("API key", { exact: true }).fill("reject-test");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("alert")).toContainText("Sign-in failed");
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await page
    .getByLabel("API key", { exact: true })
    .fill("browser-only-test-key");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Provider connected" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain("browser-only-test-key");
  await page.getByRole("button", { name: "Use this model" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.locator(".provider-button").click();
  await page.getByRole("button", { name: /Anthropic/ }).click();
  await page.getByRole("button", { name: "Remove saved credentials" }).click();
  await expect(page.getByText("Saved credentials removed.")).toBeVisible();
  await page.getByRole("button", { name: "Sign in with Anthropic" }).click();
  await expect(
    page.getByRole("link", { name: /Open sign-in/ }),
  ).toHaveAttribute("href", "https://example.com/sign-in");
  await expect(page.getByText("TEST-1234", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel setup" }).click();
  await expect(
    page.getByRole("button", { name: "Sign in with Anthropic" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Sign in with Anthropic" }).click();
  await page.getByLabel("Select test workspace").selectOption("test");
  await page.getByRole("button", { name: "Continue sign-in" }).click();
  await expect(page.getByLabel("Paste the authorization code")).toBeVisible();
  await mkdir(resolve(".local"), { recursive: true });
  await page.screenshot({ path: resolve(".local/provider-sign-in.png") });
  await page.reload();
  await page.locator(".provider-button").click();
  await expect(page.getByLabel("Paste the authorization code")).toBeVisible();
  await page
    .getByLabel("Paste the authorization code")
    .fill("test-authorization-code");
  await page.getByRole("button", { name: "Continue sign-in" }).click();
  await expect(
    page.getByRole("heading", { name: "Provider connected" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain("test-authorization-code");
  await page.getByRole("button", { name: "Use this model" }).click();
  await page.reload();
  await page.locator(".provider-button").click();
  await expect(
    page.getByRole("button", { name: /Anthropic.*models/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  await page
    .getByRole("button", { name: "Custom provider", exact: true })
    .click();
  await page.getByLabel("Provider name").fill("Local smoke");
  await page.getByLabel("Base URL").fill("http://127.0.0.1:1234/v1");
  await page.getByLabel("Model IDs").fill("local-test-model");
  await page.getByLabel("This endpoint needs no authentication").check();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Provider connected" }),
  ).toBeVisible();
  await expect(page.locator("#provider-model")).toHaveValue("local-test-model");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByLabel("Message the assistant").fill("Inspect the model.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByText("The model query succeeded.", { exact: true }),
  ).toBeVisible();
  expect(commandCount).toBe(4);

  await page.getByLabel('Message the assistant').fill('Desktop recovery test');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(/Starting in/)).toBeVisible();
  const lockScreen = page.getByRole('dialog', { name: 'Getting ready to work' });
  await expect(lockScreen).toBeVisible();
  expect(await lockScreen.boundingBox()).toEqual({ x: 0, y: 0, width: 1440, height: 1050 });
  await page.keyboard.press('Escape');
  await expect(lockScreen).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Stop and take control' })).toBeFocused();
  await page.getByRole('button', { name: 'Stop and take control', exact: true }).click();
  await expect.poll(() => host.snapshot().busy).toBe(false);
  expect(desktopStarts).toBe(0);

  desktopNeedsRecovery = true;
  await page.getByLabel('Message the assistant').fill('Desktop recovery test');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(/Starting in/)).toBeVisible();
  await expect(page.getByText(/Resuming in/)).toBeVisible();
  await page.screenshot({ path: resolve('.local/desktop-recovery-countdown.png') });
  await expect(page.getByText('Computer use in progress', { exact: true })).toBeVisible();
  await expect.poll(() => host.snapshot().messages.some(message => message.text.includes('Desktop recovered and ready.'))).toBe(true);
  const controlDialog = page.getByRole('dialog', { name: 'Revcode is working in Revit' });
  await expect(controlDialog.getByRole('img', { name: 'Revit desktop: Desktop smoke fixture' })).toBeVisible();
  await expect(controlDialog.getByRole('img', { name: 'Cursor at capture: 1, 1' })).toBeVisible();
  await expect(controlDialog.getByText('Input sent', { exact: true })).toBeVisible();
  await expect(controlDialog.getByText('Captured', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: resolve('.local/desktop-frosted-activity.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await controlDialog.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  expect(await controlDialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: resolve('.local/desktop-frosted-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1050 });
  expect(desktopStarts).toBe(1); expect(desktopRecovers).toBe(1);
  await page.getByRole('button', { name: 'Stop and take control', exact: true }).click();
  await expect.poll(() => host.snapshot().busy).toBe(false);
  await expect(page.getByText('Computer use in progress', { exact: true })).toBeHidden();
  await expect(page.getByRole('complementary').getByText('Input sent', { exact: true })).toBeVisible();
  await expect.poll(() => desktopStops).toBeGreaterThan(0);

  await mkdir(resolve(".local"), { recursive: true });
  await page.screenshot({
    path: resolve(".local/web-smoke.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page.locator(".console-button")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: resolve(".local/web-smoke-mobile.png"),
    fullPage: true,
  });

  clearInterval(heartbeat);
  await send("disconnect", {});
  await expect(
    page.getByText("Waiting for Revit", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  await send("context", context);
  await expect(
    page.getByText("Revit connected", { exact: true }),
  ).toBeVisible();
  expect(commandCount).toBe(4);

  const unauthorized = await browser.newPage();
  await unauthorized.goto(`${host.url}/#invalid-token`);
  await expect(
    unauthorized.getByText("Unauthorized.", { exact: false }),
  ).toBeVisible();
  await expect(
    unauthorized.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  expect(errors).toEqual([]);
  console.log(
    "PASS browser smoke: full-screen computer-use modal/Stop, production UI, token bootstrap/reload, query, rollback, cancellation, provider error/key privacy, Pi chat, mobile layout, disconnect/reconnect without replay, unauthorized token.",
  );
} finally {
  clearInterval(heartbeat);
  await browser.close();
  native.close();
  await nativeLoop;
  await host.close();
  if (
    dirname(resolve(dataDir)) !== resolve(tmpdir()) ||
    !basename(dataDir).startsWith("revcode-browser-")
  )
    throw new Error("Refusing to remove an unexpected temporary directory.");
  await rm(dataDir, { recursive: true, force: true });
}
