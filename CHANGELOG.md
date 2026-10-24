# Changelog

## Unreleased

### Changed
- Windows setup notes in the README and the starter's `AGENTS.md` (contributed by @chinmayee5599, #7).

## 0.4.0 (2026-10-24)

### Added
- **MCP server.** `vage mcp` runs a Model Context Protocol server over stdio, so AI assistants can call vagejs directly. Four read-only tools: `vage_info` (commands, settings and page fields), `vage_check` (the same findings as `vage check`), `vage_pages` (published pages, drafts and pages that fail to render) and `vage_links` (outbound domains and whether they're approved). Approving link domains and deploying are deliberately not tools. The SDK is optional: install `@modelcontextprotocol/sdk` in the project to use it, and `vage mcp` explains this if it's missing. While it runs, anything the build prints goes to stderr, so stdout carries only the protocol. Set it up with `npx -p vagejs vage mcp`, which always runs the project's vagejs. A tool that fails (an invalid config, a broken layout) returns a readable error and the server keeps running.

- **`vage new page` and `vage new post`.** `vage new page pricing` (or `docs/setup`) and `vage new post "Our first launch"` create a page with valid frontmatter, as a draft so placeholder text can't be published by accident. Posts get `type: article` and today's date; `--author` is written only when given. Never overwrites a page (including one that exists as `folder/index.md`), never writes through a symlinked folder, and takes `--slug` for titles without Latin letters.
- **AVIF images.** `images: { optimize: true, avif: true }` also makes AVIF copies (same widths as the WebP ones) and offers them first through `<picture>`; browsers without AVIF use the WebP `srcset`. The dev server serves the AVIF copies too. The `<picture>` is added on the sanitizer's own output tree, so page content is never parsed twice.

### Fixed
- **`vage audit` counts the images browsers download.** Page-weight budgets used the original image even when vagejs served smaller WebP or AVIF copies. They now count the largest copy a browser would load (AVIF in `<picture>`, else the `srcset`).

### Changed
- The README opens with an animated demo and links to the website, docs and Discussions; `CONTRIBUTING.md`, issue forms and a pull request checklist were added to the repository.

## 0.3.5 (2026-10-24)

Found by deploying a new site for real to Vercel, Cloudflare Workers and GitHub Pages.

### Fixed
- **Cloudflare Workers: the first deploy of a new site works again.** Current wrangler reports a missing Worker as one that "does not yet exist", without an error code, so vagejs stopped instead of creating it.
- **GitHub Pages: no more broken sites in a subfolder.** A `github.io` site published from a repository not named `<owner>.github.io` is served from a subfolder, where every link breaks. `vage deploy` now stops before pushing and explains the two fixes (a custom domain, or an `<owner>.github.io` repository).

### Changed
- When a Workers deploy can't confirm the site address, the message names the Worker's own `workers.dev` address and how to attach a domain.
- The starter's config comments list all AI crawlers (PerplexityBot, Applebot-Extended), and its `AGENTS.md` explains hosting on Vercel, Netlify and other static hosts.

## 0.3.4 (2026-10-24)

Found by running every test on Windows, macOS and Linux, and on the oldest supported Node (22.12.0). CI now tests all of them on every change.

### Fixed
- **Windows: live reload works.** The dev server didn't reload the browser after an edit on Windows, because it compared file paths in different forms (`C:/…` with long folder names against `C:\…` with short ones).
- **Windows: sitemap dates from git.** With `seo.lastmod: "git"`, dates could be silently missing when the project path used short folder names or a different drive-letter case. git now reports paths relative to the project.

### Added
- A test that a site saved with Windows line endings (CRLF) builds exactly the same as one saved with LF.

## 0.3.3 (2026-10-24)

### Changed
- After creating a site, the next steps say `npm start` (opens the browser) instead of `npm run dev`.

## 0.3.2 (2026-10-24)

### Added
- `vage dev` and `vage preview` also print the address the server really listens on (`http://[::1]:5173/` or `http://127.0.0.1:5173/`). Browsers keep cookies per host name, so it avoids the HTTP 431 error that piles of `localhost` cookies from other projects cause.
- `--open` on `vage dev` and `vage preview` opens the site in your default browser at that address. New sites get `npm start` (`vage dev --open`); `npm run dev` still doesn't open a browser, so AI assistants can run it.

### Fixed
- Command-line mistakes (an unknown option, or a list passed as separate values like `--urls /a/ /b/`) print a short message with the right `--help` command instead of a stack trace.

### Changed
- npm description and keywords say "static site generator"; the `vite` keyword is gone, so searches for Vite don't list vagejs.

## 0.3.1 (2026-10-24)

Fixes from an SEO audit of [vagejs.com](https://vagejs.com).

### Fixed
- **Markdown copies and `llms-full.txt` now include content a layout builds.** They were made from the Markdown body only, so pages whose content lives in frontmatter (an FAQ list, a home page, a blog index) produced almost empty copies. They're now made from the page's single `<main>` element (pages without exactly one `<main>` still use the Markdown body). A heading split with `<br>` stays one heading.

### Added
- `data-vage-copy="skip"` on any element in a layout leaves it out of the Markdown copy and `llms-full.txt`, for repeated extras such as share links, author cards or a call to action.
- On Cloudflare targets, `_headers` gives each Markdown copy a `Link: <page URL>; rel="canonical"` header, so search engines treat the HTML page as the original. Skipped with a warning when the copies would push `_headers` past Cloudflare's 100-rule limit.

### Changed
- Rule pack 2026.10.2 (reviewed by Venkatesh A G E): `aiSearch` now also covers **PerplexityBot**, and `aiTraining` also covers **Applebot-Extended**, from each provider's own documentation. Sites that set these options get the new groups in `robots.txt`. Google-Extended stays under training; the docs now say it also controls grounding in Gemini Apps and Vertex AI. The rule pack also records Cloudflare's 100-rule `_headers` limit. Projects that pin `guidelines.rulePack: "2026.10.1"` need to review and update the pin.

## 0.3.0 (2026-10-23)

### Added
- **Image pipeline (opt-in).** `images: { optimize: true }` with `sharp` installed makes resized WebP copies of images in page content (default widths 480, 960, 1600; never upscaled), caches them in `node_modules/.cache/vagejs`, publishes them under `/_vage/img/` and offers them with `srcset`/`sizes`. Set inside the sanitizer, like the width/height hints.
- **Crawlability check in `vage verify`.** Fetches the site as Googlebot, Bingbot, OAI-SearchBot, GPTBot, ChatGPT-User, Claude-SearchBot, ClaudeBot, Claude-User, PerplexityBot and Perplexity-User (rule pack `crawlers.probes`) and reports blocks and challenges, robots.txt rules, `X-Robots-Tag: noindex`, and missing http→https and www redirects. `--no-crawlers` skips it. A user-agent probe can't detect blocks based on the real crawlers' IP addresses.
- **CDN-injected scripts.** `vage verify` warns about scripts your host or CDN adds to pages (such as Cloudflare Web Analytics), which your security policy may block.
- **Navigation from frontmatter.** `order` and `navTitle` fields; `PageSummary.label`; `collection(…, { sort: "order" })`; `tree()`, `breadcrumbs()` and `neighbors()` helpers.
- **RSS feeds.** `seo.feeds: [{ under: "/blog/" }]` writes `/blog/feed.xml` and links it from the section's pages.
- **Markdown copies.** `seo.markdownCopies: true` publishes `/<path>.md` copies of listed pages, linked with `rel="alternate" type="text/markdown"`; `llms.txt` then links to them. Copies (and `llms-full.txt`) are converted from each page's sanitized HTML (with `turndown`), so they contain exactly what the page shows: no HTML comments, scripts or links the link lock didn't see, and absolute links.
- **`flatten()`** puts a `tree()` in sidebar order, for previous/next links in nested docs.
- **Sitemap dates from git.** `seo.lastmod: "git"` takes `<lastmod>` from each page's last commit (`dateModified` still wins). Skipped with a warning in shallow clones, where every page would get the latest commit's date.

### Changed
- Rule pack 2026.10.1 adds `crawlers.probes` and the Perplexity source; no existing rule changed. Projects that pin `guidelines.rulePack: "2026.10.0"` need to review and update the pin.
- `vage verify` fetches pages with browser-like headers, so it sees what visitors get. It also checks the live feed, Markdown copies and optimized images, and reports how many crawlers it probed.
- `llms-full.txt` is now converted from each page's sanitized HTML, so it no longer includes HTML comments or raw HTML from the Markdown source.
- New dependency: `turndown` (HTML to Markdown, MIT).
- Generated GitHub workflows check out full git history (`fetch-depth: 0`).
- Image sizes respect JPEG EXIF orientation.

### Not yet
- AVIF images and `<picture>`.

## 0.2.0 (2026-10-23)

Fixes found by building [vagejs.com](https://vagejs.com) with vagejs.

### Added
- **Lists of pages in layouts.** Layouts receive `pages` (every published page: route, url, title, description, frontmatter; read-only, with layout defaults applied), and `collection(pages, { under, sort, limit })` picks a section and orders it (`"date"`, `"title"`, `"route"` or your own function). Blog indexes and sidebars no longer need hand-kept lists.
- **`html` template tag** with automatic escaping, plus `raw()` for trusted markup such as `content`. Arrays are joined; `null`, `undefined` and `false` render nothing. Plain template strings still work.
- **Layout field schemas.** A layout can `export const frontmatter = z.object({ ... })` (`z` is re-exported from `vagejs`). Pages using it are validated strictly: unknown or mistyped fields fail the build, naming the file. Defaults are filled in, for the page and in `pages`. A schema may also declare built-in fields (e.g. require `author`). Drafts are skipped before validation.
- **New checks.** `frontmatter-empty` (warning): a frontmatter value came out empty, such as text split by a comma inside `{ }`. `page-error` (error): a page that fails to render is reported with its file, and the other pages are still checked. `redirect-target` (error): a redirect points to a path that doesn't exist.
- **Image dimensions.** Markdown images from `public/` get `width` and `height` read from the file (PNG, JPEG, GIF, WebP, SVG), `decoding="async"`, and `loading="lazy"` after the first image. This happens inside the sanitizer, on the DOM.
- **Cloudflare Workers target.** `deploy.target: "cloudflare-workers"` (and `deploy.cloudflareWorker`) uploads a new version and switches all traffic to it, so custom domains stay up; a new Worker gets a first `wrangler deploy`. A project `wrangler.jsonc`/`.toml` is used when present; the plan shows its real Worker name, and the deploy refuses if that name differs from the requested one or if it doesn't serve `dist/`. Generated configs serve your 404 page (`not_found_handling: "404-page"`). Success is verified on the live site, never on a version preview URL. `_headers` and `_redirects` are written for both Cloudflare targets.

- **Protection against spam injection.** Outbound links must be approved in `links.lock.json` (`vage links`, `vage links approve <domain>`); a link to an unapproved domain fails `vage check` and so every deploy (`link-unapproved`). Inline `style` attributes are stripped from page content (`markdown.inlineStyles` to keep them). `vage check` fails on links hidden with CSS or `hidden` (`link-hidden`) and warns about spam vocabulary (`spam-pattern`, `security.spamPatterns`). `vage verify` compares the live site with your files (link targets, scripts, event handlers, JSON-LD, text, robots.txt, sitemap pages), also as Googlebot to catch cloaking, and ignores Cloudflare's own scripts. The lock also covers SVG links, canonical/og:url, meta refresh, iframes and forms; `security.outboundLinks: "require"` (new sites) makes a missing lock file an error. `<font>`, `<marquee>`, `<center>` and SVG `xlink:href` are removed from content.
- **Starter supply-chain and monitoring.** New sites ship an empty `links.lock.json`, run `npm audit` in CI, get Dependabot updates, and include an opt-in daily `vage verify` workflow.

### Changed
- The name is written **vagejs** everywhere (CLI output, docs, templates).
- The starter's default layout uses `html` and `raw(content)`, and the starter has a `/blog/` index built with `collection()`.
- `vage info --json` describes the layout API (props, `html`/`raw`, `collection`, field schemas) and the new checks.
- The Cloudflare Pages target explains Cloudflare's move of new projects to Workers when a deploy fails for that reason.
- Rule pack 2026.10.0: reviewer name written as "Venkatesh A G E". No rules or sources changed, so the pack version (and existing pins) stay the same.

### Not yet
- Image resizing and WebP/AVIF conversion.

## 0.1.0 (2026-10-23)

First release.
