import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "../src/core/build.js";
import { check } from "../src/checks/check.js";
import { parseFrontmatter } from "../src/content/markdown.js";
import { createPage, slugify } from "../src/cli/new.js";
import { copyFixture, WINDOWS, write } from "./helpers.js";

const fm = (root: string, rel: string) => parseFrontmatter(fs.readFileSync(path.join(root, rel), "utf8"), rel).frontmatter as Record<string, unknown>;

describe("vage new", () => {
  it("starts a page as a draft that builds and checks cleanly once published", async () => {
    const root = copyFixture();
    const created = createPage(root, "page", "pricing");
    expect(created).toEqual({ file: path.join("src", "pages", "pricing.md"), route: "/pricing/", draft: true });
    expect(fm(root, created.file)).toMatchObject({ title: "Pricing", draft: true });
    expect((await build(root)).skippedDrafts).toContain(created.file);

    const file = path.join(root, created.file);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("draft: true\n", ""));
    expect(fs.readFileSync(file, "utf8")).toContain("# description: one or two sentences");
    const result = await check(root);
    expect(result.findings.filter((f) => f.page === "/pricing/" && f.severity === "error")).toEqual([]);
    expect((await build(root)).skippedDrafts).not.toContain(created.file);
  });

  it("makes nested pages and keeps tricky titles valid YAML", () => {
    const root = copyFixture();
    const created = createPage(root, "page", "docs/getting-started", { title: 'Setup: "the easy way", step 1', description: "Install it: then run it." });
    expect(created.route).toBe("/docs/getting-started/");
    expect(fm(root, created.file)).toMatchObject({ title: 'Setup: "the easy way", step 1', description: "Install it: then run it." });
  });

  it("starts a post with type article and a date, and an author only when given", () => {
    const root = copyFixture();
    const post = createPage(root, "post", "Our First Launch: v1!", { date: "2026-11-02" });
    expect(post.file).toBe(path.join("src", "pages", "blog", "our-first-launch-v1.md"));
    expect(fm(root, post.file)).toMatchObject({ title: "Our First Launch: v1!", type: "article", datePublished: "2026-11-02", draft: true });
    expect(fm(root, post.file).author).toBeUndefined();
    const news = createPage(root, "post", "Opening hours change", { under: "news", author: "Asha" });
    expect(news.route).toBe("/news/opening-hours-change/");
    expect(fm(root, news.file)).toMatchObject({ author: "Asha" });
    expect(String(fm(root, news.file).datePublished)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("never overwrites, and refuses paths outside src/pages", () => {
    const root = copyFixture();
    expect(() => createPage(root, "page", "about")).toThrow(/already exists/);
    write(root, "src/pages/guides/index.md", "---\ntitle: Guides\n---\n# Guides\n");
    expect(() => createPage(root, "page", "guides")).toThrow(/guides[\\/]index\.md already exists/);
    for (const bad of ["../escape", "Pricing", "a//b", "a b", "/"]) expect(() => createPage(root, "page", bad)).toThrow(/isn't a valid page path/);
    expect(() => createPage(root, "post", "!!!")).toThrow(/Couldn't make a file name/);
    expect(() => createPage(root, "post", "Fine", { date: "2 Nov" })).toThrow(/YYYY-MM-DD/);
    expect(slugify("Crème brûlée & co.")).toBe("creme-brulee-co");
  });

  it("review fixes: one-line values, symlinked folders, --slug", () => {
    const root = copyFixture();
    expect(() => createPage(root, "page", "x", { title: "One\nTwo" })).toThrow(/one line/);
    expect(() => createPage(root, "post", "Fine", { author: "A\r\nB" })).toThrow(/one line/);
    const outside = fs.mkdtempSync(path.join(path.dirname(root), "outside-"));
    fs.symlinkSync(outside, path.join(root, "src/pages/linked"), WINDOWS ? "junction" : "dir"); // junctions need no admin rights on Windows
    expect(() => createPage(root, "page", "linked/escape")).toThrow(/leads outside src\/pages|leads outside src\\pages/);
    expect(fs.existsSync(path.join(outside, "escape.md"))).toBe(false);
    expect(() => createPage(root, "post", "日本語のタイトル")).toThrow(/--slug/);
    expect(createPage(root, "post", "日本語のタイトル", { slug: "japanese-title" }).route).toBe("/blog/japanese-title/");
    expect(() => createPage(root, "post", "x", { slug: "Bad Slug" })).toThrow(/isn't a valid --slug/);
  });
});
