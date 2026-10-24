#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { cac } from "cac";
import { check, type Finding } from "../checks/check.js";
import { build } from "../core/build.js";
import { VageError } from "../core/errors.js";
import { assertBranchName, assertCloudflareProject, assertVageSpec, assertWorkerName } from "../core/validate.js";
import { startDevServer } from "../dev/server.js";
import { startPreviewServer } from "../dev/preview.js";
import { directUrl, printUrls } from "../dev/listen.js";
import { createInterface } from "node:readline/promises";
import { createProject } from "./create.js";
import { frameworkInfo } from "./info.js";

const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };
const cli = cac("vage");

interface CommonOptions {
  root: string;
  json?: boolean;
}
interface ServeFlags extends CommonOptions {
  port?: number;
  host?: string | boolean;
  open?: boolean;
}

cli
  .command("create <dir>", "Scaffold a new vagejs website")
  .option("--vage-spec <spec>", "Dependency spec for vagejs in the new package.json", { default: `^${version}` })
  .option("--json", "Print machine-readable JSON")
  .action((dir: string, opts: { vageSpec: string; json?: boolean }) =>
    run(opts, () => {
      const result = createProject(dir, assertVageSpec(opts.vageSpec));
      if (opts.json) return print({ ok: true, ...result });
      const rel = path.relative(process.cwd(), result.dir) || ".";
      console.log(`Created ${result.dir}\n\nNext steps:\n  cd ${rel}\n  npm install\n  npm start\n\nnpm start opens the site in your browser. npm run dev starts it without opening one.`);
    }),
  );

cli
  .command("dev", "Start the dev server with live reload")
  .option("--root <dir>", "Project root", { default: "." })
  .option("--port <port>", "Port (fails if taken; default picks a free port from 5173)")
  .option("--host [host]", "Expose on the network")
  .option("--open", "Open the site in your browser (at the direct address, so localhost cookies can't cause HTTP 431)")
  .action((opts: ServeFlags) =>
    run(opts, async () => {
      const server = await startDevServer(opts.root, { port: parsePort(opts.port), host: opts.host });
      const direct = directUrl(server.httpServer?.address());
      printUrls("vagejs dev server", server.resolvedUrls?.local[0], direct, server.resolvedUrls?.network);
      const target = direct ?? server.resolvedUrls?.local[0] ?? server.resolvedUrls?.network[0];
      if (opts.open && target) openBrowser(target);
    }),
  );

cli
  .command("build", "Build the static site into dist/")
  .option("--root <dir>", "Project root", { default: "." })
  .option("--json", "Print machine-readable JSON")
  .action((opts: CommonOptions) =>
    run(opts, async () => {
      const result = await build(opts.root);
      if (opts.json) return print({ ok: true, ...result });
      for (const page of result.pages) console.log(`  ${page.route.padEnd(30)} -> ${page.output}`);
      for (const r of result.redirects) console.log(`  ${r.from.padEnd(30)} -> ${r.output} (redirect to ${r.to})`);
      for (const file of result.files) console.log(`  ${"".padEnd(30)} -> ${file}`);
      for (const draft of result.skippedDrafts) console.log(`  (draft, skipped) ${draft}`);
      for (const warning of result.warnings) console.log(`\nWarning: ${warning}`);
      console.log(`\nBuilt ${result.pages.length} page(s) into ${result.outDir} in ${result.durationMs}ms`);
    }),
  );

cli
  .command("check", "Check SEO, links, structured data and basic accessibility (writes nothing)")
  .option("--root <dir>", "Project root", { default: "." })
  .option("--strict", "Fail on warnings too")
  .option("--json", "Print machine-readable JSON")
  .action((opts: CommonOptions & { strict?: boolean }) =>
    run(opts, async () => {
      const result = await check(opts.root, { strict: opts.strict });
      if (opts.json) print(result);
      else {
        printFindings(result.findings);
        console.log(`\nChecked ${result.pagesChecked} page(s): ${result.errors} error(s), ${result.warnings} warning(s).`);
        console.log("Passing checks do not guarantee indexing, rankings, rich results or AI citations.");
      }
      if (!result.ok) process.exit(1);
    }),
  );

cli
  .command("audit", "Performance budgets and accessibility (local build), or PageSpeed/CrUX for a deployed --url")
  .option("--root <dir>", "Project root", { default: "." })
  .option("--url <url>", "Audit a deployed URL with PageSpeed Insights (+ CrUX field data with CRUX_API_KEY)")
  .option("--lighthouse", "Also run Lighthouse locally (needs the lighthouse package and Chrome)")
  .option("--strategy <strategy>", "mobile, desktop or both", { default: "both" })
  .option("--strict", "Fail on warnings too (budgets, lab scores, API failures)")
  .option("--json", "Print machine-readable JSON")
  .action((opts: CommonOptions & { url?: string; lighthouse?: boolean; strategy: string; strict?: boolean }) =>
    run(opts, async () => {
      if (!["mobile", "desktop", "both"].includes(opts.strategy)) {
        throw new VageError(`Invalid --strategy "${opts.strategy}". Use mobile, desktop or both.`);
      }
      const strategies = opts.strategy === "both" ? (["mobile", "desktop"] as const) : ([opts.strategy] as ["mobile"] | ["desktop"]);
      // Loaded lazily: jsdom and axe are only needed for audits.
      const { audit } = await import("../audit/audit.js");
      const { kbText } = await import("../audit/budgets.js");
      const interactive = Boolean(process.stdin.isTTY && !opts.json);
      const result = await audit(opts.root, {
        url: opts.url,
        lighthouse: opts.lighthouse,
        strict: opts.strict,
        strategies: [...strategies],
        askForKey: interactive ? askForApiKey : undefined,
      });
      if (opts.json) print(result);
      else {
        for (const p of result.pages) {
          const b = p.bytes;
          console.log(`  ${p.route.padEnd(28)} total ${kbText(p.total).padStart(9)}  js ${kbText(b.javascript)}  css ${kbText(b.css)}  img ${kbText(b.image)}  font ${kbText(b.font)}  ${p.requests} req`);
        }
        for (const r of result.lab) {
          const s = r.scores;
          console.log(`  [lab ${r.source}, ${r.strategy}] ${r.url}: perf ${s.performance} a11y ${s.accessibility} seo ${s.seo} bp ${s["best-practices"]} (${r.toolVersion}, ${r.fetchTime})`);
          for (const o of r.opportunities) console.log(`      - ${o.title}${o.displayValue ? `: ${o.displayValue}` : ""}`);
        }
        for (const f of result.field) {
          const m = Object.entries(f.metrics).map(([k, v]) => `${k.toUpperCase()} p75 ${v.p75} (${v.rating})`).join(", ");
          console.log(`  [field CrUX, ${f.formFactor}, ${f.scope}] ${m || "no metrics"}${f.collectionPeriod ? ` — ${f.collectionPeriod}` : ""}`);
        }
        if (result.findings.length) console.log("");
        printFindings(result.findings);
        for (const note of result.notes) console.log(`\nNote: ${note}`);
        console.log(`\nAudit of ${result.target}: ${result.errors} error(s), ${result.warnings} warning(s).`);
      }
      if (!result.ok) process.exit(1);
    }),
  );

cli
  .command("preview", "Serve the production build from dist/")
  .option("--root <dir>", "Project root", { default: "." })
  .option("--port <port>", "Port (fails if taken; default picks a free port from 4173)")
  .option("--host [host]", "Expose on the network")
  .option("--open", "Open the site in your browser")
  .action((opts: ServeFlags) =>
    run(opts, async () => {
      const server = await startPreviewServer(opts.root, { port: parsePort(opts.port), host: opts.host });
      const direct = directUrl(server.httpServer?.address());
      printUrls("vagejs preview", server.resolvedUrls?.local[0], direct, server.resolvedUrls?.network);
      const target = direct ?? server.resolvedUrls?.local[0] ?? server.resolvedUrls?.network[0];
      if (opts.open && target) openBrowser(target);
    }),
  );

cli
  .command("new <kind> <name>", 'Start a page (vage new page pricing) or a post (vage new post "Our first launch") as a draft with valid frontmatter')
  .option("--root <dir>", "Project root", { default: "." })
  .option("--title <text>", "Page title (pages; default from the path)")
  .option("--description <text>", "One or two sentences for search results")
  .option("--under <folder>", "Posts: section folder under src/pages (default: blog)")
  .option("--date <YYYY-MM-DD>", "Posts: datePublished (default: today)")
  .option("--author <name>", "Posts: author (only written when given)")
  .option("--slug <name>", "Posts: file name, for titles without Latin letters or digits")
  .option("--json", "Print machine-readable JSON")
  .action((kind: string, name: string, opts: { root: string; title?: unknown; description?: unknown; under?: unknown; date?: unknown; author?: unknown; slug?: unknown; json?: boolean }) =>
    run(opts, async () => {
      if (kind !== "page" && kind !== "post") throw new VageError(`Unknown kind "${kind}". Use vage new page <path> or vage new post "<title>".`);
      const { createPage } = await import("./new.js");
      // cac turns numeric values (--title 123) into numbers, so every option is read as text.
      const text = (v: unknown) => (v === undefined ? undefined : String(v));
      const created = createPage(opts.root, kind, String(name), { title: text(opts.title), description: text(opts.description), under: text(opts.under), date: text(opts.date), author: text(opts.author), slug: text(opts.slug) });
      if (opts.json) return print({ ok: true, ...created });
      console.log(`Created ${created.file} (draft) for ${created.route}`);
      console.log("Preview it with npm start (drafts show there); remove `draft: true` to publish it, then run npm run check.");
    }),
  );

cli
  .command("mcp", "Run an MCP server over stdio so AI assistants can check this site (read-only tools; needs @modelcontextprotocol/sdk)")
  .option("--root <dir>", "Project root", { default: "." })
  .action((opts: { root: string }) =>
    run({}, async () => {
      const { startMcpServer } = await import("../mcp/server.js");
      await startMcpServer(opts.root, { version, info: () => frameworkInfo(cli, version) });
    }),
  );

cli
  .command("info", "Describe commands, config and frontmatter (use --json for agents)")
  .option("--json", "Print machine-readable JSON")
  .action((opts: { json?: boolean }) =>
    run(opts, () => {
      const info = frameworkInfo(cli, version);
      if (opts.json) return print(info);
      console.log(`vagejs ${info.version}\n`);
      for (const c of info.commands) console.log(`  ${c.usage.padEnd(28)} ${c.description}`);
      console.log(`\nConfig: ${info.config.files.join(" | ")}. Pages: ${info.routing.pagesDir}/**/*.md`);
      console.log("Run `vage info --json` for full config and frontmatter JSON Schemas.");
    }),
  );

interface PublishFlags extends CommonOptions {
  remote?: string;
  branch?: string;
  message?: string;
  yes?: boolean;
  dryRun?: boolean;
}

cli
  .command("deploy:github", "Check, build, then safely commit and push the project to GitHub (asks first)")
  .option("--root <dir>", "Project root", { default: "." })
  .option("--remote <url>", "Git URL to add as origin if there is none")
  .option("--branch <name>", "Branch for a new repository (default: main); must match the current branch otherwise")
  .option("-m, --message <msg>", "Commit message")
  .option("--dry-run", "Run check + build and show the plan; no git changes")
  .option("--yes", "Skip the confirmation prompt")
  .option("--json", "Print machine-readable JSON")
  .action((opts: PublishFlags) =>
    run(opts, async () => {
      const { publish } = await import("../deploy/publish.js");
      const result = await publish(opts.root, { ...opts, confirm: (plan) => confirmPlan(plan, opts) });
      if (opts.dryRun) return opts.json ? print({ ok: true, dryRun: true, plan: result.plan }) : console.log("Dry run: nothing changed.");
      if (opts.json) return print({ ok: result.status !== "aborted", ...result });
      reportPublish(result);
    }),
  );

cli
  .command("deploy", "Deploy: GitHub Pages (workflow + push, waits for GitHub), Cloudflare Workers (new version, no downtime) or Cloudflare Pages")
  .option("--root <dir>", "Project root", { default: "." })
  .option("--target <host>", "github-pages, cloudflare-workers or cloudflare-pages (default: deploy.target in config)")
  .option("--project <name>", "Cloudflare Pages project or Worker name (default: deploy.cloudflareProject / cloudflareWorker)")
  .option("--remote <url>", "Git URL to add as origin if there is none")
  .option("--branch <name>", "Branch for a new repository (default: main)")
  .option("-m, --message <msg>", "Commit message")
  .option("--no-wait", "Don't wait for the GitHub Actions deploy run")
  .option("--dry-run", "Run check + build and show the plan; no git changes")
  .option("--yes", "Skip the confirmation prompt")
  .option("--json", "Print machine-readable JSON")
  .action((opts: PublishFlags & { wait: boolean; target?: string; project?: string }) =>
    run(opts, async () => {
      const { loadProjectConfig } = await import("../core/project-config.js");
      const config = await loadProjectConfig(path.resolve(opts.root));
      const target = opts.target ?? config.deploy.target;
      if (target === "cloudflare-pages") return deployToCloudflare(opts, config.deploy.cloudflareProject);
      if (target === "cloudflare-workers") return deployToWorkers(opts, config.deploy.cloudflareWorker ?? config.deploy.cloudflareProject, config.site);
      if (target !== "github-pages") throw new VageError(`Unknown --target "${target}". Use github-pages, cloudflare-workers or cloudflare-pages.`);
      const { publish } = await import("../deploy/publish.js");
      const pages = await import("../deploy/github-pages.js");
      // Stop before pushing a site GitHub Pages would serve from a subfolder (its links would break).
      const { gitRaw } = await import("../deploy/git.js");
      const origin = opts.remote ?? (await gitRaw(path.resolve(opts.root), ["remote", "get-url", "origin"]).catch(() => undefined))?.stdout?.trim();
      const subfolder = pages.pagesSubfolderProblem(config.site, origin);
      if (subfolder) throw new VageError(subfolder);
      const result = await publish(opts.root, {
        ...opts,
        extraFiles: (branch) => ({ [pages.PAGES_WORKFLOW]: pages.pagesWorkflow(branch) }),
        confirm: (plan) => confirmPlan(plan, opts, "Then enable GitHub Pages (source: GitHub Actions) via gh if needed, and wait for the deploy run."),
      });
      if (opts.dryRun) return opts.json ? print({ ok: true, dryRun: true, plan: result.plan }) : console.log("Dry run: nothing changed.");
      if (result.status !== "published") {
        if (opts.json) return print({ ok: result.status !== "aborted", ...result, deployment: { status: "unconfirmed", reason: `Nothing was pushed (${result.status}).` } });
        reportPublish(result);
        if (result.status === "committed") console.log("Not deployed: there is no remote. Pass --remote <git-url>.");
        return;
      }
      if (!opts.json) reportPublish(result);
      const enabled = await pages.ensurePagesEnabled(result.plan.root);
      const deployment =
        typeof enabled === "object"
          ? { status: "unconfirmed" as const, reason: enabled.manual }
          : opts.wait
            ? await pages.confirmPagesDeployment(result.plan.root, result.commit!)
            : { status: "unconfirmed" as const, reason: "Not waiting (--no-wait); the deploy runs in GitHub Actions." };
      if (opts.json) return print({ ok: deployment.status !== "failure", ...result, deployment });
      if (deployment.status === "success") console.log(`\nDeployed: ${deployment.pageUrl ?? "(Pages URL unavailable)"}\nRun: ${deployment.runUrl}`);
      else console.log(`\nDeployment ${deployment.status === "failure" ? "FAILED" : "not confirmed"}: ${deployment.reason}${deployment.runUrl ? `\nRun: ${deployment.runUrl}` : ""}`);
      if (deployment.status === "failure") process.exit(1);
    }),
  );

const OAUTH_SETUP = `Set GOOGLE_OAUTH_CLIENT_ID (and GOOGLE_OAUTH_CLIENT_SECRET) from a Google Cloud OAuth client of type "Desktop app":
  console.cloud.google.com → APIs & Services → Credentials → Create credentials → OAuth client ID → Desktop app.
  Enable the "Google Search Console API" and/or "Google Analytics Data API" for that project.
Keep these in your shell or a git-ignored .env, never in vage.config.ts.`;

cli
  .command("connect <service>", "Connect Search Console (gsc) or Analytics (ga4) via OAuth, or save your own PageSpeed / CrUX API key (pagespeed, crux)")
  .option("--no-open", "Print the consent URL instead of opening a browser")
  .option("--json", "Print machine-readable JSON")
  .action((service: string, opts: { open: boolean; json?: boolean }) =>
    run(opts, async () => {
      if (service === "pagespeed" || service === "crux") {
        if (!process.stdin.isTTY) throw new VageError(`Run this in a terminal, or set ${(await import("../integrations/api-keys.js")).API_KEYS[service].env} in your environment instead.`);
        const saved = await askForApiKey(service, { alwaysSave: true });
        if (opts.json) return print({ ok: Boolean(saved), service });
        return console.log(saved ? "Saved. `vage audit --url` will use this key." : "Nothing saved.");
      }
      if (service !== "gsc" && service !== "ga4") throw new VageError(`Unknown service "${service}". Use gsc, ga4, pagespeed or crux.`);
      const google = await import("../integrations/google-auth.js");
      const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
      if (!clientId) throw new VageError(`GOOGLE_OAUTH_CLIENT_ID is not set.\n${OAUTH_SETUP}`);
      const log = opts.json ? console.error : console.log;
      log(`Requesting read-only access: ${google.SCOPES[service]}`);
      log(`The refresh token will be stored outside this project at ${google.credentialsPath()} (mode 600).`);
      const creds = await google.connectGoogle({
        scopes: [google.SCOPES[service]],
        clientId,
        clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
        open: (url) => {
          log(`\nOpen this URL to approve access:\n${url}\n`);
          if (opts.open) openBrowser(url);
        },
      });
      let properties: { siteUrl: string; permissionLevel: string }[] | undefined;
      if (service === "gsc") {
        const { listSites } = await import("../integrations/search-console.js");
        properties = await listSites(await google.getAccessToken(google.SCOPES.gsc, "gsc"));
      }
      if (opts.json) return print({ ok: true, service, scopes: creds.scopes, properties });
      log(`Connected (${creds.scopes.length} scope(s)).`);
      if (properties) {
        log(properties.length ? "Search Console properties you can access:" : "No Search Console properties found for this account.");
        for (const p of properties) log(`  ${p.siteUrl} (${p.permissionLevel})`);
        if (properties[0]) log(`\nSet one in vage.config.ts: integrations: { searchConsole: { property: "${properties[0].siteUrl}" } }`);
      } else {
        log('Set the numeric property ID in vage.config.ts: integrations: { ga4: { propertyId: "123456789" } }');
      }
    }),
  );

cli
  .command("disconnect <provider>", "Remove a stored connection: google (revokes OAuth), pagespeed or crux (saved API key)")
  .option("--json", "Print machine-readable JSON")
  .action((provider: string, opts: { json?: boolean }) =>
    run(opts, async () => {
      if (provider === "pagespeed" || provider === "crux") {
        const { removeApiKey } = await import("../integrations/api-keys.js");
        const removed = removeApiKey(provider);
        if (opts.json) return print({ ok: true, removed });
        return console.log(removed ? `Removed the saved ${provider} key. (Also revoke it in Google Cloud Console if it is no longer needed.)` : `No saved ${provider} key.`);
      }
      if (provider !== "google") throw new VageError(`Unknown provider "${provider}". Use google, pagespeed or crux.`);
      const { disconnectGoogle } = await import("../integrations/google-auth.js");
      const result = await disconnectGoogle();
      if (opts.json) return print({ ok: true, ...result });
      if (!result.hadConnection) return console.log("No Google connection was stored.");
      console.log(
        result.revoked
          ? "Revoked access at Google and deleted the local token."
          : "Deleted the local token, but revocation at Google failed. Remove access at https://myaccount.google.com/permissions.",
      );
    }),
  );

cli
  .command("links [action] [...domains]", "List the external domains the site links to; the site owner approves them into links.lock.json (asks first)")
  .option("--root <dir>", "Project root", { default: "." })
  .option("--all", "approve: every domain the site links to now")
  .option("--prune", "approve: also remove approved domains the site no longer links to")
  .option("--dry-run", "approve: show the change without writing")
  .option("--yes", "Skip the confirmation prompt (only with the site owner's approval)")
  .option("--json", "Print machine-readable JSON")
  .action((action: string | undefined, domains: string[], opts: CommonOptions & { all?: boolean; prune?: boolean; dryRun?: boolean; yes?: boolean }) =>
    run(opts, async () => {
      const { linkStatus, nextLock, readLinkLock, writeLinkLock } = await import("../checks/links.js");
      const root = path.resolve(opts.root);
      const status = await linkStatus(root);
      if (!action || action === "list") {
        if (opts.json) return print({ ok: true, ...status });
        if (!status.domains.length) return console.log("The site links to no external domains.");
        for (const d of status.domains) console.log(`${d.approved ? "approved" : "NEW     "}  ${d.domain.padEnd(36)} ${d.pages.length} page(s): ${d.pages.slice(0, 3).join(", ")}${d.pages.length > 3 ? " …" : ""}`);
        for (const d of status.unused) console.log(`unused    ${d}  (approved, no longer linked; drop with "vage links approve --prune")`);
        if (!status.hasLock) console.log('\nNo links.lock.json yet. Review the list, then: npx vage links approve --all');
        return;
      }
      if (action !== "approve") throw new VageError(`Unknown action "${action}". Use "vage links" to list or "vage links approve <domain...>".`);
      const add = opts.all ? status.domains.map((d) => d.domain) : domains;
      if (!add.length && !opts.prune) throw new VageError('Name the domains to approve ("vage links approve example.com"), or pass --all after reviewing "vage links".');
      const current = readLinkLock(root)?.domains ?? [];
      const next = nextLock(status, current, add, Boolean(opts.prune));
      const added = next.filter((d) => !current.includes(d));
      const removed = current.filter((d) => !next.includes(d));
      if (!added.length && !removed.length) return opts.json ? print({ ok: true, changed: false }) : console.log("links.lock.json already up to date.");
      const lines = ["Update links.lock.json", ...added.map((d) => `  + ${d}`), ...removed.map((d) => `  - ${d}`)];
      if (!(await askConfirm(lines, opts as PublishFlags))) {
        return opts.json ? print({ ok: !!opts.dryRun, dryRun: !!opts.dryRun, added, removed }) : console.log(opts.dryRun ? "Dry run: nothing written." : "Nothing written.");
      }
      writeLinkLock(root, next);
      if (opts.json) print({ ok: true, added, removed });
      else console.log(`links.lock.json updated: ${added.length} added, ${removed.length} removed.`);
    }),
  );

cli
  .command("verify", "Compare the live site with your files (extra links, scripts, text or sitemap pages mean it was changed outside your repository), and check search and AI crawlers can reach it")
  .option("--root <dir>", "Project root", { default: "." })
  .option("--url <url>", "Live site origin (default: site in vage.config.ts)")
  .option("--no-crawlers", "Skip the crawlability check (search and AI crawlers, redirects, noindex headers)")
  .option("--json", "Print machine-readable JSON")
  .action((opts: CommonOptions & { url?: string; crawlers: boolean }) =>
    run(opts, async () => {
      const { verifySite } = await import("../checks/verify.js");
      const result = await verifySite(opts.root, { url: opts.url, crawlers: opts.crawlers });
      if (opts.json) print(result);
      else {
        for (const d of result.differences) console.log(`${d.severity === "error" ? "error  " : "warning"} ${d.kind.padEnd(15)} ${d.route}\n        ${d.detail}`);
        console.log(`\nVerified ${result.pagesChecked} page(s) on ${result.url}${result.crawlersChecked ? ` and probed ${result.crawlersChecked} search and AI crawlers` : ""}: ${result.differences.filter((d) => d.severity === "error").length} error(s), ${result.differences.filter((d) => d.severity === "warning").length} warning(s).`);
        const tampered = result.differences.some((d) => d.severity === "error" && ["links-added", "scripts-added", "text-changed", "sitemap-extra", "robots-changed"].includes(d.kind));
        if (tampered) console.log("The live site has content that isn't in your files. If you didn't deploy it, rotate your host and Git credentials, then redeploy from the repository.");
      }
      if (!result.ok) process.exitCode = 1;
    }),
  );

cli
  .command("report <kind>", "Report from Search Console (search) or GA4 (analytics); needs vage connect")
  .option("--root <dir>", "Project root", { default: "." })
  .option("--property <property>", "Search Console property (default: integrations.searchConsole.property)")
  .option("--property-id <id>", "GA4 property ID (default: integrations.ga4.propertyId)")
  .option("--days <n>", "Days to include", { default: 28 })
  .option("--json", "Print machine-readable JSON")
  .action((kind: string, opts: CommonOptions & { property?: string; propertyId?: string; days: number }) =>
    run(opts, async () => {
      if (kind !== "search" && kind !== "analytics") throw new VageError(`Unknown report "${kind}". Use "search" or "analytics".`);
      const days = Number(opts.days);
      if (!Number.isInteger(days) || days < 1 || days > 480) throw new VageError("--days must be a whole number from 1 to 480.");
      const google = await import("../integrations/google-auth.js");
      const { loadProjectConfig } = await import("../core/project-config.js");
      const site = await loadProjectConfig(opts.root);

      if (kind === "search") {
        const property = opts.property ?? site.integrations.searchConsole?.property;
        if (!property) throw new VageError('No Search Console property. Pass --property or set integrations.searchConsole.property (list them with "vage connect gsc").');
        const { searchReport } = await import("../integrations/search-console.js");
        const report = await searchReport(await google.getAccessToken(google.SCOPES.gsc, "gsc"), property, days);
        if (opts.json) return print({ ok: true, ...report });
        console.log(`Search Console: ${report.property}, ${report.startDate} to ${report.endDate} (Pacific Time; finalized data only)\n`);
        for (const [title, rows] of [["Top queries", report.queries], ["Top pages", report.pages]] as const) {
          console.log(`${title}:`);
          if (!rows.length) console.log("  (no data)");
          for (const r of rows) console.log(`  ${r.key.slice(0, 60).padEnd(60)} ${String(r.clicks).padStart(6)} clicks ${String(r.impressions).padStart(8)} impr  ctr ${(r.ctr * 100).toFixed(1)}%  pos ${r.position.toFixed(1)}`);
          console.log("");
        }
        console.log("The API returns top rows only and does not cover every Search Console report (e.g. page indexing).");
      } else {
        const propertyId = opts.propertyId ?? site.integrations.ga4?.propertyId;
        if (!propertyId) throw new VageError("No GA4 property. Pass --property-id or set integrations.ga4.propertyId.");
        const { analyticsReport } = await import("../integrations/ga4-data.js");
        const report = await analyticsReport(await google.getAccessToken(google.SCOPES.ga4, "ga4"), propertyId, days);
        if (opts.json) return print({ ok: true, ...report });
        console.log(`GA4 property ${report.propertyId}, last ${report.days} days: top pages by views\n`);
        if (!report.rows.length) console.log("  (no data)");
        for (const r of report.rows) console.log(`  ${r.pagePath.slice(0, 60).padEnd(60)} ${String(r.screenPageViews).padStart(7)} views ${String(r.activeUsers).padStart(6)} users ${String(r.sessions).padStart(6)} sessions`);
      }
    }),
  );

cli
  .command("indexnow", "Notify IndexNow search engines about changed URLs (asks first)")
  .option("--root <dir>", "Project root", { default: "." })
  .option("--changed-since <ref>", "Submit pages changed since a git ref (e.g. HEAD~1)")
  .option("--urls <list>", "Comma-separated URLs or paths to submit")
  .option("--all", "Submit every page listed in sitemap.xml")
  .option("--dry-run", "Show the URLs without submitting")
  .option("--yes", "Skip the confirmation prompt")
  .option("--json", "Print machine-readable JSON")
  .action((opts: CommonOptions & { changedSince?: string; urls?: string; all?: boolean; dryRun?: boolean; yes?: boolean }) =>
    run(opts, async () => {
      const root = path.resolve(opts.root);
      const { createBuildLoader } = await import("../core/loader.js");
      const { renderSite, listedPages } = await import("../core/site.js");
      const loader = await createBuildLoader(root);
      const model = await renderSite(root, loader.load).finally(() => loader.close());
      const { site } = model;
      const config = site.integrations.indexNow;
      if (!config) throw new VageError('IndexNow is not configured. Add integrations: { indexNow: { key: "<8-128 letters, digits or dashes>" } } and deploy.');
      if (!site.site) throw new VageError('"site" must be set in vage.config.ts to submit URLs.');
      const abs = (p: string) => new URL(p, site.site).href;

      let urls: string[];
      if (opts.all) urls = listedPages(model).map((p) => p.meta.canonical!);
      else if (opts.urls) urls = opts.urls.split(",").map((u) => abs(u.trim()));
      else if (opts.changedSince) {
        const { changedPageRoutes } = await import("../deploy/git.js");
        urls = (await changedPageRoutes(root, opts.changedSince)).map(abs);
        if (!urls.length) return opts.json ? print({ ok: true, submitted: 0 }) : console.log(`No page changes since ${opts.changedSince}.`);
      } else throw new VageError("Choose what to submit: --changed-since <ref>, --urls <list>, or --all.");

      const lines = [`IndexNow: submit ${urls.length} URL(s) to ${config.endpoint}`, ...urls.slice(0, 20).map((u) => `  ${u}`), ...(urls.length > 20 ? [`  … ${urls.length - 20} more`] : [])];
      if (!(await askConfirm(lines, opts))) return opts.json ? print({ ok: true, dryRun: Boolean(opts.dryRun), urls }) : console.log("Nothing submitted.");
      const { submitIndexNow } = await import("../integrations/indexnow.js");
      const result = await submitIndexNow({ site: site.site, key: config.key, endpoint: config.endpoint, urls });
      if (opts.json) return print({ ok: true, ...result });
      console.log(`${result.status === 202 ? "Received (key validation pending)" : "Accepted"}: ${result.submitted} URL(s). IndexNow is a hint; it doesn't guarantee crawling or indexing.`);
    }),
  );

cli
  .command("guidelines", "Show the rule pack: provider facts in use, their official sources, and the changelog")
  .option("--json", "Print machine-readable JSON")
  .action((opts: { json?: boolean }) =>
    run(opts, async () => {
      const { rulePack } = await import("../guidelines/pack.js");
      if (opts.json) return print(rulePack);
      console.log(`Rule pack ${rulePack.version} (released ${rulePack.released})\n`);
      for (const r of rulePack.rules) {
        console.log(`  ${r.id}${r.behaviorChanging ? " [changes output]" : ""}\n    ${r.summary}`);
        for (const id of r.sources) console.log(`    - ${rulePack.sources.find((s) => s.id === id)?.url}`);
      }
      console.log("\nChangelog:");
      for (const c of rulePack.changelog) console.log(`  ${c.version} (${c.date}, reviewed by ${c.reviewedBy}): ${c.summary}`);
      console.log('\nPin this version with guidelines: { rulePack: "' + rulePack.version + '" } in vage.config.ts.');
    }),
  );

cli.help();
cli.version(version);

try {
  cli.parse(process.argv, { run: false });
  if (!cli.matchedCommand && cli.args.length === 0 && !cli.options.help && !cli.options.version) {
    cli.outputHelp();
  } else if (!cli.matchedCommand && cli.args.length > 0) {
    throw new VageError(`Unknown command "${cli.args[0]}". Run "vage --help" for the list of commands.`);
  } else {
    await cli.runMatchedCommand();
  }
} catch (err) {
  fail(usageError(err), Boolean(cli.options.json));
}

/** Mistakes in the command line itself (unknown option, extra value) get a clear message, not a stack trace. */
function usageError(err: unknown): unknown {
  if ((err as Error)?.name !== "CACError") return err;
  const name = cli.matchedCommand?.name;
  const help = name ? `vage ${name} --help` : "vage --help";
  const lists = /^Unused args/.test((err as Error).message) ? ' Options that take a list want one comma-separated value, e.g. --urls "/a/,/b/".' : "";
  return new VageError(`${(err as Error).message}.${lists} See "${help}".`);
}

async function run(opts: { json?: boolean }, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    fail(err, Boolean(opts.json));
  }
}

function fail(err: unknown, json: boolean): never {
  const message = err instanceof Error ? err.message : String(err);
  if (json) print({ ok: false, error: message });
  else if (err instanceof VageError) console.error(`Error: ${message}`);
  else console.error(err);
  process.exit(1);
}

function printFindings(findings: Finding[]) {
  for (const f of findings) {
    const where = f.page ? `${f.page}${f.source ? ` (${f.source})` : ""}` : (f.source ?? "site");
    console.log(`${f.severity === "error" ? "error  " : "warning"} ${f.rule.padEnd(22)} ${where}\n        ${f.message}${f.docs ? `\n        see ${f.docs}` : ""}`);
  }
}

type Plan = import("../deploy/publish.js").PublishPlan;

async function deployToCloudflare(opts: PublishFlags & { project?: string }, configuredProject?: string) {
  const project = opts.project ?? configuredProject;
  if (!project) throw new VageError("No Cloudflare Pages project. Pass --project <name> or set deploy.cloudflareProject.");
  assertCloudflareProject(project);
  const root = path.resolve(opts.root);
  const { check } = await import("../checks/check.js");
  const checked = await check(root);
  if (checked.errors) throw new VageError(`vage check found ${checked.errors} error(s). Fix them before deploying.`);
  const result = await build(root);
  const { gitRaw } = await import("../deploy/git.js");
  const currentBranch = (await gitRaw(root, ["branch", "--show-current"])).stdout.trim();
  const commit = (await gitRaw(root, ["rev-parse", "HEAD"])).stdout.trim() || undefined;
  const branch = assertBranchName(opts.branch ?? (currentBranch || "main"));
  const { deployCloudflarePages, WRANGLER } = await import("../deploy/cloudflare-pages.js");

  const lines = [
    `Deploy plan (Cloudflare Pages)`,
    `  • upload ${result.outDir} (${result.pages.length} page(s), ${result.files.length} generated file(s)) to project "${project}"`,
    `  • branch "${branch}": the production branch updates the live site; other branches get a preview URL`,
    `  • runs: npx ${WRANGLER} pages deploy dist --project-name ${project} --branch ${branch}`,
  ];
  if (!(await askConfirm(lines, opts))) {
    if (opts.dryRun) return opts.json ? print({ ok: true, dryRun: true, target: "cloudflare-pages", project, branch }) : console.log("Dry run: nothing deployed.");
    return opts.json ? print({ ok: false, status: "aborted" }) : console.log("Nothing deployed.");
  }
  const deployment = await deployCloudflarePages(root, { project, branch, commit });
  if (opts.json) print({ ok: deployment.status !== "failure", target: "cloudflare-pages", project, deployment });
  else if (deployment.status === "success") console.log(`Deployed and verified: ${deployment.deploymentUrl} (branch ${branch})`);
  else console.log(`Deployment ${deployment.status === "failure" ? "FAILED" : "not confirmed"}: ${deployment.reason}`);
  if (deployment.status === "failure") process.exit(1);
}

async function deployToWorkers(opts: PublishFlags & { project?: string }, configuredWorker: string | undefined, siteUrl: string | undefined) {
  const root = path.resolve(opts.root);
  const { deployCloudflareWorkers, planWorkersDeploy } = await import("../deploy/cloudflare-workers.js");
  const { WRANGLER } = await import("../deploy/cloudflare-pages.js");
  const requested = opts.project ?? configuredWorker;
  if (requested) assertWorkerName(requested);
  const plan = planWorkersDeploy(root, requested);
  const { check } = await import("../checks/check.js");
  const checked = await check(root);
  if (checked.errors) throw new VageError(`vage check found ${checked.errors} error(s). Fix them before deploying.`);
  const result = await build(root);

  const steps = [
    `upload ${result.outDir} (${result.pages.length} page(s), ${result.files.length} generated file(s)) to Worker "${plan.worker}"`,
    plan.config ? `uses ${plan.config.file} (routes and custom domains stay as they are)` : "no wrangler config: a temporary one serves dist/ (with your 404 page)",
    `runs: npx ${WRANGLER} versions upload, then versions deploy <version>@100% (a brand-new Worker gets wrangler deploy once)`,
    `verifies: ${siteUrl ?? "the Worker's workers.dev URL"} answers 200`,
  ];
  const lines = ["Deploy plan (Cloudflare Workers)", ...steps.map((s) => `  • ${s}`), ...plan.warnings.map((w) => `  ! ${w}`)];
  if (!(await askConfirm(lines, opts))) {
    if (opts.dryRun) {
      return opts.json
        ? print({ ok: true, dryRun: true, target: "cloudflare-workers", worker: plan.worker, config: plan.config?.file, steps, warnings: plan.warnings })
        : console.log("Dry run: nothing deployed.");
    }
    return opts.json ? print({ ok: false, status: "aborted" }) : console.log("Nothing deployed.");
  }
  const deployment = await deployCloudflareWorkers(root, { plan, siteUrl });
  if (opts.json) print({ ok: deployment.status !== "failure", target: "cloudflare-workers", deployment });
  else if (deployment.status === "success") console.log(`Deployed and verified: ${deployment.pageUrl} (${deployment.mode === "first-deploy" ? "first deploy" : `version ${deployment.versionId}`})`);
  else console.log(`Deployment ${deployment.status === "failure" ? "FAILED" : "not confirmed"}: ${deployment.reason}`);
  if (deployment.status === "failure") process.exit(1);
}

async function confirmPlan(plan: Plan, opts: PublishFlags, extra?: string): Promise<boolean> {
  const lines = [`Publish plan for ${plan.root}`];
  if (plan.initRepo) lines.push(`  • git init (branch ${plan.branch})`);
  if (plan.addRemote) lines.push(`  • add origin ${plan.remote}`);
  lines.push(`  • commit ${plan.files.length} file(s) on ${plan.branch}: "${plan.message}"`);
  for (const f of plan.files) lines.push(`      ${f.status} ${f.path}`);
  lines.push(plan.remote ? `  • push to ${plan.remote} (${plan.branch}); never forced` : "  • no push (no remote)");
  if (extra) lines.push(`  • ${extra}`);
  for (const w of plan.warnings) lines.push(`  ! ${w}`);
  return askConfirm(lines, opts);
}

/** Shows the plan, then asks. --dry-run never proceeds; --yes skips the prompt; non-TTY without --yes refuses. */
async function askConfirm(lines: string[], opts: { json?: boolean; dryRun?: boolean; yes?: boolean }): Promise<boolean> {
  if (!opts.json || opts.dryRun) for (const line of lines) (opts.json ? console.error : console.log)(line);
  if (opts.dryRun) return false;
  if (opts.yes) return true;
  if (!process.stdin.isTTY) throw new VageError("Confirmation required. Review the plan with --dry-run, then re-run with --yes.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question("Proceed? [y/N] ")).trim());
  } finally {
    rl.close();
  }
}

function reportPublish(result: import("../deploy/publish.js").PublishResult) {
  if (result.status === "aborted") return console.log("Nothing changed.");
  if (result.status === "up-to-date") return console.log("Nothing to publish: no changes and the remote is up to date.");
  if (result.status === "committed") return console.log(`Committed ${result.commit!.slice(0, 7)} locally (no remote).`);
  const r = result.confirmedRemote!;
  console.log(`Pushed ${r.sha.slice(0, 7)} to ${r.url} (${r.branch}); confirmed on the remote.`);
}

function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

/** Asks for the user's own API key (hidden input), optionally saving it outside the project. */
async function askForApiKey(name: "pagespeed" | "crux", opts: { alwaysSave?: boolean } = {}): Promise<string | undefined> {
  const { API_KEYS, saveApiKey } = await import("../integrations/api-keys.js");
  const k = API_KEYS[name];
  console.log(`\n${k.label} uses your own Google Cloud API key (vagejs has no shared key).\nGet one: ${k.howTo}`);
  const key = (await askHidden(`Paste your ${name} API key (input hidden, Enter to skip): `)).trim();
  if (!key) return undefined;
  let save = opts.alwaysSave ?? false;
  if (!save) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      save = !/^n(o)?$/i.test((await rl.question("Save it for future audits, outside this project? [Y/n] ")).trim());
    } finally {
      rl.close();
    }
  }
  if (save) console.log(`Saved to ${saveApiKey(name, key)} (mode 600).`);
  return key;
}

function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          done();
          return resolve(value);
        }
        if (ch === "\u0003") {
          done();
          return reject(new VageError("Cancelled."));
        }
        value = ch === "\u007f" || ch === "\b" ? value.slice(0, -1) : value + ch;
      }
    };
    stdin.on("data", onData);
  });
}

function openBrowser(url: string) {
  const [cmd, args] =
    // Windows: rundll32 opens the URL without cmd.exe, which would treat "&" in the URL as a command separator.
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  // Best effort; the URL is printed too.
  spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

function parsePort(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new VageError(`Invalid port "${value}". Use a whole number between 1 and 65535.`);
  }
  return port;
}
