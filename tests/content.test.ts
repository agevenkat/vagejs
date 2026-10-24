import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../src/content/markdown.js";
import { loadConfig, parseConfig } from "../src/core/config.js";
import { escapeHtml } from "../src/core/html.js";
import { defaultLayout } from "../src/core/render.js";
import { FIXTURE } from "./helpers.js";

describe("parseMarkdown", () => {
  it("parses frontmatter and renders the body", () => {
    const page = parseMarkdown("---\ntitle: Hi\nauthor: Me\n---\n# Heading\n\n*em*\n", "x.md");
    expect(page.frontmatter).toEqual({ title: "Hi", author: "Me", draft: false, noindex: false, type: "website" });
    expect(page.body).toBe("# Heading\n\n*em*\n");
    expect(page.html).toContain("<h1>Heading</h1>");
    expect(page.html).toContain("<em>em</em>");
  });

  it("requires a title", () => {
    expect(() => parseMarkdown("# No frontmatter\n", "x.md")).toThrow(/Invalid frontmatter[\s\S]*title[\s\S]*at x\.md/);
  });

  it("reports invalid YAML with the file path", () => {
    expect(() => parseMarkdown("---\ntitle: [unclosed\n---\n", "bad.md")).toThrow(/Invalid YAML frontmatter[\s\S]*bad\.md/);
  });

  it("rejects layout names with path characters", () => {
    expect(() => parseMarkdown("---\ntitle: T\nlayout: ../evil\n---\n", "x.md")).toThrow(/layout/);
  });
});

describe("loadConfig", () => {
  const loaderFor = (value: unknown) => async () => ({ default: value });

  it("applies defaults when there is no config file", async () => {
    expect(await loadConfig("/nonexistent", loaderFor(undefined))).toEqual({
      lang: "en",
      redirects: {},
      images: { optimize: false, widths: [480, 960, 1600], quality: 75, avif: false, sizes: "(max-width: 48rem) 100vw, 48rem" },
      markdown: { html: "sanitize", inlineStyles: false },
      seo: { robots: { rules: [] }, feeds: [], lastmod: "frontmatter", markdownCopies: false, sitemap: true, llmsTxt: { full: false }, structuredData: {} },
      performance: {
        budgets: { performance: 90, accessibility: 95, seo: 95, bestPractices: 90, javascriptKb: 100, cssKb: 50, imageKb: 500, fontKb: 150, totalKb: 1000, requests: 30 },
        lighthouse: { enabled: false, pages: ["/"] },
      },
      deploy: { target: "github-pages" },
      security: { headers: true, csp: "enforce", cspSources: {}, outboundLinks: "lock", spamPatterns: true },
      guidelines: {},
      integrations: {},
    });
  });

  it("rejects unknown keys and non-http URLs", async () => {
    await expect(loadConfig(FIXTURE, loaderFor({ sitemap: true }))).rejects.toThrow(/Invalid config[\s\S]*sitemap[\s\S]*vage\.config\.ts/);
    expect(() => parseConfig({ site: "ftp://x.com" })).toThrow(/Invalid config[\s\S]*site/);
  });
});

describe("html", () => {
  it("escapes HTML special characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });

  it("default layout escapes metadata and keeps content as HTML", async () => {
    const html = await defaultLayout({
      content: "<p>body</p>",
      page: { route: "/", title: "A <b>", frontmatter: { title: "A <b>", draft: false, noindex: false, type: "website" } },
      site: { title: "Site", lang: "fr", redirects: {}, seo: { robots: false, sitemap: false, llmsTxt: false, structuredData: false } },
    });
    expect(html).toContain('<html lang="fr">');
    expect(html).toContain("<title>A &lt;b&gt; | Site</title>");
    expect(html).toContain("<p>body</p>");
  });
});
