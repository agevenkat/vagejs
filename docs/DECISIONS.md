# Architecture decisions

Phase 0 record. Dates are 2026-10-23 unless noted.

## Confirmed by the owner

| Decision | Choice |
| --- | --- |
| Dev server / module loading | Vite 8 |
| License | MIT |
| Node floor | `>=22.12.0` (owner chose "Node 22+"; 22.12 is Vite 8's minimum) |
| Version control | Local `git init`, no remote |

## Naming status (not reserved, not published)

`npm view` on 2026-10-23 returned 404 (no published package) for `vagejs`, `vage`, `create-vagejs`, `@vagejs/core`.
A 404 only means nothing is published under that name right now. Trademark, GitHub org and domain
checks have **not** been done. `"private": true` was removed when preparing the release (2026-10-23); publishing still needs the owner's npm login and 2FA. Re-checked that day: `vagejs`, `create-vagejs`, `vage` and `@vagejs/cli` were all unclaimed.
Brand (vagejs), npm name (`vagejs`), CLI (`vage`), repo name and domain remain separate decisions.

## Implementation choices (Phase 1)

- **Single package**, with spec module boundaries as folders: `src/cli`, `src/core`, `src/content`, `src/dev`. Split into a monorepo only if it earns its overhead.
- **Config file is `vage.config.ts`** (spec placeholder was `framework.config.ts`). Validated with Zod as a strict object, so unknown keys fail instead of being silently ignored. Phase 1 keys: `site`, `title`, `description`, `lang`.
- **Routes**: `src/pages/**/*.md` → trailing-slash routes (`about.md` → `/about/` → `dist/about/index.html`). `_`-prefixed files/folders are ignored. Route collisions are build errors. `404.md` → `dist/404.html`.
- **Trailing slashes**: dev and preview both 301-redirect `/about` → `/about/`, matching most static hosts.
- **Frontmatter**: YAML; `title` required (no generated titles), `description`, `draft`, `layout` optional; extra keys pass through to layouts.
- **Layouts are plain TypeScript functions** `({ content, page, site }) => string` in `src/layouts/<name>.ts`, loaded through Vite's SSR loader. No custom template language or component syntax yet. A built-in default layout is used when `src/layouts/default.ts` is absent.
- **Markdown**: `marked` (GFM). Raw HTML in content is **sanitized by default** (DOMPurify); see the security review below.
- **Zero client JS in build output.** The dev server injects only Vite's client for live reload.
- **Live reload, not HMR**: any change under `src/` or to the config sends a full page reload. Pages are re-rendered per request, so new pages need no restart.
- **Builds are atomic-ish**: all pages render before `dist/` is replaced, so a failing build leaves the last good output.
- **Unpublished install path**: `vage create --vage-spec file:<tarball>` lets a generated project install the local package until a real release exists.

## Phase 2: discovery and SEO

- **One site model** (`src/core/site.ts`) renders all pages, then derives sitemap.xml, llms.txt and robots.txt from it. Build, dev server and `check` all use it, so the files cannot drift from the routes.
- **Head tags are injected** before `</head>` rather than requiring layouts to call a helper. Any tag the layout already writes is left alone, so no duplicates and no silent overrides.
- **Nothing invented**: tags and JSON-LD fields appear only when backed by config or frontmatter. No auto breadcrumbs (they would have to match visible UI). No `lastmod` from file mtimes.
- **robots.txt** is neutral by default (`User-agent: *` / `Disallow:`). AI groups are opt-in and split into training vs search, using tokens from provider docs recorded in `src/discovery/crawlers.ts` (verified 2026-10-23). User-initiated fetchers (ChatGPT-User, Claude-User) are excluded because the providers say robots.txt may not apply to them.
- **Hand-written `public/robots.txt` etc. is an error**, not silently overwritten.
- **Redirects** are static meta-refresh pages (noindex, canonical to target). Static hosts need host-specific config for real 301s; that belongs to deploy adapters (Phase 5).
- **`site` must be an origin.** Base paths are rejected until links and assets support them.
- **`vage check`** renders in memory (no `dist/` writes). Errors exit 1; `--strict` also fails on warnings. Each rule links official docs where one exists.
- **HTML inspection** uses `node-html-parser`, not regex.

### Phase 2 limitations

- No sitemap index; more than 50,000 URLs is an explicit error.
- No hreflang/alternate-language links yet.
- Accessibility checks are basic (lang, alt, link text, image dimensions); full automated testing is Phase 4.

## Phase 3: AI-agent support

- **`vage info --json`** is generated from the live cac command list and the Zod schemas (`z.toJSONSchema`), so it cannot drift. Field docs live in `.describe()` on the schemas.
- **Generated projects** get `AGENTS.md` (agent-neutral) and a one-line `CLAUDE.md` that imports it, so the guidance stays agent-neutral.
- **Agent workflow test** (`tests/e2e.test.ts`): discover via `info`, add a page, hit a broken link, fix it from the `check` finding, build. This is a scripted simulation of an agent, not an LLM in the loop.
- **MCP (0.4.0)**: `vage mcp` exposes read-only tools (`vage_info`, `vage_check`, `vage_pages`, `vage_links`) over stdio. Approving links and deploying stay CLI-only, so a person decides them. The SDK is an optional dependency (like `sharp`), so sites that don't use MCP don't install its web-server dependencies. Docs use `npx -p vagejs vage` so npx runs the project's vagejs and can never resolve an unrelated `vage` package. stdout carries the protocol, so `console.log` moves to stderr; a layout writing to `process.stdout` directly would still corrupt it.

## Phase 4: performance and accessibility

- **`vage audit`** builds, measures every page (HTML + referenced local JS/CSS/images/fonts, including fonts/images from CSS `url()`), and runs axe-core in jsdom. Sizes are uncompressed; transfer size depends on the host.
- **Severity**: axe critical/serious = error; moderate/minor, budget misses and lab scores = warning. `--strict` fails on warnings. External API failures are warnings unless `--strict`, so outages and noisy lab runs don't block builds by default.
- **jsdom 28, not 30**: jsdom 29 and 30 require Node ≥22.13 / ≥22.22.2; 28 matches our `>=22.12` floor. Revisit when the floor rises. Layout-dependent axe rules (color contrast etc.) can't be decided in jsdom and are reported as "needs review", not as passes.
- **Lighthouse is an optional peer dependency** (~19 MB, needs Chrome), loaded from the user's project only with `--lighthouse` / `performance.lighthouse.enabled`. It audits the local preview server.
- **Deployed URLs**: PageSpeed Insights v5 for lab data; **CrUX API for field data**, because Google's PSI docs (checked 2026-10-23) say CrUX field data in PSI is planned for discontinuation. Field metrics: LCP, INP, CLS at p75, rated with web.dev thresholds (2.5 s / 200 ms / 0.1). URL-level data falls back to origin-level.
- **API keys are always the user's own** (owner decision, 2026-10-23). They are resolved from env (`PAGESPEED_API_KEY`, `CRUX_API_KEY`), then from a key saved with `vage connect pagespeed|crux` (OS user config dir, mode 0600, never in the project), then from an interactive hidden prompt during `vage audit --url`. vagejs ships no key, and **PageSpeed is never called keyless**: without a key the audit fails with setup steps instead of using Google's shared anonymous quota. CrUX falls back to the PageSpeed key, since one Google Cloud key can enable both APIs. Keys are sent as the `x-goog-api-key` header (never in URLs) and redacted from all error text. Retries: 3 attempts, 1 s / 2 s backoff on 429/5xx/network errors.
- **The audit module is lazy-loaded** by the CLI, so jsdom doesn't slow other commands.

### Phase 4 verification status

- Local Lighthouse: verified with a real run (Lighthouse 13.5.0, Chrome, 2026-10-23); CI runs it on Ubuntu.
- PageSpeed Insights live: the keyless call hit Google's shared daily quota (HTTP 429), which verified the error path only. The success path, the CrUX API and header-based key auth are tested against mocks of the documented response shapes, not live. Verify with a real key before relying on them.
- CrUX "no data" is assumed to be HTTP 404 (not specified in the docs).

## Phase 5: GitHub and deployment

- **First hosting adapter: GitHub Pages via Actions.** It needs no extra hosting account or credentials, deploys from CI only after `vage check` + `vage build` pass, and uses the `github-pages` environment for protection rules. Constraint: vagejs has no base-path support, so it needs a custom domain or a `<user>.github.io` repo. Per GitHub's docs, Actions-based deploys ignore and don't need a `CNAME` file.
- **Action versions** are pinned to the latest majors as of 2026-10-23 (checkout v7, setup-node v7, configure-pages v6, upload-pages-artifact v5, deploy-pages v5, upload-artifact v7). GitHub's docs page still shows older majors; release notes showed no breaking input changes for our usage.
- **`vage deploy:github`** (Git CLI, no API tokens): check + build, plan (files honoring .gitignore, computed with a throwaway git dir for new repos so nothing is touched), confirmation (TTY prompt, `--yes`, or `--dry-run`; non-TTY without `--yes` refuses), commit, push without force, then `git ls-remote` to confirm the remote head equals our commit.
- **Guards**: refuses files that look like secrets (by name and well-known token formats; values are never printed), `dist/` and `node_modules/`; re-verifies the staged set against the shown plan; won't change an existing origin or switch branches; rejected pushes keep the local commit and explain `git pull --rebase`.
- **`vage deploy`** adds `.github/workflows/deploy.yml` if missing (never overwrites), publishes, enables Pages (`build_type=workflow`) through `gh` when needed, and waits for the run with `gh run watch`. It reports success only when GitHub reports the run succeeded; without `gh`, or with `--no-wait`, the result is "unconfirmed".
- **Previews**: GitHub Pages has no per-PR preview deployments. The starter CI uploads `dist/` as a downloadable artifact instead. Real preview URLs need another adapter (Cloudflare Pages / Netlify), planned for Phase 8.

### Phase 5 verification status

- Git flow: tested end to end against local bare repos (new repo, declined plan, no remote, rejected push, secrets, ignored output, origin/branch guards).
- GitHub Pages: workflow generation is unit-tested, and the `gh` interactions are tested with a fake runner. **Not run against GitHub**: that requires pushing to a real repository, which needs the owner's explicit approval.

## Phase 6: GA4, Tag Manager and Search Console

- **Tags only in production output** (build, check, preview), never in the dev server. The inline loader also skips `localhost`/`127.0.0.1`/`[::1]`, so `vage preview` sends no hits.
- **Consent mode**: `gtag("consent","default", …)` runs before `config`/`event`, as Google requires (docs checked 2026-10-23). The default is `denied` for all four types (ad_storage, ad_user_data, ad_personalization, analytics_storage). vagejs ships no consent banner; sites call `window.vageConsent.update(...)` from their own UI. Whether denied-by-default with tags loaded meets a site's legal obligations is the owner's call; it is not legal advice.
- **No duplicates**: GA4 direct + GTM together is a config error; `check` errors when a page loads Google tag scripts more than once.
- **Typed events without client bundling**: events and their params are declared in config, validated with GA4 naming rules (start with a letter; letters/digits/underscores; 40 chars; reserved param prefixes; sources in `config.ts`), used via `data-vage-event` / `data-vage-param-*`, and enforced by `vage check`.
- **OAuth**: Desktop-app flow with loopback redirect on 127.0.0.1, PKCE S256 and a `state` check, per Google's native-app guide. Read-only scopes (`webmasters.readonly`, `analytics.readonly`), requested incrementally (connecting GA4 keeps GSC). The refresh token and client credentials are stored in the OS user config dir (`$VAGE_CONFIG_DIR` overrides) with mode 0600, never in the project. `disconnect` revokes at Google, then deletes locally even if revocation fails, and says so.
- **Reports**: Search Console Search Analytics (top 25 queries and pages, Pacific Time dates, finalized data) and GA4 Data API `runReport` (top 25 pages by views). The CLI states that the APIs don't expose every UI report.
- **Errors** never include tokens or secrets (central redaction in `src/integrations/http.ts`, shared with audits).

### Phase 6 verification status

- Tag output, consent ordering, event checks, and the OAuth flow (a real loopback server with a simulated browser redirect) are tested; Google's token, revoke, Search Console and GA4 endpoints are mocked using their documented shapes. **Not run against real Google accounts**: that needs your OAuth client and consent.

## Phase 7: guideline monitoring

See `docs/GUIDELINES.md` for the process.

- **The rule pack is the single source for provider facts**: crawler tokens, CWV thresholds, GA4 limits, consent types and the sitemap limit are read from `src/guidelines/rule-pack.json` at runtime, each with source links. Integrity tests require registered sources, existing `implementedIn` files, and a changelog entry whose `contentHash` matches. Any data change without a version bump and a named `reviewedBy` fails CI.
- **Golden-output tests** (`tests/golden/basic`) make any change to generated robots/sitemap/llms/HTML visible in review.
- **Pinning**: `guidelines.rulePack` turns a rule-pack change into an explicit, owner-reviewed step per project.
- **Snapshots keep headings and hashes only**, not page text, to avoid storing copyrighted documents; reports link to the live pages.
- **The LLM is a drafting aid**: the official Anthropic SDK (`@anthropic-ai/sdk`, devDependency only, maintainer script only), `claude-opus-5-5` with structured output via `betaZodOutputFormat`, effort `low` (a classification route), and **server-side refusal fallback enabled** (`fallbacks: "default"`). Refusals or unparsable output become "unclear". Sections over 20,000 characters are truncated and flagged as such.
- **Monitor robustness, found on the first live run (2026-10-23)**: Google served random localized pages without `Accept-Language` (now sent as English); Google's common-crawlers doc had moved to `/crawling/docs/crawlers-fetchers/…` (registry updated); Bing's guidelines page is client-rendered with no readable text (marked `monitor: manual`; empty pages are reported as "unreadable", never silently accepted). A second full run reported zero changes.
- **The initial pack (2026.10.0) was reviewed and signed off by the owner (Venkatesh A G E) on 2026-10-23**, after its facts were checked against the cited sources during implementation. Every later version needs a named reviewer.

## Phase 8: additional integrations (scoped to real gaps)

The spec says "based on demand" and warns against scope creep, so this phase adds only what fills a known gap and can be tested without the owner's accounts:

- **Cloudflare Pages adapter**: fills Phase 5's missing per-branch preview URLs and gives real 301s via `_redirects` (written only for this target, up to 2,000 rules; meta-refresh pages stay as a fallback). It uses a pinned `wrangler@4.152.0` through `npx` (not a dependency). Success requires Wrangler to succeed *and* the deployment URL to answer 200. Tokens are redacted from output.
- **IndexNow**: key file generated from config (8-128 letters/digits/dashes); `vage indexnow` submits changed pages (`--changed-since <git ref>`, mapped through the same routing rules, deleted pages included), given URLs, or all listed pages. It checks that the key file is live before submitting, accepts 200/202, and **does not retry 429** (the docs warn this can be treated as spam). Default endpoint is the shared `api.indexnow.org` from the IndexNow FAQ; per-engine endpoints can be configured.
- **Plausible and Clarity**: both providers tell site owners to copy a site-specific snippet from their dashboards, so config takes that snippet verbatim (validated as a `<script>`, with Google tags rejected) instead of vagejs guessing a format. `window.vageConsent.update()` forwards consent to Google and to Clarity's documented `consentv2` API. Events go to every configured provider; `check` requires each to declare them. Plausible events use the documented `plausible(name, { props })`.
- **The generated consent/event script is tested by executing it** in jsdom with provider stubs, not just by string matching.
- **The rule pack gained** `indexnow.protocol`, `clarity.consent`, `plausible.events` and `cloudflare.redirects`. Pack 2026.10.0 was still unreleased and unreviewed, so it was extended in place (changelog entry updated) rather than issuing a version nobody had reviewed.

### Deliberately not built

- **Bing Webmaster Tools API**: IndexNow covers URL submission to Bing; reporting needs a Bing API key and a concrete need.
- **Netlify / Vercel**: one extra static host covers previews; add more on demand.
- **CMS / content-source adapters**: no concrete source to target yet.

### Phase 8 verification status

- Snippet injection, consent forwarding, event dispatch, `_redirects`, the key file and all error paths are tested locally. **Not run against live services**: Cloudflare (needs your account), IndexNow (needs a deployed site with the key file), Plausible and Clarity (need your snippets).

## Security review (2026-10-23)

Trust model: the owner's config and layouts are trusted code. Page content (Markdown/frontmatter) may come from AI agents, contributors or future CMS sources. Dev/preview servers may be reachable over the network (`--host`). CLI arguments may be relayed by agents. Fetched remote text is untrusted. An independent review plus our own found 18 issues; all are fixed, with a regression test each in `tests/security.test.ts`. `npm audit`: 0 known vulnerabilities.

| Issue | Fix |
|---|---|
| Stored XSS: `<script>`, `on*=`, `javascript:` links, iframes, forms from content reached built pages | Content sanitized with DOMPurify by default (forms, iframes, meta/base/style also removed; `data-*` kept). Opt out: `markdown: { html: "allow" }`. `check` errors on script URLs anywhere |
| Dev server served `package.json`, config, page sources, layouts, `.dev.vars`, `/@fs/` paths, `?raw` (LAN-exposed with `--host`) | Access guard runs before Vite: only rendered pages, discovery files, `public/` files and Vite's reload client |
| `vage indexnow --changed-since=--output=<file>` truncated arbitrary files via git option injection | Ref resolved with `git rev-parse --verify --end-of-options` to a SHA; leading `-` refused |
| Symlinks in `public/` copied into `dist/` (exposing e.g. `../.env`, `/etc/hosts`) | Build refuses symlinks in `public/` |
| Secret files in `public/` would be published | Build refuses secret-looking files in `public/` (Google browser keys only warn) |
| Preview open redirect (`//evil.example/...`) and file-existence oracle; stack traces on bad `%` | Paths resolved inside `dist/` only; redirects rebuilt from the normalized path; 400 on undecodable URLs |
| `llms.txt` line/link injection via titles | Titles, descriptions and authors must be single-line; Markdown link syntax escaped |
| Canonical hijack via `//evil` / script `og:image` | `canonical`/`image` must be a single-`/` site path or http(s) URL; `check` warns on cross-site canonicals |
| Malformed links crashed `check` / `audit` | Reported as `link-broken`; decoding guarded |
| Redirect keys could write outside `dist/`; `javascript:` targets; robots.txt line injection | Config validation (no `.`/`..` segments, safe targets, no whitespace/line breaks) and a write guard in the build |
| Secret scanner missed `.dev.vars`, `.envrc`, Google OAuth secrets/refresh tokens, vagejs credential files; >1 MB files skipped silently | Patterns added; large text files flagged for manual review; starter `.gitignore` covers `.dev.vars`/`.envrc` |
| Monitor: fetched headings and LLM output pasted raw into GitHub issues; page text could close prompt tags | Rendered as inert inline code; data tags stripped from page text; heading moved inside the data tags |
| Windows browser opening via `cmd /c start` (`&` splits commands) | `rundll32 url.dll,FileProtocolHandler`, no shell |
| Unvalidated `--project`, `--branch`, `--remote`, `--vage-spec` reaching wrangler/git/npm | Validators refuse leading `-`, `ext::`/`fd::` remotes and non-version specs; `--` separators for git |

### Security headers and reporting

- **`_headers` for Cloudflare Pages** (also read by Netlify): `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: SAMEORIGIN`, a restrictive `Permissions-Policy`, and a **Content-Security-Policy computed from the built pages**. It includes sha256 hashes of every inline script and `<style>` (JSON-LD excluded, since it isn't executed), the external origins that layouts load (scripts, stylesheets, iframes), the documented domains of configured analytics (rule pack `csp.providers`: Google's CSP guide for GA4/GTM without Ads features, Clarity's CSP doc; Plausible's origin from its snippet), plus `security.cspSources`. Scripts are strict; images, fonts and media may load from any https origin to avoid breaking ordinary sites. `object-src 'none'`, `base-uri`/`form-action`/`frame-ancestors 'self'`, `upgrade-insecure-requests`.
- **Verified in real Chrome** (Lighthouse 13.5 harness, 2026-10-23) on a starter site with GA4 and the generated header: 0 console/CSP errors on clean pages; an injected inline `<script>` and an `onerror` handler were both blocked.
- Modes: `security.csp: "enforce" | "report-only" | "off"`; `security.headers: false` writes no file. GitHub Pages can't set headers, so nothing is emitted there (a `<meta>` CSP could be a follow-up). Tag Manager containers that inject custom scripts need those origins in `security.cspSources` or `report-only`.
- `check` warns about inline event handlers (`onclick=` etc.) that an enforced CSP would block.
- **`SECURITY.md`**: private reporting through GitHub's "Report a vulnerability" (enable private vulnerability reporting in the repository settings). No email address yet; add one at vagejs.com when it exists.

Still by design (documented): `vage.config.ts`, layouts and the optional Lighthouse package run as code. Only run `vage` commands on projects you trust, as with any build tool.

## Release setup

- Two packages: `vagejs` (framework and CLI) and `create-vagejs` (`npm create vagejs`, which delegates to `vage create` so there is one scaffolder; pinned to the same version).
- `prepublishOnly` runs typecheck, all tests and the end-to-end tests (which pack and install both tarballs, as users will). The e2e tests clear the `npm_config_dry_run` npm passes to child processes, so `npm publish --dry-run` is a faithful rehearsal.
- Releases after the first use npm trusted publishing from `.github/workflows/release.yml` (OIDC: no stored token; provenance automatic), behind a GitHub environment with required reviewers. The first publish is manual, because trusted publishing is configured on an existing package. See `docs/RELEASING.md`.

## Not implemented

Bing Webmaster Tools API, Netlify/Vercel, CMS content sources, hreflang/multi-language, base paths, sitemap indexes.
