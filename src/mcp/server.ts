import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { check } from "../checks/check.js";
import { linkStatus } from "../checks/links.js";
import { VageError } from "../core/errors.js";
import { createBuildLoader } from "../core/loader.js";
import { renderSite } from "../core/site.js";

/** The MCP SDK is optional: only people who run `vage mcp` install it. */
const SDK = "@modelcontextprotocol/sdk";
const INSTALL = `vage mcp needs the "${SDK}" package. Install it in your project with: npm install --save-dev ${SDK}`;

interface Sdk {
  McpServer: new (info: { name: string; version: string }, options?: { instructions?: string }) => {
    registerTool: (name: string, config: { title: string; description: string; annotations: Record<string, boolean> }, cb: () => Promise<unknown>) => void;
    connect: (transport: unknown) => Promise<void>;
  };
  StdioServerTransport: new () => unknown;
}

/** Loads the SDK from the project first, then from wherever vagejs itself is installed. */
async function loadSdk(root: string): Promise<Sdk> {
  for (const from of [path.join(root, "package.json"), import.meta.url]) {
    try {
      const req = createRequire(from);
      const mcp = await import(pathToFileURL(req.resolve(`${SDK}/server/mcp.js`)).href);
      const stdio = await import(pathToFileURL(req.resolve(`${SDK}/server/stdio.js`)).href);
      return { McpServer: mcp.McpServer, StdioServerTransport: stdio.StdioServerTransport };
    } catch {
      // try the next location
    }
  }
  throw new VageError(INSTALL);
}

/** Published pages and drafts, without writing anything. */
export async function listPages(root: string) {
  const loader = await createBuildLoader(root);
  try {
    const model = await renderSite(root, loader.load, { collectErrors: true });
    return {
      pages: model.pages.map((p) => ({
        route: p.route,
        source: p.source,
        title: p.frontmatter.title,
        description: p.frontmatter.description,
        layout: p.frontmatter.layout ?? "default",
        noindex: Boolean(p.meta.noindex),
      })),
      drafts: model.skippedDrafts,
      errors: model.pageErrors,
    };
  } finally {
    await loader.close();
  }
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

/** Runs a tool; a failure (a broken layout, an invalid config) becomes a readable error result, without terminal colors. */
const tool = (fn: () => Promise<unknown>) => async () => {
  try {
    return text(await fn());
  } catch (err) {
    // eslint-disable-next-line no-control-regex
    const message = String((err as Error)?.message ?? err).replace(/\u001b\[[0-9;]*m/g, "");
    return { isError: true, content: [{ type: "text", text: message }] };
  }
};

/**
 * `vage mcp`: an MCP server over stdio for the project at `root`. Every tool is
 * read-only; approving links and deploying stay with people, through the CLI.
 * stdout carries the protocol, so anything else that prints goes to stderr.
 */
export async function startMcpServer(root: string, options: { version: string; info: () => unknown; transport?: unknown }): Promise<void> {
  root = path.resolve(root);
  const sdk = await loadSdk(root);
  if (!options.transport) console.log = console.info = (...args: unknown[]) => console.error(...args);

  const server = new sdk.McpServer(
    { name: "vagejs", version: options.version },
    {
      instructions:
        "Tools for a vagejs website project. Use vage_info for commands, settings and page fields; vage_check after every change (fix every error it reports; each finding names the file); vage_pages to see what exists; vage_links for outbound domains. Never approve link domains or deploy without the site owner: those stay CLI commands (npx vage links approve, npx vage deploy).",
    },
  );
  server.registerTool("vage_info", { title: "Describe vagejs", description: "Commands, configuration options and page frontmatter fields, with their JSON Schemas (the same as `vage info --json`).", annotations: READ_ONLY }, tool(async () => options.info()));
  server.registerTool("vage_check", { title: "Check the site", description: "Checks every page for broken links, missing titles and descriptions, structured data, accessibility basics and unapproved outbound links (the same as `vage check --json`). Writes nothing.", annotations: READ_ONLY }, tool(() => check(root)));
  server.registerTool("vage_pages", { title: "List pages", description: "Every published page (route, source file, title, description, layout, noindex), the drafts that are skipped, and pages that fail to render.", annotations: READ_ONLY }, tool(() => listPages(root)));
  server.registerTool("vage_links", { title: "List outbound domains", description: "External domains the site links to, which pages link there, and whether each is approved in links.lock.json. Only the site owner approves new domains.", annotations: READ_ONLY }, tool(() => linkStatus(root)));

  await server.connect(options.transport ?? new sdk.StdioServerTransport());
}
