<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/agevenkat/vagejs/main/assets/brand/vagejs-logo-dark.svg">
    <img src="https://raw.githubusercontent.com/agevenkat/vagejs/main/assets/brand/vagejs-logo.svg" alt="vagejs" width="320">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/vagejs"><img src="https://img.shields.io/npm/v/vagejs?color=4F46E5&label=npm" alt="npm version"></a>
  <a href="https://github.com/agevenkat/vagejs/actions/workflows/ci.yml"><img src="https://github.com/agevenkat/vagejs/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/vagejs?color=2E2A8C" alt="MIT license"></a>
</p>

# vagejs

**A free static site generator built for AI coding assistants.** Your assistant (Claude Code, Cursor, Codex, Copilot) writes the pages; vagejs checks them before anything goes live. Write pages in Markdown and get a fast static site with SEO, `llms.txt`, accessibility and security handled for you. **Pre-release (0.x).**

[Website](https://vagejs.com) · [Docs](https://vagejs.com/docs/) · [Use with AI assistants](https://vagejs.com/agents/) · [Changelog](https://vagejs.com/changelog/) · [Discussions](https://github.com/agevenkat/vagejs/discussions)

<p align="center"><img src="https://raw.githubusercontent.com/agevenkat/vagejs/main/assets/demo.svg" alt="Terminal demo: create a vagejs site, install it, npm run check catches a broken link and names the file, the link is fixed, the check passes, and npm start runs the site." width="760"></p>

- **Static by default**: plain HTML, no client JavaScript unless you add analytics.
- **SEO built in**: `robots.txt`, `sitemap.xml`, `llms.txt`, canonical URLs, Open Graph and JSON-LD, generated from your pages.
- **Checks before you ship**: `vage check` (links, SEO, structured data, accessibility) and `vage audit` (page-weight budgets, axe, optional Lighthouse and PageSpeed).
- **Safe by default**: page content is sanitized; secrets, build output and force-pushes are refused; Cloudflare deploys get a computed Content-Security-Policy.
- **Agent-friendly**: every site ships with `AGENTS.md`, and `vage info --json` describes every command and config option.
- **Runs everywhere**: macOS, Windows and Linux, tested on every change. Deploys to GitHub Pages and Cloudflare Workers built in; any static host (Vercel, Netlify) works with `npm run build` and the `dist` folder.

## Quick start

Requires **Node.js 22.12 or newer**.

```bash
npm create vagejs@latest my-site
cd my-site
npm install
npm start
```
`npm start` opens the site in your browser. Edit `src/pages/index.md` and the page reloads. (`npm run dev` does the same without opening a browser, and prints the address.)

### Windows

vagejs works on Windows and is tested on Windows on every change.

- **Node.js:** install Node.js **22.12 or newer** before creating a project. Then open a new PowerShell or Command Prompt window and check it with `node --version` and `npm --version`.
- **PowerShell or Command Prompt:** the `npm` and `npx` commands in this README work in both. Command Prompt doesn't treat `#` as a comment, so leave out the `# …` notes shown after some commands.
- **Line endings:** Windows usually saves files with CRLF line endings. vagejs handles them, so there's no need to convert files to LF.
- **HTTP 431 in the browser:** open the direct address (`[::1]` or `127.0.0.1`) that `npm start` and `npm run dev` print. It's the same server, without the cookies other local projects left on `localhost`.

## Using vagejs

### Project layout

```text
my-site/
├── src/
│   ├── pages/          # every .md file is a page
│   │   ├── index.md    # → /
│   │   ├── about.md    # → /about/
│   │   └── blog/
│   │       └── first-post.md   # → /blog/first-post/
│   └── layouts/
│       └── default.ts  # HTML around each page
├── public/             # copied to the site as-is (favicons, images)
├── vage.config.ts      # site settings
└── AGENTS.md           # instructions for AI coding agents
```

### Write a page

```markdown
---
title: Pricing
description: Plans and prices.
---

# Pricing

Our plans start at …
```

Save it as `src/pages/pricing.md` and it's served at `/pricing/`. `title` is required. `description`, `draft`, `noindex`, `canonical`, `image`, `type: article`, `author`, `datePublished` and `dateModified` are optional; see [`templates/starter/AGENTS.md`](templates/starter/AGENTS.md).

Images in `public/` used as `![Alt text](/images/photo.jpg)` get their `width` and `height` from the file, so the page doesn't jump while loading. With `images: { optimize: true }` (and `npm install --save-dev sharp`), vagejs also makes resized WebP copies of images in page content and offers them with `srcset`. Add `avif: true` for AVIF copies too, offered first through `<picture>` (usually smaller; slower to make). `vage audit` counts the copy browsers download, not the original.

### Navigation, feeds and AI extras

- `order:` and `navTitle:` in frontmatter, with `tree()`, `breadcrumbs()` and `neighbors()` in layouts, build sidebars, breadcrumbs and previous/next links.
- `seo: { feeds: [{ under: "/blog/" }] }` writes an RSS feed at `/blog/feed.xml`.
- `seo: { markdownCopies: true }` publishes a Markdown copy of every listed page (`/docs/cli.md`) for AI tools, made from the page's `<main>`, without comments or raw HTML (layouts leave extras out with `data-vage-copy="skip"`); `seo: { lastmod: "git" }` dates the sitemap from git history (CI needs `fetch-depth: 0`).

### Write a layout

Layouts are TypeScript functions. The `html` template tag escapes every value for you; `raw()` inserts trusted HTML such as the rendered page. (Escaping doesn't check URLs, so validate link targets that come from frontmatter.) `pages` lists every published page, and `collection()` picks and sorts them:

```ts
import { collection, html, raw, z, type Layout } from "vagejs";

// Optional: fields this layout accepts. Pages using it are checked strictly, so typos fail the build.
export const frontmatter = z.object({ intro: z.string().optional() });

const layout: Layout = ({ content, page, site, pages }) => html`<!doctype html>
<html lang="${site.lang}">
  <head><title>${page.title}</title></head>
  <body>
    <main>${raw(content)}</main>
    <h2>Latest posts</h2>
    <ul>${collection(pages, { under: "/blog/", sort: "date", limit: 5 }).map((p) => html`<li><a href="${p.route}">${p.title}</a></li>`)}</ul>
  </body>
</html>`;

export default layout;
```

### Everyday commands

| Command | What it does |
| --- | --- |
| `npm start` | Dev server with live reload, opened in your browser |
| `npm run dev` | The same, without opening a browser; prints the address (and a direct `[::1]` or `127.0.0.1` address to use if the browser shows HTTP 431) |
| `npm run check` | Links, SEO, structured data and basic accessibility; writes nothing |
| `npm run build` | Static site in `dist/`, plus `robots.txt`, `sitemap.xml`, `llms.txt` |
| `npm run audit` | Page-weight budgets and automated accessibility (`-- --lighthouse` adds Lighthouse) |
| `npm run preview` | Serves `dist/` locally, the way a static host would |

Add `--json` to `npx vage build`, `check` or `audit` for machine-readable output. Failures exit with code 1.

### Configure the site

`vage.config.ts`:

```ts
import { defineConfig } from "vagejs";

export default defineConfig({
  site: "https://example.com", // your real domain (used for canonical URLs and the sitemap)
  title: "My Website",
  description: "What this site is about.",
  seo: {
    robots: { aiTraining: "disallow" }, // optional: block AI training crawlers, keep search
    llmsTxt: { full: false },
  },
  redirects: { "/old-page/": "/new-page/" },
});
```

Unknown keys are an error, so typos don't silently do nothing. `npx vage info --json` prints the full schema.

### Deploy

```bash
npx vage deploy:github --remote https://github.com/you/site.git   # check, build, safe commit + push (asks first)
npx vage deploy                                                  # GitHub Pages via Actions
npx vage deploy --target cloudflare-workers --project my-site    # Cloudflare Workers: new version, no downtime
npx vage deploy --target cloudflare-pages --project my-site      # older Cloudflare Pages projects
```

Every deploy shows its plan and asks for confirmation (`--dry-run` to preview, `--yes` to skip). It reports success only after the host confirms.

Cloudflare now creates new static sites as Workers, so use `cloudflare-workers` for new projects. For a custom domain, add a `wrangler.jsonc` with your `routes`; vagejs uses it and switches versions without re-attaching domains, so the site stays up during deploys.

### Analytics, Search Console and audits of live pages

Optional, and off until configured: GA4 or Google Tag Manager (consent denied by default), Plausible, Microsoft Clarity, IndexNow. `vage connect gsc|ga4` adds read-only Search Console and GA4 reports, and `vage audit --url https://your-site` runs PageSpeed and CrUX with **your own** Google API key. Details are in the generated `AGENTS.md`.

## Updating

vagejs follows semver. While it's 0.x, a minor version (0.1 → 0.2) may include breaking changes, so read the release notes before moving up a minor version.

```bash
npm outdated vagejs           # see what's available
npm update vagejs             # latest patch in your range (with ^0.3.0: any 0.3.x)
npm install vagejs@latest     # move to the newest version, including a new minor
npx vage --version            # confirm
npx vage check && npx vage build
```

If your config pins the rule pack (`guidelines: { rulePack: "…" }`), a build after an update that ships new provider rules stops with a message. Review them with `npx vage guidelines`, then update the pin. New projects always use the latest version through `npm create vagejs@latest`.

## Use with AI coding agents

Every site includes `AGENTS.md` (conventions, recipes, definition of done) and `CLAUDE.md` (imports `AGENTS.md`). Agents can discover the API instead of guessing:

```bash
npx vage info --json    # commands, options, config and frontmatter JSON Schemas
npx vage check --json   # findings with file, rule and fix hints
```

Or let the assistant call vagejs directly over MCP. `npx vage mcp` runs an MCP server with read-only tools (`vage_info`, `vage_check`, `vage_pages`, `vage_links`); it needs the optional SDK:

```bash
npm install --save-dev @modelcontextprotocol/sdk
claude mcp add --transport stdio --scope project vagejs -- npx -p vagejs vage mcp   # Claude Code, in the project folder
```

Other assistants: `{ "mcpServers": { "vagejs": { "command": "npx", "args": ["-p", "vagejs", "vage", "mcp", "--root", "/absolute/path/to/the/site"] } } }`. `-p vagejs` makes npx run the vagejs installed in the project, and never a different package that happens to be called `vage`. Approving link domains and deploying stay CLI commands for the site owner.

## Command reference

```bash
vage create <dir> [--vage-spec <spec>] [--json]   # scaffold a Markdown site
vage dev      [--root .] [--port N] [--host]      # dev server with live reload
vage build    [--root .] [--json]                 # static build into dist/ (+ robots.txt, sitemap.xml, llms.txt)
vage check    [--root .] [--json] [--strict]      # SEO, links, JSON-LD, basic a11y; writes nothing
vage audit    [--root .] [--lighthouse] [--url U] [--strategy mobile|desktop|both] [--strict] [--json]
                                                  # budgets + axe a11y; optional Lighthouse; PageSpeed/CrUX for deployed URLs
vage preview  [--root .] [--port N] [--host]      # serve dist/ locally
vage deploy:github [--remote URL] [--branch B] [-m MSG] [--dry-run] [--yes] [--json]   # check, build, safe commit + push (asks first)
vage deploy        [--remote URL] [--no-wait] [--dry-run] [--yes] # GitHub Pages via Actions; confirms with GitHub
vage deploy --target cloudflare-workers [--project NAME]          # new Worker version at 100%; custom domains stay up
vage deploy --target cloudflare-pages --project NAME [--branch B] # Wrangler upload; preview URL per branch
vage indexnow --changed-since REF | --urls … | --all              # IndexNow URL notification (asks first)
vage connect gsc|ga4 / vage disconnect google      # read-only Google OAuth (PKCE, loopback); token outside the repo
vage connect pagespeed|crux / vage disconnect …   # save your own Google API key for audit --url (outside the repo)
vage report search|analytics [--days N] [--json]  # Search Console top queries/pages; GA4 top pages
vage guidelines [--json]                          # rule pack: provider facts in use, sources, changelog
vage info     [--json]                            # commands + config/frontmatter JSON Schemas for agents
```

## Planned, not implemented

Bing Webmaster Tools API, Netlify/Vercel adapters, CMS content sources, multi-language sites, base paths, sitemap indexes.

## Security

Page content is sanitized, dev/preview servers serve only what a site needs, and Cloudflare deploys get security headers with a computed Content-Security-Policy. Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

### Protection against spam injection

A static site has no admin panel, database or plugins to break into, so attackers go after your content, your repository or your host instead, usually to plant hidden links and spam pages. vagejs checks for that on every build:

| Protection | What it does |
| --- | --- |
| Outbound link lock | `links.lock.json` lists the domains your site may link to. A link to any other domain fails `vage check` (and so every deploy) until you approve it with `vage links approve <domain>`. It covers links, SVG links, canonical and `og:url`, meta refresh, iframes and forms. With `security.outboundLinks: "require"` (the default for new sites), deleting the file is an error too. |
| No hidden links | Inline styles, SVG `xlink:href` and legacy tags like `<font>` and `<marquee>` are stripped from page content, and `vage check` fails on external links hidden with CSS, `aria-hidden`, zero-size SVG or no visible content, in content and layouts. |
| Spam words | `vage check` warns about common injected-spam terms (casino, pharmacy, payday loans…). |
| Live-site verification | `vage verify` compares the live site with your files: links and other targets, scripts, event handlers, JSON-LD, text (spam words are errors), `robots.txt` and sitemap pages. It also looks at every page as Googlebot, to catch spam shown only to search engines. New sites include a daily GitHub Actions check (opt in with the `VAGE_VERIFY_URL` variable). |
| Supply chain | New sites run `npm audit` in CI and get Dependabot updates. |

```bash
npx vage links                    # list external domains: approved or NEW
npx vage links approve github.com # approve one (asks first)
npx vage verify                   # compare the live site with your files
```

Also protect the accounts around the site: two-factor authentication on GitHub, npm, your host and your domain registrar; branch protection on `main`; and Google Search Console alerts for security issues.

## Contributing

New contributors are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) and the issues labeled [good first issue](https://github.com/agevenkat/vagejs/labels/good%20first%20issue). Questions and ideas go in [Discussions](https://github.com/agevenkat/vagejs/discussions).

```bash
npm install
npm run typecheck
npm test            # unit + integration (dev server, preview, build)
npm run test:e2e    # pack -> create -> npm install/ci -> build (needs npm registry or cache)
```

Design decisions: [docs/DECISIONS.md](docs/DECISIONS.md). Provider rules and how they're monitored: [docs/GUIDELINES.md](docs/GUIDELINES.md). Releasing: [docs/RELEASING.md](docs/RELEASING.md).

## Brand assets

- `assets/brand/vagejs-icon.svg`: the icon, as received (with C2PA content credentials).
- `assets/brand/vagejs-logo.svg` and `vagejs-logo-dark.svg`: the wordmark for light and dark backgrounds, with **Space Grotesk Bold embedded** (a 1.6 KB WOFF2 subset of the glyphs used), so it renders the same without the font installed. Space Grotesk is © 2020 The Space Grotesk Project Authors, under the SIL Open Font License 1.1 (`assets/brand/fonts/OFL.txt`). Editing the file invalidated its C2PA signature, so that block was removed. The dark variant only changes the text colors (`#F4F5FA` and `#A5B4FC`).
- New sites get `favicon.svg`, `favicon.ico` (16/32/48) and `apple-touch-icon.png` (180) in `public/`.

Regenerate (maintainer tools; need Chrome, and Python with `fonttools` and `brotli`):

```bash
node scripts/brand/favicons.mjs templates/starter/public/favicon.svg templates/starter/public
python -I scripts/brand/embed-logo-font.py "SpaceGrotesk[wght].ttf" <original-logo.svg> assets/brand/vagejs-logo.svg
```

## License

MIT © 2026 vagejs.com
