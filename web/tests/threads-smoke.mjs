// Production browser + host. The agent is simulated; no Revit/provider required.
import { chromium, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHost } from "../../dist/host/server.js";

const dataDir = await mkdtemp(join(tmpdir(), "revcode-thread-browser-"));
const histories = [];
let finish;
const host = await createHost({
  instanceId: "thread-browser",
  nativeToken: "test",
  dataDir,
  webDir: resolve("dist/web"),
  agent: {
    providers: [{ id: "anthropic", models: [{ id: "test", name: "Test" }] }],
    configured: () => true,
    setKey: async () => {},
    abort: async () => finish?.(),
    prompt: async (text, _settings, _context, history, _execute, update) => {
      histories.push(history.map((message) => message.text));
      if (text.includes("Wait"))
        await new Promise((resolve) => {
          finish = resolve;
        });
      update(`Reply to ${text}`);
    },
  },
});
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const nav = page.getByRole("navigation", { name: "Thread history" });
const input = page.getByLabel("Message the assistant");
const send = page.getByRole("button", { name: "Send", exact: true });
async function submit(text) {
  await input.fill(text);
  await expect(send).toBeEnabled();
  await send.click();
  await expect(
    page.getByText(`Reply to ${text}`, { exact: true }),
  ).toBeVisible();
}
try {
  await page.goto(`${host.url}/#${host.browserToken}`);
  await submit("Create a skill about levels");
  await input.fill("Draft in first thread");
  await nav.getByRole("button", { name: "New thread", exact: true }).click();
  await expect(input).toHaveValue("");
  await submit("Create a skill about walls");
  expect(histories).toEqual([[], []]);
  await expect(
    page.getByText("Reply to Create a skill about levels", { exact: true }),
  ).toHaveCount(0);
  await input.fill("Draft in second thread");
  await nav
    .getByRole("button", { name: /Inactive Create a skill about levels/ })
    .click();
  await expect(input).toHaveValue("Draft in first thread");
  await expect(
    page.getByText("Reply to Create a skill about levels", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Reply to Create a skill about walls", { exact: true }),
  ).toHaveCount(0);
  await nav
    .getByRole("button", { name: /Inactive Create a skill about walls/ })
    .click();
  await expect(input).toHaveValue("Draft in second thread");
  await page.reload();
  await expect(
    page.getByText("Reply to Create a skill about walls", { exact: true }),
  ).toBeVisible();
  await nav
    .getByRole("button", {
      name: "Archive Create a skill about walls",
      exact: true,
    })
    .click();
  await expect(input).toBeDisabled();
  await nav.getByRole("button", { name: "Archived (1)", exact: true }).click();
  await nav
    .getByRole("button", {
      name: "Unarchive Create a skill about walls",
      exact: true,
    })
    .click();
  await expect(input).toBeEnabled();
  await input.fill("Create a skill. Wait for me");
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => !!finish).toBe(true);
  await nav
    .getByRole("button", { name: /Inactive Create a skill about levels/ })
    .click();
  await expect(
    page.getByRole("button", { name: "Jump back", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Jump back", exact: true }).click();
  await expect(
    nav.getByRole("button", {
      name: "Archive Create a skill about walls",
      exact: true,
    }),
  ).toBeDisabled();
  finish();
  await expect(
    page.getByText("Reply to Create a skill. Wait for me", { exact: true }),
  ).toBeVisible();
  const otherTab = await browser.newPage();
  await otherTab.goto(`${host.url}/#${host.browserToken}`);
  await otherTab
    .getByRole("navigation", { name: "Thread history" })
    .getByRole("button", { name: /Inactive Create a skill about levels/ })
    .click();
  await expect(
    otherTab.getByText("Reply to Create a skill about levels", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Reply to Create a skill about walls", { exact: true }),
  ).toBeVisible();
  await otherTab.close();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Open settings", exact: true })
    .click();
  await expect(nav).toBeVisible();
  await nav
    .getByRole("button", { name: /Inactive Create a skill about levels/ })
    .click();
  await expect(
    page.getByText("Reply to Create a skill about levels", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  console.log(
    "Thread browser smoke passed: isolation, drafts, selection reload, archive/restore, live switching, mobile.",
  );
} finally {
  finish?.();
  await browser.close();
  await host.close();
  await rm(dataDir, { recursive: true, force: true });
}
