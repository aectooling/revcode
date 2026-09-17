import { excalidrawEnglishUi } from "../scripts/excalidraw-assets";
import { createReadStream, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

// Serve the editor's fonts locally in development and include them in packaged builds.
function excalidrawFonts(): Plugin {
	const fonts = join(dirname(createRequire(import.meta.url).resolve("@excalidraw/excalidraw")), "fonts");
	return {
		name: "excalidraw-fonts",
		enforce: "pre",
		transform(code, id) {
			if (!id.replaceAll("\\", "/").includes("/@excalidraw/excalidraw/") || !code.includes('ASSETS_FALLBACK_URL')) return null;
			// The package always adds its CDN fallback, even with ASSET_PATH set.
			// Keep that fallback local too, including when the browser checks CSP.
			const fallback = /`https:\/\/esm\.sh\/[\s\S]*?\/dist\/prod\/`/g;
			if ([...code.matchAll(fallback)].length !== 1) this.error("Excalidraw's font fallback changed; review local font packaging.");
			return { code: code.replace(fallback, '`${window.location.origin}/excalidraw/`'), map: null };
		},
		configureServer(server) {
			server.middlewares.use("/excalidraw/fonts", (request, response, next) => {
				const path = resolve(fonts, `.${(request.url ?? "").split("?")[0]}`);
				if (!path.startsWith(`${fonts}${sep}`) || !path.endsWith(".woff2")) return next();
				const stream = createReadStream(path);
				stream.on("error", () => { response.statusCode = 404; response.end(); });
				response.setHeader("Content-Type", "font/woff2");
				stream.pipe(response);
			});
		},
		generateBundle(_options, bundle) {
			// CSS imports already emit Assistant under assets/. Only copy fonts
			// whose relative URLs survive in Excalidraw's JavaScript registry.
			const referencedFonts = new Set<string>();
			for (const output of Object.values(bundle)) {
				if (output.type !== "chunk") continue;
				for (const match of output.code.matchAll(/\.\/fonts\/([^"'`]+\.woff2)/g)) referencedFonts.add(match[1]);
			}
			if (!referencedFonts.size) this.error("Excalidraw's font registry changed; review local font packaging.");
			for (const file of readdirSync(fonts, { recursive: true, withFileTypes: true })) {
				if (!file.isFile() || !file.name.endsWith(".woff2")) continue;
				const path = join(file.parentPath, file.name);
				if (!referencedFonts.has(relative(fonts, path).split(sep).join("/"))) continue;
				this.emitFile({ type: "asset", fileName: `excalidraw/fonts/${relative(fonts, path).split(sep).join("/")}`, source: readFileSync(path) });
			}
		},
	};
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [excalidrawEnglishUi(), react(), tailwindcss(), excalidrawFonts()],
  build: { outDir: "../dist/web", emptyOutDir: true },
});
