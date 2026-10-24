// Full user journey against the packed package: create -> npm install -> build.
// Needs network or a warm npm cache for third-party dependencies. Run with `npm run test:e2e`.
import { execFileSync, spawnSync, type ExecFileSyncOptions, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { EMPTY_GIT_CONFIG, WINDOWS } from "./helpers.js";

const REPO = path.join(import.meta.dirname, "..");
const CLI = path.join(REPO, "dist", "cli", "index.js");
let work: string;
let tarball: string;

// npm and npx are .cmd scripts on Windows, which Node only starts through a shell.
const shellArgs = (args: string[]) => (WINDOWS ? args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a}"` : a)) : args);
const npmSync = (args: string[], opts: ExecFileSyncOptions) => execFileSync("npm", shellArgs(args), { ...opts, shell: WINDOWS });
const npxSpawn = (args: string[], opts: SpawnSyncOptions & { encoding: "utf8" }) => spawnSync("npx", shellArgs(args), { ...opts, shell: WINDOWS });

beforeAll(() => {
  // Under `npm publish --dry-run` (prepublishOnly), npm exports npm_config_dry_run to child
  // processes; the npm commands below must really pack and install.
  delete process.env.npm_config_dry_run;
  work = fs.mkdtempSync(path.join(os.tmpdir(), "vage-e2e-"));
  const packed = npmSync(["pack", "--pack-destination", work, "--json"], { cwd: REPO, encoding: "utf8" });
  tarball = path.join(work, JSON.parse(packed)[0].filename);
}, 120_000);

/** create-vagejs's entry file, run with node (its .bin shim is a .cmd on Windows). */
const createBin = (runner: string) => path.join(runner, "node_modules", "create-vagejs", JSON.parse(fs.readFileSync(path.join(runner, "node_modules", "create-vagejs", "package.json"), "utf8")).bin["create-vagejs"]);

function vage(args: string[], cwd: string) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

describe("vage CLI (packed package)", () => {
  it("creates, installs from lockfile and builds a starter site", () => {
    const created = vage(["create", "site", "--vage-spec", `file:${tarball}`, "--json"], work);
    expect(created.status).toBe(0);
    expect(JSON.parse(created.stdout).ok).toBe(true);

    const site = path.join(work, "site");
    npmSync(["install", "--no-audit", "--no-fund"], { cwd: site, stdio: "pipe" });
    expect(fs.existsSync(path.join(site, "package-lock.json"))).toBe(true);
    // Reinstall strictly from the lockfile, as CI would.
    npmSync(["ci", "--no-audit", "--no-fund"], { cwd: site, stdio: "pipe" });

    // Use the project's own installed binary, as a user would via npm scripts.
    const built = npxSpawn(["vage", "build", "--json"], { cwd: site, encoding: "utf8" });
    expect(built.status, built.stderr).toBe(0);
    const result = JSON.parse(built.stdout);
    expect(result.ok).toBe(true);
    expect(result.pages.map((p: { route: string }) => p.route)).toEqual(["/", "/about/", "/blog/", "/blog/first-post/"]);
    for (const file of ["index.html", "about/index.html", "blog/first-post/index.html", "404.html", "favicon.svg", "favicon.ico", "apple-touch-icon.png"]) {
      expect(fs.existsSync(path.join(site, "dist", file)), file).toBe(true);
    }
    expect(fs.readFileSync(path.join(site, "dist", "index.html"), "utf8")).toContain("<title>Home | My Website</title>");
    expect(fs.existsSync(path.join(site, ".github/workflows/ci.yml")), "starter CI survives npm pack").toBe(true);
    for (const f of ["links.lock.json", ".github/dependabot.yml", ".github/workflows/verify.yml"]) {
      expect(fs.existsSync(path.join(site, f)), `${f} survives npm pack`).toBe(true);
    }
    for (const file of ["robots.txt", "sitemap.xml", "llms.txt"]) {
      expect(fs.existsSync(path.join(site, "dist", file)), file).toBe(true);
    }

    // A fresh starter passes checks; the only warning is the placeholder site URL.
    // The MCP SDK is optional: without it, `vage mcp` explains how to add it instead of crashing.
    const mcp = npxSpawn(["vage", "mcp"], { cwd: site, encoding: "utf8", input: "" });
    expect(mcp.status).toBe(1);
    expect(mcp.stderr).toMatch(/npm install --save-dev @modelcontextprotocol\/sdk/);
    const checked = npxSpawn(["vage", "check", "--json"], { cwd: site, encoding: "utf8" });
    expect(checked.status, checked.stdout).toBe(0);
    expect(JSON.parse(checked.stdout)).toMatchObject({ ok: true, errors: 0, warnings: 1, findings: [{ rule: "config" }] });
    expect(npxSpawn(["vage", "check", "--strict"], { cwd: site, encoding: "utf8" }).status).toBe(1);

    // The starter is within budgets and has no automated accessibility violations.
    const audited = npxSpawn(["vage", "audit", "--json"], { cwd: site, encoding: "utf8" });
    expect(audited.status, audited.stdout).toBe(0);
    expect(JSON.parse(audited.stdout)).toMatchObject({ ok: true, errors: 0, warnings: 0 });
  }, 300_000);

  it("supports a representative coding-agent workflow", () => {
    const site = path.join(work, "site");
    const json = (args: string[]) => {
      const res = npxSpawn(["vage", ...args, "--json"], { cwd: site, encoding: "utf8" });
      return { status: res.status, data: JSON.parse(res.stdout) };
    };

    // 1. Discover the API instead of guessing.
    const info = json(["info"]).data;
    expect(info.frontmatter.schema.required).toEqual(["title"]);
    // 0.2 layout API is discoverable for agents.
    expect(info.layouts.helpers.collection).toContain("under");
    expect(info.layouts.props.pages).toBeDefined();
    expect(info.checks["page-error"]).toBeDefined();
    expect(info.config.schema.properties.deploy.properties.target.enum).toContain("cloudflare-workers");
    expect(info.commands.map((c: { usage: string }) => c.usage)).toContain("vage check");

    // 2. Add a page per the schema, and link to it with a typo.
    fs.writeFileSync(path.join(site, "src/pages/services.md"), "---\ntitle: Services\ndescription: What we offer.\n---\n# Services\n");
    const index = path.join(site, "src/pages/index.md");
    fs.appendFileSync(index, "\n[Our services](/service/)\n");

    // 3. check reports an actionable error with the file to fix.
    const failed = json(["check"]);
    expect(failed.status).toBe(1);
    expect(failed.data.findings).toContainEqual(
      expect.objectContaining({ rule: "link-broken", source: path.join("src", "pages", "index.md"), message: expect.stringContaining("/service/") }),
    );

    // 4. Fix, re-check, build; the new page is in the sitemap and llms.txt.
    fs.writeFileSync(index, fs.readFileSync(index, "utf8").replace("/service/", "/services/"));
    expect(json(["check"]).data.errors).toBe(0);
    expect(json(["build"]).status).toBe(0);
    expect(fs.readFileSync(path.join(site, "dist/sitemap.xml"), "utf8")).toContain("https://example.com/services/");
    expect(fs.readFileSync(path.join(site, "dist/llms.txt"), "utf8")).toContain("- [Services](https://example.com/services/): What we offer.");
  }, 120_000);

  it("never publishes without confirmation", () => {
    const site = path.join(work, "site");
    const env = { ...process.env, GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid" };
    const npx = (args: string[]) => npxSpawn(["vage", ...args], { cwd: site, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });

    const dry = npx(["deploy:github", "--dry-run", "--json"]);
    expect(dry.status).toBe(0);
    const out = JSON.parse(dry.stdout);
    expect(out).toMatchObject({ ok: true, dryRun: true });
    expect(out.plan.files.map((f: { path: string }) => f.path)).toContain("package-lock.json");
    expect(out.plan.files.some((f: { path: string }) => /^(dist|node_modules)\//.test(f.path))).toBe(false);

    // stdin is not a TTY here, so without --yes it must refuse.
    const refused = npx(["deploy:github"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/Confirmation required/);
    expect(fs.existsSync(path.join(site, ".git"))).toBe(false);
  }, 120_000);

  it("npm create vagejs: the create-vagejs package scaffolds a site pinned to the released version", () => {
    const createDir = path.join(REPO, "packages", "create-vagejs");
    const packed = npmSync(["pack", "--pack-destination", work, "--json"], { cwd: createDir, encoding: "utf8" });
    const createTarball = path.join(work, JSON.parse(packed)[0].filename);
    const runner = path.join(work, "runner");
    fs.mkdirSync(runner);
    // Install both tarballs, as `npm create` would from the registry.
    npmSync(["install", "--no-audit", "--no-fund", tarball, createTarball], { cwd: runner, stdio: "pipe" });
    const res = spawnSync(process.execPath, [createBin(runner), "fresh-site"], { cwd: work, encoding: "utf8" });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/npm install\n {2}npm start\n/); // next steps point to the command that opens the browser
    const pkg = JSON.parse(fs.readFileSync(path.join(work, "fresh-site", "package.json"), "utf8"));
    expect(pkg.scripts.start).toBe("vage dev --open");
    expect(pkg.devDependencies.vagejs).toBe("^0.4.0");
    expect(spawnSync(process.execPath, [createBin(runner)], { encoding: "utf8" }).stderr).toMatch(/Usage: npm create vagejs@latest/);
  }, 300_000);

  it("returns non-zero with a JSON error for failures", () => {
    const res = vage(["build", "--root", path.join(work, "missing"), "--json"], work);
    expect(res.status).toBe(1);
    expect(JSON.parse(res.stdout)).toEqual({ ok: false, error: expect.stringMatching(/No src\/pages directory/) });
  });

  it("refuses to scaffold into a non-empty directory", () => {
    const res = vage(["create", "site"], work);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/already exists and is not empty/);
  });

  it("rejects unknown commands and invalid ports", () => {
    expect(vage(["frobnicate"], work).stderr).toMatch(/Unknown command "frobnicate"/);
    expect(vage(["dev", "--port", "abc"], work).stderr).toMatch(/Invalid port "abc"/);
    const unused = vage(["indexnow", "--dry-run", "--urls", "/a/", "/b/"], work);
    expect(unused.stderr).toMatch(/one comma-separated value/);
    expect(unused.stderr).not.toMatch(/at Command\./); // no stack trace
    expect(vage(["check", "--nope"], work).stderr).toMatch(/Unknown option `--nope`\. See "vage check --help"/);
  });

  it("explains missing Google setup without network calls", () => {
    const env = { ...process.env, GOOGLE_OAUTH_CLIENT_ID: "", PAGESPEED_API_KEY: "", CRUX_API_KEY: "", VAGE_CONFIG_DIR: path.join(work, "cfg") };
    const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: work, encoding: "utf8", env });
    expect(run(["connect", "gsc"]).stderr).toMatch(/GOOGLE_OAUTH_CLIENT_ID is not set[\s\S]*Desktop app/);
    expect(run(["report", "search", "--property", "sc-domain:x.example"]).stderr).toMatch(/Not connected to Google. Run "vage connect gsc"/);
    expect(run(["disconnect", "google"]).stdout).toMatch(/No Google connection was stored/);
    // Audits never fall back to a shared/keyless PageSpeed call; non-interactive runs explain how to add the user's key.
    const audit = run(["audit", "--url", "https://example.com/", "--json"]);
    expect(audit.status).toBe(1);
    expect(JSON.parse(audit.stdout).findings[0].message).toMatch(/needs your own API key/);
    expect(run(["connect", "pagespeed"]).stderr).toMatch(/set PAGESPEED_API_KEY/);
  });

  it("guards outward integrations behind configuration", () => {
    const site = path.join(work, "site");
    const npx = (args: string[]) => npxSpawn(["vage", ...args], { cwd: site, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(npx(["indexnow", "--all"]).stderr).toMatch(/IndexNow is not configured/);
    expect(npx(["deploy", "--target", "cloudflare-pages", "--dry-run"]).stderr).toMatch(/No Cloudflare Pages project/);
    expect(npx(["deploy", "--target", "netlify"]).stderr).toMatch(/Unknown --target "netlify"/);
  }, 120_000);

  it("prints help and version", () => {
    const help = vage(["--help"], work);
    expect(help.status).toBe(0);
    for (const cmd of ["create", "dev", "build", "check", "audit", "preview", "info", "deploy:github", "deploy", "connect", "disconnect", "report", "guidelines", "indexnow"]) expect(help.stdout).toContain(cmd);
    expect(vage(["--version"], work).stdout).toContain("0.4.0");
  });
});
