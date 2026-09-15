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
const skill = {
  id: "user:test:levels/skill.md",
  name: "Review levels",
  description: "Inspect level elevations safely.",
  path: "C:/skills/levels/SKILL.md",
  root: "C:/skills",
  source: "user",
  enabled: false,
  revision: "r1",
  files: ["levels/SKILL.md", "levels/example.cs"],
};
let revision = 1,
  accept = false,
  submitted;
const run = {
  id: "run-one",
  number: 1,
  instanceId: "fixture",
  requestId: "request-one",
  userMessageId: "message-one",
  assistantMessageId: "reply-one",
  promptPreview: "Inspect all levels",
  startedAt: "2026-09-15T00:00:00Z",
  status: "finished",
  intent: "work",
  mode: "execution",
  sourceRunIds: [],
  provider: "test",
  model: "test",
  toolNames: ["revit_execute_csharp"],
  failedCalls: 1,
  callCount: 1,
  detailsAvailable: true,
};
const messages = [
  {
    id: "message-one",
    role: "user",
    text: "Inspect all levels",
    runId: run.id,
  },
  {
    id: "reply-one",
    role: "assistant",
    text: "Inspection encountered a compile error.",
    runId: run.id,
  },
];
await page.route("**/api/**", async (route) => {
  const req = route.request(),
    url = new URL(req.url()),
    path = url.pathname;
  let data = {};
  let status = 200;
  if (path === "/api/state")
    data = {
      instanceId: "fixture",
      connected: false,
      busy: false,
      chatBusy: false,
      context: { document: { token: "doc", title: "VeryLongProjectTitle".repeat(25), activeView: "VeryLongViewTitle".repeat(25), isFamily: false, isReadOnly: false, selection: [] } },
      messages,
      operations: [],
      runs: [run],
      settings: { provider: "test", model: "test", configured: true },
      providers: [
        {
          id: "test",
          name: "Test",
          authenticated: true,
          models: [{ id: "test", name: "Test" }],
        },
      ],
    };
  else if (path === "/api/skills")
    data = { folder: "C:/skills", revision, skills: [skill], diagnostics: [] };
  else if (path === "/api/skills/settings") {
    const body = req.postDataJSON();
    expect(body.expectedRevision).toBe(revision);
    skill.enabled = body.enabled;
    revision++;
    data = { folder: "C:/skills", revision, skills: [skill], diagnostics: [] };
  } else if (path.endsWith("/revisions"))
    data = {
      expired: false,
      revisions: [
        {
          revision: "r0",
          createdAt: "2026-09-14",
          summary: "Previous procedure",
          changes: [
            {
              path: skill.files[0],
              before: "Old procedure",
              after: "New procedure",
            },
          ],
          files: {},
        },
      ],
    };
  else if (path.startsWith("/api/skills/"))
    data = {
      skill,
      files: {
        "levels/example.cs": "var count = 1;\nreturn count;",
        "levels/SKILL.md":
          '\uFEFF---\r\nname: "Review levels"\r\ndescription: >-\r\n  Inspect level elevations safely.\r\nmetadata:\r\n  tags: [revit, levels]\r\n---\r\n# Review levels\nCheck the document and report elevations.',
      },
    };
  else if (path === "/api/runs")
    data = {
      runs: [run],
      retention:
        "Completed details: 200 runs; missing evidence remains labeled.",
    };
  else if (path === "/api/runs/run-one")
    data = {
      run,
      messages,
      operations: [{ operationId: "op-one", mode: "query", code: "return bad;", status: "failed", error: "Compile error", result: { count: 42 }, logs: ["Verbose execution trace"], diagnostics: [{ message: "Detailed diagnostic" }] }],
      calls: [
        {
          id: "call-one",
          runId: run.id,
          name: "revit_execute_csharp",
          sequence: 1,
          status: "failed",
          arguments: { code: "return bad;" },
          error: "Compile error",
          result: { status: "failed", diagnostics: ["Unknown identifier"] },
          startedAt: run.startedAt,
          operationIds: ["op-one"],
        },
      ],
      selectedSkills: [],
      readSkills: [],
      context: { document: "Recorded project" },
    };
  else if (path === "/api/console-draft") data = { draft: null };
  else if (path === "/api/chat") {
    submitted = req.postDataJSON();
    status = accept ? 200 : 409;
    data = accept
      ? { accepted: true }
      : { error: "Selected skill unavailable. Refresh and select it again." };
  }
  await route.fulfill({ status, json: data });
});
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/#fixture`);
  await page
    .getByRole("button", { name: "skill.md", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Search skills").fill("no matching skill");
  await expect(page.getByText("No matching skills.", { exact: true })).toBeVisible();
  await page.getByLabel("Search skills").fill("levels");
  await page.getByRole("button", { name: /Review levels Inspect/ }).click();
  await expect(page.getByLabel("Reference file")).toHaveValue("levels/SKILL.md");
  await expect(page.getByRole("region", { name: "Frontmatter" })).toContainText('name: "Review levels"');
  await page.getByRole("button", { name: "Enable and select" }).click();
  await expect(
    page.getByRole("button", {
      name: "Selected for next message",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel("Reference file").selectOption("levels/example.cs");
  await expect(page.locator(".shiki")).toHaveCount(0); // tokens render safely without injected Shiki HTML
  await expect(
    page.getByText("var count = 1;", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByLabel("Assistant mode")).toHaveCount(0);
  await expect(page.getByText("Select skills…", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Enter to send · Shift + Enter for a new line")).toHaveCount(0);
  await page.getByLabel("Message the assistant").fill("Create a skill.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Selected skill unavailable",
  );
  await expect(page.getByLabel("Message the assistant")).toHaveValue(
    "Create a skill.",
  );
  accept = true;
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByLabel("Message the assistant")).toHaveValue("");
  expect(submitted.mode).toBe("execution");
  expect(submitted.selectedSkillIds).toEqual([skill.id]);
  await page.getByRole("button", { name: "skill.md", exact: true }).click();
  await page.getByRole("button", { name: "Create from recent work" }).click();
  await expect(page.getByLabel("Message the assistant")).toHaveValue(/Create a reusable skill from the recent run/);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByLabel("Message the assistant")).toHaveValue("");
  expect(submitted.mode).toBe("authoring");
  expect(submitted.sourceRunIds).toEqual([run.id]);
  // A completed authoring draft must not keep later requests in authoring mode.
  await page.getByLabel("Message the assistant").fill("Create a skill.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByLabel("Message the assistant")).toHaveValue("");
  expect(submitted.mode).toBe("execution");
  expect(submitted.sourceRunIds).toEqual([]);
  await page.getByRole("button", { name: "View tools" }).first().click();
  await expect(page.getByLabel("Result", { exact: true })).toHaveCount(1);
  await expect(page.getByLabel("Result", { exact: true })).toContainText("Compile error");
  await expect(page.getByLabel("Submitted C#", { exact: true })).toHaveCount(1);
  await expect(page.getByLabel("Inputs", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Verbose execution trace")).toHaveCount(0);
  await expect(page.getByText("Detailed diagnostic")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /Execute Revit C#/ })).toBeVisible();
  for (const label of ["Submitted C#", "Result"]) {
    await expect.poll(() => page.getByLabel(label, { exact: true }).locator("code span").evaluateAll(nodes => nodes.some(node => {
      const channels = getComputedStyle(node).color.match(/\d+/g)?.slice(0, 3);
      return channels && new Set(channels).size > 1;
    }))).toBe(true);
  }
  const sidebar = page.getByRole("complementary", { name: "Revcode controls" });
  expect(await sidebar.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  const title = sidebar.getByText("VeryLongProjectTitle".repeat(25), { exact: true });
  await expect(title).toHaveCSS("text-overflow", "ellipsis");
  expect(await title.evaluate(node => node.clientWidth < node.scrollWidth)).toBe(true);
  const jump = page.getByRole("button", { name: "Jump to message" });
  const status = page.getByText("Finished · 1 call · 1 failed", { exact: true });
  expect(Math.abs((await jump.boundingBox()).y - (await status.boundingBox()).y)).toBeLessThan(3);
  await expect(page.getByRole("button", { name: "Create skill from this run" })).toHaveCount(0);
  await expect(page.getByText("Select as skill source")).toHaveCount(0);
  await expect(page.getByLabel("Search run prompts")).toHaveCount(0);
  await expect.poll(() => page.locator('[aria-label="Result"] code span[style*="color"]').count()).toBeGreaterThan(0);
  const inspector = page.getByRole("complementary", {
    name: "Execution history",
  });
  const initial = (await inspector.boundingBox()).width;
  await page.getByRole("button", { name: "Expand execution history", exact: true }).click();
  expect((await inspector.boundingBox()).width).toBeGreaterThan(initial);
  await page
    .getByRole("separator", { name: "Resize inspector width" })
    .press("ArrowRight");
  await page.getByRole("button", { name: "All runs", exact: true }).click();
  await expect(page.getByRole("button", { name: "Run 1", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Run 1", exact: true }).click();
  await expect(page.getByRole("button", { name: "Run 1", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Collapse execution history" }).click();
  expect((await inspector.boundingBox()).width).toBe(48);
  await page.getByRole("button", { name: "Show execution history" }).click();
  await expect(page.getByRole("button", { name: "Jump to message" })).toBeVisible();
  await page.getByRole("button", { name: "Jump to message" }).click();
  await page.screenshot({ path: ".local/execution-history-wide.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("separator", { name: "Resize inspector height" })
    .press("ArrowUp");
  await page
    .getByRole("button", { name: "Open settings", exact: true })
    .click();
  await page
    .getByRole("button", { name: "skill.md", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.waitForTimeout(250);
  await page.screenshot({
    path: ".local/skills-runs-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: /Review levels Inspect/ }).click();
  await expect(page.getByLabel("Reference file")).toHaveValue("levels/example.cs");
  await page.getByLabel("Reference file").selectOption("levels/SKILL.md");
  await expect(page.getByRole("region", { name: "Frontmatter" })).toContainText('name: "Review levels"');
  await expect(page.getByLabel("Skill preview").locator(".message-markdown")).not.toContainText("metadata:");
  await expect(page.getByLabel("Skill preview").getByRole("heading", { name: "Review levels", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Choose folder" }).click();
  await page.getByLabel("Existing absolute folder").fill("C:/edited-skills");
  await page.waitForResponse(response => new URL(response.url()).pathname === "/api/skills");
  await expect(page.getByLabel("Existing absolute folder")).toHaveValue("C:/edited-skills");
  await page.getByRole("button", { name: "Choose folder" }).click();
  await expect(page.getByLabel("Reference file")).toBeVisible();
  await expect(page.getByLabel("Skill preview")).toContainText("Check the document and report elevations.");
  expect(await page.getByRole("dialog").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.getByRole("button", { name: "Back to skills" }).click();
  await expect(page.getByRole("button", { name: /Review levels Inspect/ })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page
    .getByRole("button", { name: "Collapse sidebar", exact: true })
    .click();
  await page
    .getByRole("button", { name: "skill.md", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForTimeout(250);
  await page.screenshot({
    path: ".local/skills-runs-wide.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  // Hold an earlier snapshot until a later request has displayed its final result.
  const held = [];
  await page.route("**/api/runs/run-one", route => { held.push(route); });
  await page.getByRole("button", { name: "All runs", exact: true }).click();
  await expect.poll(() => held.length).toBeGreaterThan(0);
  const stale = held[0];
  await page.getByRole("button", { name: "Run 1", exact: true }).click();
  await expect.poll(() => held.length).toBeGreaterThan(1);
  const finalDetail = {
    run, messages, calls: [],
    operations: [{ operationId: "race-op", mode: "query", code: "return 42;", status: "succeeded", result: { reviewMarker: "confirmed-result" } }],
  };
  for (const route of held.slice(1)) await route.fulfill({ json: finalDetail });
  await expect(inspector).toContainText("confirmed-result");
  await stale.fulfill({ json: { ...finalDetail, operations: [{ ...finalDetail.operations[0], status: "running", result: { reviewMarker: "stale-result" } }] } });
  // Allow fetch callbacks and React's subsequent paint to complete.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(inspector).toContainText("confirmed-result");
  await expect(inspector).not.toContainText("stale-result");
  expect(errors).toEqual([]);
  console.log(
    "PASS skills/runs UI: browser layouts, enable-and-select, failed selection preservation, authoring without native connection, uncluttered composer, capsule run navigation, icon collapse/expand, JSON highlighting and accessible resizing.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
