import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { startMcpServer } from "../src/mcp/server.js";
import { copyFixture, write } from "./helpers.js";

async function connect(root: string) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await startMcpServer(root, { version: "test", info: () => ({ name: "vagejs" }), transport: serverSide });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  return client;
}
const json = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0]!.text);

describe("vage mcp", () => {
  it("offers only read-only tools", async () => {
    const client = await connect(copyFixture());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["vage_check", "vage_info", "vage_links", "vage_pages"]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
    await client.close();
  });

  it("reports the same findings as vage check, naming the file", async () => {
    const root = copyFixture();
    write(root, "src/pages/broken.md", "---\ntitle: Broken\ndescription: A page with a broken link.\n---\n# Broken\n\nSee [the missing page](/nowhere/).\n");
    const client = await connect(root);
    const result = json(await client.callTool({ name: "vage_check" }));
    const hit = result.findings.find((f: { rule: string }) => f.rule === "link-broken");
    expect(hit).toMatchObject({ severity: "error" });
    expect(hit.source).toContain("broken.md");
    await client.close();
  });

  it("lists pages and drafts, and outbound domains", async () => {
    const client = await connect(copyFixture());
    const pages = json(await client.callTool({ name: "vage_pages" }));
    expect(pages.pages.map((p: { route: string }) => p.route)).toContain("/about/");
    expect(pages.drafts.length).toBeGreaterThan(0);
    const links = json(await client.callTool({ name: "vage_links" }));
    expect(Array.isArray(links.domains)).toBe(true);
    expect(json(await client.callTool({ name: "vage_info" }))).toEqual({ name: "vagejs" });
    await client.close();
  });

  it("turns a failure into a readable error result and keeps serving", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", "export default { site: 42 };");
    const client = await connect(root);
    const failed = (await client.callTool({ name: "vage_check" })) as { isError?: boolean; content: { text: string }[] };
    expect(failed.isError).toBe(true);
    expect(failed.content[0]!.text).not.toMatch(/\u001b\[/);
    expect(json(await client.callTool({ name: "vage_info" }))).toEqual({ name: "vagejs" });
    await client.close();
  });
});
