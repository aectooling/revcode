// Focused mocked API scenarios against the production UI; no native/provider execution.
import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
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
      context: null,
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
        "levels/SKILL.md":
          "# Review levels\nCheck the document and report elevations.",
        "levels/example.cs": "var count = 1;\nreturn count;",
      },
    };
  else if (path === "/api/runs")
    data = {
      runs: url.searchParams.get("search") === "missing" ? [] : [run],
      retention:
        "Completed details: 200 runs; missing evidence remains labeled.",
    };
  else if (path === "/api/runs/run-one")
    data = {
      run,
      messages,
      operations: [],
      calls: [
        {
          id: "call-one",
          runId: run.id,
          name: "revit_execute_csharp",
          sequence: 1,
          status: "failed",
          arguments: { code: "return bad;" },
          error: "Compile error",
          startedAt: run.startedAt,
          operationIds: [],
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
    .getByRole("button", { name: "Skills & Markdown", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Search skills").fill("levels");
  await page.getByRole("button", { name: /Review levels Inspect/ }).click();
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
  await page.getByLabel("Assistant mode").selectOption("authoring");
  await page.getByLabel("Message the assistant").fill("Create a skill.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Selected skill unavailable",
  );
  await expect(
    page.getByRole("button", { name: "Remove selected skill Review levels" }),
  ).toBeVisible();
  await expect(page.getByLabel("Message the assistant")).toHaveValue(
    "Create a skill.",
  );
  accept = true;
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByLabel("Message the assistant")).toHaveValue("");
  expect(submitted.mode).toBe("authoring");
  expect(submitted.selectedSkillIds).toEqual([skill.id]);
  await page.getByRole("button", { name: "View tools" }).first().click();
  await expect(page.getByText("Compile error", { exact: true })).toHaveCount(1);
  await page
    .getByRole("button", { name: "Create skill from this run" })
    .click();
  await expect(page.getByLabel("Message the assistant")).toHaveValue(
    /Create a reusable skill/,
  );
  await expect(page.getByText("Source runs:", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => submitted.sourceRunIds).toEqual(["run-one"]);
  const inspector = page.getByRole("complementary", {
    name: "Execution history",
  });
  const initial = (await inspector.boundingBox()).width;
  await page.getByRole("button", { name: "Expand", exact: true }).click();
  expect((await inspector.boundingBox()).width).toBeGreaterThan(initial);
  await page
    .getByRole("separator", { name: "Resize inspector width" })
    .press("ArrowRight");
  await page.getByLabel("Run filter").selectOption("");
  await page.getByLabel("Search run prompts").fill("missing");
  await expect(page.getByText("No matching runs.")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("separator", { name: "Resize inspector height" })
    .press("ArrowUp");
  await page
    .getByRole("button", { name: "Open settings", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Skills & Markdown", exact: true })
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
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page
    .getByRole("button", { name: "Collapse sidebar", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Skills & Markdown", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForTimeout(250);
  await page.screenshot({
    path: ".local/skills-runs-wide.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
  console.log(
    "PASS skills/runs UI: browser layouts, enable-and-select, failed selection preservation, authoring without native connection, structured sources, history search/navigation and accessible resizing.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
