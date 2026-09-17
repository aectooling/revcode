// Focused mocked API scenarios against the production UI; no native/provider execution.
import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
// Use the host's actual policy so WASM highlighting cannot pass only in the fixture.
const hostSource = await readFile("src/host/server.ts", "utf8");
const contentSecurityPolicy = hostSource.match(/"Content-Security-Policy":\s*"([^"]+)"/)[1];
const server = createServer(async (req, res) => {
  try {
    const path = resolve(
      "dist/web",
      "." + new URL(req.url, "http://local").pathname,
    );
    const bytes = await readFile(
      path.endsWith("web") ? resolve(path, "index.html") : path,
    );
    res.setHeader(
      "Content-Type",
      {
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".html": "text/html",
      }[extname(path)] ?? "text/html",
    );
    res.setHeader("Content-Security-Policy", contentSecurityPolicy);
    res.end(bytes);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

const run = {
  id: "chat-run", number: 1, instanceId: "fixture", requestId: "request",
  userMessageId: "user", assistantMessageId: "reply", promptPreview: "Inspect levels",
  startedAt: new Date(Date.now() - 65000).toISOString(), status: "running",
  intent: "work", mode: "execution", sourceRunIds: [], provider: "test", model: "test",
  toolNames: ["revit_execute_csharp"], failedCalls: 0, callCount: 5, detailsAvailable: true,
};
const calls = Array.from({ length: 5 }, (_, index) => ({
  id: `call-${index}`, runId: run.id, name: `revit_tool_${index}`, sequence: index,
  status: index === 4 ? "running" : "succeeded", arguments: { code: "return levels;" },
  result: index === 4 ? undefined : { count: 3 }, startedAt: run.startedAt,
  operationIds: [], artifacts: [],
}));
await page.route("**/api/**", async route => {
  const path = new URL(route.request().url()).pathname;
  let data = {};
  if (path === "/api/state") data = {
    instanceId: "fixture", connected: false, busy: run.status === "running", chatBusy: run.status === "running",
    messages: [{ id: "user", role: "user", text: "Inspect levels", runId: run.id }, { id: "reply", role: "assistant", text: "Checking the model.", runId: run.id }],
    operations: [], runs: [run], settings: { provider: "test", model: "test", configured: true },
    providers: [{ id: "test", models: [{ id: "test", name: "Test" }] }],
  };
  else if (path === "/api/runs") data = { runs: [run] };
  else if (path === `/api/runs/${run.id}`) data = { run, calls, messages: [], operations: [] };
  else if (path === "/api/skills") data = { skills: [], diagnostics: [] };
  else if (path === "/api/console-draft") data = { draft: null };
  await route.fulfill({ json: data });
});
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/#fixture`);
  const reply = page.getByLabel("Revcode's reply");
  const timer = reply.getByText(/Working for/);
  await expect(timer).toContainText(/Working for 1m/);
  const before = await timer.textContent();
  await expect.poll(() => timer.textContent()).not.toBe(before);
  expect(await timer.locator('..').evaluate(node => getComputedStyle(node).borderBottomWidth)).toBe("1px");
  const tools = reply.getByRole("region", { name: "Tool calls" });
  await expect(tools.getByRole("button", { name: /revit_tool_/ })).toHaveCount(3);
  await tools.getByRole("button", { name: "2 earlier tool calls" }).click();
  await expect(tools.getByRole("button", { name: /revit_tool_/ })).toHaveCount(5);
  await tools.getByRole("button", { name: /revit_tool_0/ }).click();
  await expect(tools.locator("pre").filter({ hasText: '"count": 3' })).toBeVisible();
  await tools.getByRole("button", { name: "Show recent calls" }).click();
  calls[4].status = "failed";
  calls[4].error = "Could not read the model";
  await expect(tools.getByText("Could not read the model", { exact: true }).last()).toBeVisible();
  await expect(tools.getByRole("button", { name: /revit_tool_4/ })).toHaveAttribute("aria-expanded", "true");
  run.status = "finished";
  run.endedAt = new Date(Date.parse(run.startedAt) + 72000).toISOString();
  await page.reload();
  await expect(reply.getByText("Worked for 1m 12s", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(tools).toBeVisible();
  expect(await reply.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: resolve('.local/chat-parity-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({ path: resolve('.local/chat-parity-desktop.png') });
  run.status = "interrupted";
  await page.reload();
  await expect(reply.getByText("Interrupted after 1m 12s", { exact: true })).toBeVisible();
  run.status = "failed";
  await page.reload();
  await expect(reply.getByText("Failed after 1m 12s", { exact: true })).toBeVisible();
  run.detailsAvailable = false;
  await page.reload();
  await expect(reply.getByText("Tool details have expired.")).toBeVisible();
  expect(errors).toEqual([]);
  console.log("Chat parity browser checks passed");
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
