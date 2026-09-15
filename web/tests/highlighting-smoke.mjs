import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

const server = await createServer({ configFile: "web/vite.config.ts", server: { host: "127.0.0.1", port: 0 } });
await server.listen();
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  await page.goto(`${server.resolvedUrls.local[0]}tests/highlighting-fixture.html`);
  const editor = page.getByRole("textbox", { name: "C# method body" });
  await expect(editor).toHaveCSS("color", "rgba(0, 0, 0, 0)");
  const source = await editor.inputValue();
  await page.getByLabel("Historical source", { exact: true }).getByRole("button", { name: "Copy", exact: true }).click();
  await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, "\n"))).toBe(source);
  await expect(page.locator(".message-markdown img")).toHaveCount(0);
  await expect(page.locator(".message-markdown pre")).toHaveCount(2);
  await editor.focus();
  await editor.press("Control+End");
  await editor.press("Enter");
  await editor.pressSequentially("// pasted text");
  await expect(editor).toHaveValue(source + "\n// pasted text");
  await editor.press("Control+z");
  await expect(editor).not.toHaveValue(source + "\n// pasted text");
  await editor.dispatchEvent("compositionstart");
  await editor.press("Control+Enter");
  await expect(page.getByLabel("Run count")).toHaveText("0");
  await editor.dispatchEvent("compositionend");
  await editor.press("Control+Enter");
  await expect(page.getByLabel("Run count")).toHaveText("1");
  await page.locator("#mode").selectOption("batch");
  await page.getByRole("textbox", { name: "Step 1 C#", exact: true }).press("Control+Enter");
  await page.getByRole("textbox", { name: "Batch verification", exact: true }).press("Meta+Enter");
  await expect(page.getByLabel("Run count")).toHaveText("3");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator("#mode").selectOption("query");
  await editor.fill("// " + "long text ".repeat(80) + "\n" + "return null;\n".repeat(40));
  await expect(editor).toHaveCSS("color", "rgba(0, 0, 0, 0)");
  await editor.evaluate(node => { node.scrollTop = 100; node.scrollLeft = 100; node.dispatchEvent(new Event("scroll", { bubbles: true })); });
  await expect.poll(() => editor.evaluate(node => {
    const pre = node.previousElementSibling;
    return pre.scrollTop === node.scrollTop && pre.scrollLeft === node.scrollLeft;
  })).toBe(true);
  console.log("Highlighting smoke passed: safe tokens, exact copy, plain fences, native undo, IME, shortcuts, narrow layout, scroll synchronization.");
} finally { await browser.close(); await server.close(); }
