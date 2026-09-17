// Production browser + host. The agent is simulated; no Revit/provider required.
import { chromium, expect } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHost } from "../../dist/host/server.js";
import { RunHistory } from "../../dist/host/history.js";

const dataDir = await mkdtemp(join(tmpdir(), "revcode-thread-browser-"));
const savedHistory = await RunHistory.open(join(dataDir, "runs"));
const oldDate = "2025-01-01T00:00:00.000Z";
for (let i = 0; i < 105; i++) {
  const runId = `paging-run-${i}`;
  await savedHistory.save({
    run: {
      id: runId,
      threadId: "paging",
      instanceId: "thread-browser",
      number: i + 1,
      requestId: `paging-request-${i}`,
      userMessageId: `paging-user-${i}`,
      assistantMessageId: `paging-assistant-${i}`,
      promptPreview: `Paging question ${i}`,
      startedAt: oldDate,
      endedAt: oldDate,
      status: "finished",
      intent: "work",
      mode: "execution",
      sourceRunIds: [],
      provider: "anthropic",
      model: "test",
      toolNames: [],
      failedCalls: 0,
      callCount: 0,
      detailsAvailable: true,
    },
    messages: [
      {
        id: `paging-user-${i}`,
        role: "user",
        text: `Paging question ${i}`,
        runId,
        threadId: "paging",
      },
      {
        id: `paging-assistant-${i}`,
        role: "assistant",
        text: `Paging answer ${i}`,
        runId,
        threadId: "paging",
      },
    ],
    calls: [],
    operations: [],
  });
}
await writeFile(
  join(dataDir, "journal.json"),
  JSON.stringify({
    version: 3,
    messages: [],
    operations: [],
    requests: {},
    settings: { provider: "anthropic", model: "test", configured: true },
    threads: [
      {
        id: "legacy",
        title: "New thread",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "paging",
        title: "Paging regression",
        createdAt: oldDate,
        updatedAt: oldDate,
      },
    ],
  }),
);
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
  await expect(page.getByRole("log", { name: "Conversation" })).toHaveCount(1);
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
  await nav.getByRole("button", { name: /Inactive Paging regression/ }).click();
  await page
    .getByRole("button", { name: "Load earlier messages", exact: true })
    .click();
  await expect(
    page.getByText("Paging answer 0", { exact: true }),
  ).toBeVisible();
  await submit("Create a skill for paging");
  await expect(
    page.getByText("Paging answer 5", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[aria-label="Conversation"] [id^="message-"]'),
  ).toHaveCount(212);
  await expect(
    page.getByText("Paging answer 0", { exact: true }),
  ).toBeVisible();
  // Start with a fresh latest-200 window, then jump beyond its beginning.
  await nav
    .getByRole("button", { name: /Inactive Create a skill about levels/ })
    .click();
  await nav.getByRole("button", { name: /Inactive Paging regression/ }).click();
  const inspector = page.getByRole("complementary", {
    name: "Execution history",
  });
  for (let i = 0; i < 3; i++) {
    await inspector
      .getByRole("button", { name: "Load older runs", exact: true })
      .click();
    await expect(
      inspector.getByRole("button", { name: "Jump to message" }),
    ).toHaveCount(Math.min(106, (i + 2) * 30));
  }
  await inspector
    .locator("section")
    .filter({ has: page.getByText("Paging question 0", { exact: true }) })
    .getByRole("button", { name: "Jump to message" })
    .click();
  await expect(
    page.getByText("Paging answer 0", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Paging answer 4", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load earlier messages", exact: true }),
  ).toHaveCount(0);
  expect(
    await page
      .locator('[aria-label="Conversation"] [id^="message-paging-"]')
      .evaluateAll((nodes) => nodes.map((node) => node.id)),
  ).toEqual(
    Array.from({ length: 105 }, (_, i) => [
      `message-paging-user-${i}`,
      `message-paging-assistant-${i}`,
    ]).flat(),
  );
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
    "Thread browser smoke passed: isolation, drafts, selection reload, archive/restore, live switching, multi-tab selection, contiguous pagination, old-run jumps, mobile.",
  );
} finally {
  finish?.();
  await browser.close();
  await host.close();
  await rm(dataDir, { recursive: true, force: true });
}
