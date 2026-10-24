import fs from "node:fs";
import path from "node:path";
import { VageError } from "../core/errors.js";

/**
 * `vage new page <path>` and `vage new post <title>`: start a page with valid frontmatter.
 * New files are drafts (`draft: true`), so placeholder text can't be published by
 * accident: the dev server shows them, `vage build` skips them until the line is removed.
 * Without a description, a comment marks where one goes (search engines then get the
 * site's description, or nothing): vagejs never writes placeholder text that could publish.
 */
export interface NewOptions {
  title?: string;
  description?: string;
  /** Posts: the section folder under src/pages (default "blog"). */
  under?: string;
  /** Posts: YYYY-MM-DD (default: today, local time). */
  date?: string;
  /** Posts: only written when given; vagejs never invents an author. */
  author?: string;
  /** Posts: the file name, when the title has no Latin letters or digits to make one from. */
  slug?: string;
}

export interface Created {
  file: string;
  route: string;
  draft: true;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

/** "Getting Started: Part 2!" -> "getting-started-part-2" */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
}

const titleFromSlug = (slug: string) => {
  const last = slug.split("/").at(-1)!;
  return last === "index" ? "Overview" : last.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
};

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** YAML double-quoted scalars are JSON strings, so any title is written safely. */
const yaml = (value: string) => JSON.stringify(value);

export function createPage(root: string, kind: "page" | "post", name: string, options: NewOptions = {}): Created {
  const pagesDir = path.join(path.resolve(root), "src", "pages");
  if (!fs.existsSync(pagesDir)) throw new VageError(`No src/pages folder in ${path.resolve(root)}. Run this inside a vagejs project.`);
  // One line each: a line break would end up in the heading and fail the frontmatter schema.
  for (const [label, value] of [["title", kind === "post" ? name : options.title], ["description", options.description], ["author", options.author]] as const) {
    if (value !== undefined && /[\u0000-\u001f\u007f]/.test(value)) throw new VageError(`The ${label} must be one line of text, without line breaks or tabs.`);
  }

  let slug: string;
  let title: string;
  if (kind === "page") {
    slug = name.replace(/^\/+|\/+$/g, "").replace(/\.md$/, "");
    if (!SLUG.test(slug)) throw new VageError(`"${name}" isn't a valid page path. Use lowercase letters, numbers and hyphens, with / between folders (e.g. pricing or docs/setup).`);
    title = options.title?.trim() || titleFromSlug(slug);
  } else {
    title = name.trim();
    if (!title) throw new VageError('Give the post a title, e.g. vage new post "Our first launch".');
    const under = (options.under ?? "blog").replace(/^\/+|\/+$/g, "");
    if (!SLUG.test(under)) throw new VageError(`"${options.under}" isn't a valid section folder. Use lowercase letters, numbers, hyphens and /.`);
    const base = options.slug !== undefined ? options.slug : slugify(title);
    if (!base) throw new VageError(`Couldn't make a file name from "${name}". Add --slug <name> (lowercase letters, numbers and hyphens).`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(base)) throw new VageError(`"${base}" isn't a valid --slug. Use lowercase letters, numbers and hyphens.`);
    slug = `${under}/${base}`;
  }
  if (options.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(options.date)) throw new VageError(`--date must be YYYY-MM-DD, not "${options.date}".`);

  const route = slug === "index" ? "/" : `/${slug.replace(/(^|\/)index$/, "")}/`.replace(/\/+/g, "/");
  const rel = path.join("src", "pages", `${slug}.md`);
  const file = path.join(pagesDir, `${slug}.md`);
  // A page at /x/ can come from x.md or x/index.md: refuse either, never overwrite.
  const twin = slug.endsWith("/index") ? path.join(pagesDir, `${slug.slice(0, -"/index".length)}.md`) : path.join(pagesDir, slug, "index.md");
  for (const existing of [file, twin]) {
    if (fs.existsSync(existing)) throw new VageError(`${path.relative(path.resolve(root), existing)} already exists, so ${route} is taken. Pick another name, or edit that file.`);
  }

  const lines = ["---", `title: ${yaml(title)}`];
  if (options.description?.trim()) lines.push(`description: ${yaml(options.description.trim())}`);
  else lines.push("# description: one or two sentences for search results (until then, the site's description is used)");
  if (kind === "post") {
    lines.push("type: article", `datePublished: ${options.date ?? today()}`);
    if (options.author?.trim()) lines.push(`author: ${yaml(options.author.trim())}`);
  }
  lines.push("# Remove the next line when the page is ready to publish.", "draft: true", "---", "", `# ${title}`, "", "Write here.", "");

  // Never write through a symlinked folder: it can point outside the project.
  let existing = path.dirname(file);
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const realPages = fs.realpathSync(pagesDir);
  const realParent = fs.realpathSync(existing);
  if (realParent !== realPages && !realParent.startsWith(realPages + path.sep)) throw new VageError(`${path.relative(path.resolve(root), existing)} leads outside src/pages (a symlink?). Create the page in a regular folder.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, lines.join("\n"), { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new VageError(`${rel} already exists, so ${route} is taken. Pick another name, or edit that file.`);
    throw err;
  }
  return { file: rel, route, draft: true };
}
