import fs from "node:fs";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { findConfigFile, loadConfig } from "../core/config.js";
import { VageError } from "../core/errors.js";
import { escapeHtml } from "../core/html.js";
import { baseViteConfig, viteLoader } from "../core/loader.js";
import { renderPage } from "../core/render.js";
import { cacheDir } from "../content/optimize.js";
import { collectPages } from "../core/pages.js";
import { renderSite } from "../core/site.js";
import { discoverRoutes, findNotFoundPage, normalizeRequestPath } from "../core/routes.js";
import { devAccessGuard } from "./guard.js";
import { listenOrExplain, type ServeOptions } from "./listen.js";
import { redirect } from "./preview.js";

/**
 * Starts the dev server. Pages are rendered on every request, so new and
 * edited pages show up without a restart; any change under src/ or to the
 * config triggers a full browser reload.
 */
export async function startDevServer(root: string, options: ServeOptions = {}): Promise<ViteDevServer> {
  // Vite reports watcher paths with symlinks resolved, so compare against the real path.
  // .native also expands Windows 8.3 short names (RUNNER~1 -> runneradmin).
  root = path.resolve(root);
  if (!fs.existsSync(root)) throw new VageError(`Project directory not found: ${root}`);
  root = fs.realpathSync.native(root);
  const pagesDir = path.join(root, "src", "pages");
  const srcDir = path.join(root, "src") + path.sep;

  const server = await createServer({
    ...baseViteConfig(root),
    plugins: [devAccessGuard(root, new Set(Object.keys(DISCOVERY_FILES)))],
    server: { port: options.port, strictPort: options.port !== undefined, host: options.host },
  });
  const load = viteLoader(server);

  // Vite reports "C:/..." on Windows; compare normalized paths, ignoring case there.
  const key = (file: string) => (process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file));
  const srcKey = key(srcDir.slice(0, -1)) + path.sep;
  server.watcher.on("all", (_event, file) => {
    const config = findConfigFile(root);
    if (key(file).startsWith(srcKey) || (config && key(file) === key(config))) {
      server.ws.send({ type: "full-reload", path: "*" });
    }
  });

  server.middlewares.use(async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const urlPath = req.url ?? "/";
    const pathname = urlPath.split(/[?#]/)[0]!;
    try {
      const optimized = /^\/_vage\/img\/([\w-]+\.(webp|avif))$/.exec(pathname);
      if (optimized) {
        const file = path.join(cacheDir(root), optimized[1]!);
        if (!fs.existsSync(file)) return send(res, 404, plainPage("404 — Not found", `No optimized image at ${pathname}`));
        res.setHeader("Content-Type", `image/${optimized[2]}`);
        return res.end(fs.readFileSync(file));
      }
      const isFeed = /^\/(?:[\w.-]+\/)*feed\.xml$/.test(pathname) && !pathname.includes("..");
      const isCopy = /^\/(?:[\w-]+\/)*[\w-]+\.md$/.test(pathname);
      if (DISCOVERY_FILES[pathname] || isFeed || isCopy) {
        // Built from the whole site (drafts excluded), exactly as `vage build` would write it.
        const content = (await renderSite(root, load)).files.get(pathname.slice(1));
        if (content === undefined) {
          // Feeds and Markdown copies exist only as generated files; never fall through to Vite,
          // which would serve project sources (e.g. /src/pages/about.md).
          if (isFeed || isCopy) return send(res, 404, plainPage("404 — Not found", `No generated file at ${pathname}`));
          return next();
        }
        res.setHeader("Content-Type", DISCOVERY_FILES[pathname] ?? (isCopy ? "text/markdown; charset=utf-8" : "application/rss+xml; charset=utf-8"));
        return res.end(content);
      }
      // Leave asset requests (any extension other than .html) to Vite.
      if (/\.[a-z0-9]+$/i.test(pathname) && !pathname.endsWith(".html")) return next();

      const site = await loadConfig(root, load);
      let route: string;
      try {
        route = normalizeRequestPath(urlPath);
      } catch {
        res.statusCode = 400;
        return res.end("Bad request");
      }
      const target = Object.entries(site.redirects).find(([from]) => normalizeRequestPath(from) === route)?.[1];
      if (target) return redirect(res, target);
      const entry = discoverRoutes(pagesDir).find((r) => r.route === route);
      // Match production preview: "/about" -> "/about/".
      if (entry && !pathname.endsWith("/") && !pathname.endsWith(".html")) {
        return redirect(res, entry.route + urlPath.slice(pathname.length));
      }
      const notFound = findNotFoundPage(pagesDir);
      if (!entry && !notFound) {
        return send(res, 404, await server.transformIndexHtml(urlPath, plainPage("404 — Not found", `No page for ${route}`)));
      }
      const file = entry?.file ?? notFound!;
      const pages = await collectPages(root, site, load, { skipInvalid: true });
      const page = await renderPage({ root, file, route: entry ? route : "/404/", site, load, notFound: !entry, pages });
      send(res, entry ? 200 : 404, await server.transformIndexHtml(urlPath, page.html));
    } catch (err) {
      const message = (err as Error).message;
      server.config.logger.error(message);
      send(res, 500, await server.transformIndexHtml(urlPath, plainPage("Render error", message)));
    }
  });

  await listenOrExplain(() => server.listen(), options.port);
  return server;
}

const DISCOVERY_FILES: Record<string, string> = {
  "/robots.txt": "text/plain; charset=utf-8",
  "/sitemap.xml": "application/xml; charset=utf-8",
  "/llms.txt": "text/markdown; charset=utf-8",
  "/llms-full.txt": "text/markdown; charset=utf-8",
};

function send(res: ServerResponse, status: number, html: string) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

function plainPage(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><pre>${escapeHtml(message)}</pre></body></html>`;
}

