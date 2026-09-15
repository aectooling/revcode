// Actual Pi ModelRuntime OAuth + credential storage, production web/HTTP.
// Only the provider's remote authorization exchange is simulated; no live credentials.
import { chromium, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHost } from "../../dist/host/server.js";
import { createPiAgent } from "../../dist/host/pi-agent.js";

const dataDir = await mkdtemp(join(tmpdir(), "revcode-provider-browser-"));
const registerFixture = (runtime) =>
  runtime.registerProvider("fixture-oauth", {
    name: "Fixture subscription",
    oauth: {
      name: "Fixture browser sign-in",
      login: async (callbacks) => {
        callbacks.onAuth({
          url: "https://example.test/sign-in",
          instructions:
            "Simulated subscription login. Enter the test code below.",
        });
        expect(
          await callbacks.onPrompt({ message: "Authorization code" }),
        ).toBe("fixture-code");
        return {
          access: "fixture-access",
          refresh: "fixture-refresh",
          expires: Date.now() + 3600000,
        };
      },
      refreshToken: async (credential) => credential,
      getApiKey: (credential) => credential.access,
    },
    api: "openai-completions",
    baseUrl: "http://localhost:9999/v1",
    models: [
      {
        id: "fixture-model",
        name: "Fixture model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 1000,
      },
    ],
  });
const agent = await createPiAgent(dataDir, dataDir, registerFixture);
const host = await createHost({
  instanceId: "provider-sdk",
  nativeToken: "unused-native-test-token",
  dataDir,
  webDir: resolve("dist/web"),
  agent,
});
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(`${host.url}/#${host.browserToken}`);
  await page.getByRole("button", { name: /Set up a provider/ }).click();
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  await mkdir(resolve(".local"), { recursive: true });
  await page.screenshot({ path: resolve(".local/provider-setup.png") });
  await page.getByLabel("Search providers").fill("Fixture subscription");
  await page.getByRole("button", { name: /Fixture subscription/ }).click();
  await page
    .getByRole("button", { name: "Sign in with Fixture subscription" })
    .click();
  await expect(
    page.getByRole("link", { name: /Open sign-in/ }),
  ).toHaveAttribute("href", "https://example.test/sign-in");
  await page.getByRole("button", { name: "Cancel setup" }).click();
  await expect(
    page.getByRole("button", { name: "Sign in with Fixture subscription" }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Sign in with Fixture subscription" })
    .click();
  await page.getByLabel("Authorization code").fill("fixture-code");
  await page.getByRole("button", { name: "Continue sign-in" }).click();
  await expect(
    page.getByRole("heading", { name: "Provider connected" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Use this model" }).click();
  expect(
    JSON.parse(await readFile(join(dataDir, "auth.json"), "utf8"))[
      "fixture-oauth"
    ].access,
  ).toBe("fixture-access");
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...sessionStorage, ...localStorage }),
    ),
  ).not.toMatch(/fixture-access|fixture-refresh|fixture-code/);

  await page.locator(".provider-button").click();
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  await page
    .getByRole("button", { name: "Custom provider", exact: true })
    .click();
  await page.getByLabel("Provider name").fill("SDK local");
  await page.getByLabel("Base URL").fill("http://127.0.0.1:1234/v1");
  await page.getByLabel("Model IDs").fill("sdk-local-model");
  await page.getByLabel("This endpoint needs no authentication").check();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Provider connected" }),
  ).toBeVisible();
  await expect(page.locator("#provider-model")).toHaveValue("sdk-local-model");
  await page.getByRole("button", { name: "Use this model" }).click();
  const secondAgent = await createPiAgent(
    join(dataDir, "second-instance"),
    dataDir,
    registerFixture,
  );
  expect(secondAgent.configured("fixture-oauth")).toBe(true);
  expect(secondAgent.configured("custom-sdk-local")).toBe(true);
  await page.locator(".provider-button").click();
  await page
    .getByRole("button", { name: /Fixture subscription.*models/ })
    .click();
  await page.getByRole("button", { name: "Remove saved credentials" }).click();
  await expect(page.getByText("Saved credentials removed.")).toBeVisible();
  expect(
    JSON.parse(await readFile(join(dataDir, "auth.json"), "utf8"))[
      "fixture-oauth"
    ],
  ).toBeUndefined();
  expect(errors).toEqual([]);
  console.log(
    "PASS provider SDK browser: real Pi OAuth login/cancel/credential storage, model selection, logout, keyless custom provider, cross-instance persistence; simulated remote authorization only.",
  );
} finally {
  await browser.close();
  await host.close();
  if (
    dirname(resolve(dataDir)) !== resolve(tmpdir()) ||
    !basename(dataDir).startsWith("revcode-provider-browser-")
  )
    throw new Error("Unexpected cleanup path");
  await rm(dataDir, { recursive: true, force: true });
}
