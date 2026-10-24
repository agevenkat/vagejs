import fs from "node:fs";
import path from "node:path";
import { parse } from "node-html-parser";
import type { SiteConfig } from "../core/config.js";
import type { Finding } from "../checks/check.js";

export type ResourceKind = "html" | "javascript" | "css" | "image" | "font";

export interface PageWeight {
  route: string;
  /** Uncompressed bytes of local files by kind. Transfer size depends on the host's compression. */
  bytes: Record<ResourceKind, number>;
  total: number;
  /** Requests including the HTML document and external resources. */
  requests: number;
  /** Resources on other origins: counted as requests, size not measured. */
  external: string[];
  /** True when the page ships executable JavaScript. */
  hasJavaScript: boolean;
}

const FONT = /\.(woff2?|ttf|otf|eot)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|ico)$/i;

/** Measures each built page and the local resources it references. */
export function measurePages(outDir: string, pages: { route: string; outFile: string }[], site?: string): PageWeight[] {
  return pages.map(({ route, outFile }) => {
    const html = fs.readFileSync(path.join(outDir, outFile), "utf8");
    const doc = parse(html);
    const weight: PageWeight = {
      route,
      bytes: { html: Buffer.byteLength(html), javascript: 0, css: 0, image: 0, font: 0 },
      total: 0,
      requests: 1,
      external: [],
      hasJavaScript: false,
    };
    const seen = new Set<string>();
    const add = (ref: string | undefined, kind: ResourceKind, base: string) => {
      if (!ref || ref.startsWith("data:")) return;
      const url = new URL(ref, `http://local.invalid${base}`);
      const key = url.href;
      if (seen.has(key)) return;
      seen.add(key);
      weight.requests++;
      const local = url.host === "local.invalid" || (site !== undefined && url.origin === site);
      if (!local) return weight.external.push(url.href);
      let rel: string;
      try {
        rel = decodeURIComponent(url.pathname);
      } catch {
        return; // malformed URLs are reported by `vage check`
      }
      const file = path.resolve(outDir, `.${rel}`);
      if (!file.startsWith(outDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return; // missing assets are reported by `vage check`
      weight.bytes[kind] += fs.statSync(file).size;
      if (kind === "css") {
        // Fonts and images referenced from stylesheets load with the page too.
        for (const m of fs.readFileSync(file, "utf8").matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
          const inner = m[1]!;
          if (FONT.test(inner)) add(new URL(inner, url).pathname, "font", "/");
          else if (IMAGE.test(inner)) add(new URL(inner, url).pathname, "image", "/");
        }
      }
    };

    for (const s of doc.querySelectorAll("script")) {
      const type = s.getAttribute("type");
      if (type && !/^(module|text\/javascript|application\/javascript)$/i.test(type)) continue; // e.g. JSON-LD
      weight.hasJavaScript = true;
      if (s.getAttribute("src")) add(s.getAttribute("src"), "javascript", route);
    }
    for (const l of doc.querySelectorAll('link[rel="stylesheet"]')) add(l.getAttribute("href"), "css", route);
    for (const l of doc.querySelectorAll('link[rel="preload"][as="font"]')) add(l.getAttribute("href"), "font", route);
    for (const img of doc.querySelectorAll("img")) add(downloadedImage(img), "image", route);

    weight.total = Object.values(weight.bytes).reduce((a, b) => a + b, 0);
    return weight;
  });
}

/**
 * The file a browser actually downloads for an <img>: the first <source> of its
 * <picture> (AVIF from images.avif), else its srcset (WebP), else src. With several
 * widths, the largest counts: what a wide, high-density screen loads.
 */
function downloadedImage(img: ReturnType<typeof parse>): string | undefined {
  const source = img.parentNode?.rawTagName?.toLowerCase() === "picture" ? img.parentNode.querySelector("source[srcset]") : null;
  const srcset = source?.getAttribute("srcset") ?? img.getAttribute("srcset");
  if (!srcset) return img.getAttribute("src");
  let best: { url: string; size: number } | undefined;
  for (const entry of srcset.split(",")) {
    const [url, descriptor = "1x"] = entry.trim().split(/\s+/);
    // "960w" (width) or "2x" (density): either way, the biggest number is the biggest file.
    const size = Number(/^([\d.]+)[wx]$/.exec(descriptor)?.[1] ?? 0);
    if (url && (!best || size > best.size)) best = { url, size };
  }
  return best?.url ?? img.getAttribute("src");
}

const BUDGET_KEYS: [keyof SiteConfig["performance"]["budgets"], ResourceKind | "total"][] = [
  ["javascriptKb", "javascript"],
  ["cssKb", "css"],
  ["imageKb", "image"],
  ["fontKb", "font"],
  ["totalKb", "total"],
];

export function budgetFindings(weights: PageWeight[], budgets: SiteConfig["performance"]["budgets"]): Finding[] {
  const findings: Finding[] = [];
  for (const w of weights) {
    for (const [key, kind] of BUDGET_KEYS) {
      const bytes = kind === "total" ? w.total : w.bytes[kind];
      if (bytes > budgets[key] * 1024) {
        findings.push({
          rule: "budget",
          severity: "warning",
          page: w.route,
          message: `${kind} is ${kbText(bytes)}, over the ${budgets[key]} KB budget (performance.budgets.${key}).`,
        });
      }
    }
    if (w.requests > budgets.requests) {
      findings.push({
        rule: "budget",
        severity: "warning",
        page: w.route,
        message: `${w.requests} requests, over the budget of ${budgets.requests} (performance.budgets.requests).`,
      });
    }
  }
  return findings;
}

export function kbText(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}
