import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import sharp from "sharp";
import { JSDOM } from "jsdom";
import { build } from "../src/core/build.js";
import { imageVariants, sharpResize, type Resize } from "../src/content/optimize.js";
import { startDevServer } from "../src/dev/server.js";
import { measurePages } from "../src/audit/budgets.js";
import { copyFixture, write } from "./helpers.js";

const REPO = path.resolve(".");
const CONFIG = 'export default { site: "https://fixture.example", title: "Fixture Site", images: { optimize: true, widths: [400, 800, 1600] } };';
const jpeg = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "#4060a0" } }).jpeg().toBuffer();

/** A fixture project that can resolve sharp (linked to this repo's node_modules). */
async function site() {
  const root = copyFixture();
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "dir");
  write(root, "vage.config.ts", CONFIG);
  fs.writeFileSync(path.join(root, "public/images/photo.jpg"), await jpeg(1200, 600));
  write(root, "src/pages/gallery.md", "---\ntitle: Gallery\ndescription: Photos.\n---\n# Gallery\n\n![A blue photo](/images/photo.jpg)\n\n![Logo](/images/logo.png)\n\n![Remote](https://cdn.example/x.jpg)\n");
  return root;
}

describe("image pipeline (images.optimize)", () => {
  it("writes resized WebP files and offers them with srcset, never upscaling", async () => {
    const root = await site();
    await build(root);
    const doc = new JSDOM(fs.readFileSync(path.join(root, "dist/gallery/index.html"), "utf8")).window.document;
    const photo = doc.querySelector('img[alt="A blue photo"]')!;
    const srcset = photo.getAttribute("srcset")!;
    // 400 and 800 from the settings, plus the original 1200 (1600 would be an upscale).
    expect(srcset).toMatch(/^\/_vage\/img\/photo-[0-9a-f]{10}-400\.webp 400w, \/_vage\/img\/photo-[0-9a-f]{10}-800\.webp 800w, \/_vage\/img\/photo-[0-9a-f]{10}-1200\.webp 1200w$/);
    expect(photo.getAttribute("sizes")).toBe("(max-width: 48rem) 100vw, 48rem");
    expect(photo.getAttribute("src")).toBe("/images/photo.jpg"); // the original stays as the fallback
    for (const entry of srcset.split(", ")) {
      const [url, w] = entry.split(" ");
      const meta = await sharp(path.join(root, "dist", url!)).metadata();
      expect([meta.format, `${meta.width}w`]).toEqual(["webp", w]);
    }
    expect(doc.querySelector('img[alt="Remote"]')!.hasAttribute("srcset")).toBe(false);
  });

  it("includes the original width when it's smaller than every configured width", async () => {
    const root = await site();
    fs.writeFileSync(path.join(root, "public/images/small.jpg"), await jpeg(300, 200));
    write(root, "src/pages/small.md", "---\ntitle: Small\ndescription: Small.\n---\n# Small\n\n![Small](/images/small.jpg)\n");
    await build(root);
    expect(fs.readFileSync(path.join(root, "dist/small/index.html"), "utf8")).toMatch(/small-[0-9a-f]{10}-300\.webp 300w"/);
  });

  it("reuses cached files on the next build", async () => {
    const root = await site();
    await build(root);
    let calls = 0;
    const counting: Resize = async (input, w, q) => (calls++, (await sharpResize(root))(input, w, q));
    const v = await imageVariants("/images/photo.jpg", root, { optimize: true, widths: [400, 800, 1600], quality: 75, sizes: "100vw" }, counting);
    expect(v?.files.size).toBe(3);
    expect(calls).toBe(0);
  });

  it("skips SVG, missing files and paths outside public/", async () => {
    const root = await site();
    const resize: Resize = async () => {
      throw new Error("should not be called");
    };
    const opts = { optimize: true, widths: [400], quality: 75, sizes: "100vw" };
    for (const src of ["/images/logo.svg", "/images/missing.jpg", "/../package.json", "//cdn.example/x.jpg", "/100%.jpg"]) {
      expect(await imageVariants(src, root, opts, resize), src).toBeUndefined();
    }
  });

  it("explains how to install sharp when it's missing", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", CONFIG);
    await expect(build(root)).rejects.toThrow(/npm install --save-dev sharp/);
  });
});

describe("optimized images in the dev server", () => {
  let server: ViteDevServer | undefined;
  afterEach(async () => server?.close());
  it("serves the generated WebP files", async () => {
    const root = await site();
    server = await startDevServer(root, { port: 0 });
    const url = `http://localhost:${(server.httpServer!.address() as { port: number }).port}`;
    const html = await (await fetch(`${url}/gallery/`)).text();
    const first = /srcset="([^ ]+) /.exec(html)![1]!;
    const res = await fetch(url + first);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect((await fetch(`${url}/_vage/img/nope-0000000000-1.webp`)).status).toBe(404);
  });

  it("serves the AVIF copies too (review finding: they returned 404 in dev)", async () => {
    const root = await site();
    write(root, "vage.config.ts", 'export default { site: "https://fixture.example", title: "Fixture Site", images: { optimize: true, avif: true, widths: [400, 800, 1600] } };');
    server = await startDevServer(root, { port: 0 });
    const url = `http://localhost:${(server.httpServer!.address() as { port: number }).port}`;
    const html = await (await fetch(`${url}/gallery/`)).text();
    const avif = /<source type="image\/avif" srcset="([^ ]+) /.exec(html)![1]!;
    const res = await fetch(url + avif);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/avif");
  });
});

describe("image pipeline review fixes", () => {
  it("respects EXIF orientation for width/height and in the resized copies", async () => {
    const root = await site();
    const rotated = await sharp({ create: { width: 1200, height: 600, channels: 3, background: "#a04060" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    fs.writeFileSync(path.join(root, "public/images/phone.jpg"), rotated);
    write(root, "src/pages/phone.md", "---\ntitle: Phone\ndescription: Phone.\n---\n# Phone\n\n![A portrait photo](/images/phone.jpg)\n");
    await build(root);
    const img = new JSDOM(fs.readFileSync(path.join(root, "dist/phone/index.html"), "utf8")).window.document.querySelector("img")!;
    expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["600", "1200"]);
    const first = img.getAttribute("srcset")!.split(" ")[0]!;
    const meta = await sharp(path.join(root, "dist", first)).metadata();
    expect(meta.height!).toBeGreaterThan(meta.width!); // portrait, not sideways
  });

  it("never follows symlinks, and matches file names with characters that need escaping", async () => {
    const root = await site();
    const outside = path.join(root, "..", `outside-${Date.now()}.jpg`);
    fs.writeFileSync(outside, await jpeg(900, 600));
    fs.symlinkSync(outside, path.join(root, "public/images/linked.jpg"));
    const never: Resize = async () => {
      throw new Error("should not be called");
    };
    expect(await imageVariants("/images/linked.jpg", root, { optimize: true, widths: [400], quality: 75, sizes: "100vw" }, never)).toBeUndefined();

    fs.writeFileSync(path.join(root, "public/images/a&b.jpg"), await jpeg(900, 600));
    write(root, "src/pages/amp.md", "---\ntitle: Amp\ndescription: Amp.\n---\n# Amp\n\n<img src=\"/images/a&amp;b.jpg\" alt=\"Ampersand\">\n");
    fs.rmSync(path.join(root, "public/images/linked.jpg"));
    await build(root);
    expect(fs.readFileSync(path.join(root, "dist/amp/index.html"), "utf8")).toMatch(/srcset="\/_vage\/img\/a-b-[0-9a-f]{10}-400\.webp 400w/);
  });

  it("reports a missing sharp once, and a corrupt image by name", async () => {
    const { check } = await import("../src/checks/check.js");
    const bare = copyFixture();
    write(bare, "vage.config.ts", CONFIG);
    await expect(check(bare)).rejects.toThrow(/npm install --save-dev sharp/);

    const root = await site();
    fs.writeFileSync(path.join(root, "public/images/broken.png"), Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452000003e8000001f40806000000", "hex")]));
    write(root, "src/pages/broken.md", "---\ntitle: Broken\ndescription: Broken.\n---\n# Broken\n\n![Broken](/images/broken.png)\n");
    await expect(build(root)).rejects.toThrow(/Couldn't make a WebP copy of \/images\/broken\.png/);
  });
});

describe("image pipeline re-review fixes", () => {
  it("refuses images in symlinked folders", async () => {
    const root = await site();
    const outside = fs.mkdtempSync(path.join(path.dirname(root), "outside-"));
    fs.writeFileSync(path.join(outside, "o.jpg"), await jpeg(900, 600));
    fs.symlinkSync(outside, path.join(root, "public", "linked"), "dir");
    const never: Resize = async () => {
      throw new Error("should not be called");
    };
    expect(await imageVariants("/linked/o.jpg", root, { optimize: true, widths: [400], quality: 75, sizes: "100vw" }, never)).toBeUndefined();
  });

  it("labels srcset with the real width of rotated WebP files", async () => {
    const root = await site();
    const webp = await sharp({ create: { width: 1200, height: 600, channels: 3, background: "#208040" } }).webp().withMetadata({ orientation: 6 }).toBuffer();
    fs.writeFileSync(path.join(root, "public/images/turned.webp"), webp);
    const v = await imageVariants("/images/turned.webp", root, { optimize: true, widths: [400, 800, 1600], quality: 75, sizes: "100vw" }, await sharpResize(root));
    const labels = v!.srcset.split(", ").map((e) => Number(e.split(" ")[1]!.slice(0, -1)));
    expect(new Set(labels).size).toBe(labels.length);
    expect(v!.files.size).toBe(labels.length); // no duplicate, unused files
    for (const entry of v!.srcset.split(", ")) {
      const [url, w] = entry.split(" ");
      const meta = await sharp(v!.files.get(url!.slice(1))!).metadata();
      expect(`${meta.width}w`).toBe(w);
    }
  });
});

describe("AVIF copies (images.avif)", () => {
  async function avifSite() {
    const root = await site();
    write(root, "vage.config.ts", 'export default { site: "https://fixture.example", title: "Fixture Site", images: { optimize: true, avif: true, widths: [400, 800, 1600] } };');
    return root;
  }

  it("offers AVIF first through <picture>, with the same widths as the WebP fallback", async () => {
    const root = await avifSite();
    await build(root);
    const doc = new JSDOM(fs.readFileSync(path.join(root, "dist/gallery/index.html"), "utf8")).window.document;
    const photo = doc.querySelector('img[alt="A blue photo"]')!;
    const picture = photo.parentElement!;
    expect(picture.nodeName).toBe("PICTURE");
    const source = picture.querySelector("source")!;
    expect(source.getAttribute("type")).toBe("image/avif");
    expect(source.getAttribute("sizes")).toBe(photo.getAttribute("sizes"));
    const avif = source.getAttribute("srcset")!.split(", ");
    const webp = photo.getAttribute("srcset")!.split(", ");
    expect(avif.map((e) => e.split(" ")[1])).toEqual(webp.map((e) => e.split(" ")[1]));
    for (const entry of avif) {
      const [url, w] = entry.split(" ");
      expect(url).toMatch(/\.avif$/);
      const meta = await sharp(path.join(root, "dist", url!)).metadata();
      expect([meta.format, `${meta.width}w`]).toEqual(["heif", w]);
    }
    // Images vagejs didn't optimize stay plain <img>.
    expect(doc.querySelector('img[alt="Remote"]')!.parentElement!.nodeName).not.toBe("PICTURE");
  });

  it("keeps sanitizing page content on the AVIF path", async () => {
    const root = await avifSite();
    write(root, "src/pages/gallery.md", '---\ntitle: Gallery\ndescription: Photos.\n---\n# Gallery\n\n![A blue photo](/images/photo.jpg)\n\n<img src="/images/photo.jpg" onerror="alert(1)">\n\n<script>alert(2)</script>\n\n<a href="javascript:alert(3)">x</a>\n');
    await build(root);
    const html = fs.readFileSync(path.join(root, "dist/gallery/index.html"), "utf8");
    const main = /<body[\s\S]*<\/body>/.exec(html)![0];
    expect(main).toContain('type="image/avif"');
    expect(main).not.toMatch(/onerror|alert\(|javascript:/);
  });

  it("adds no <picture> when AVIF is off", async () => {
    const root = await site();
    await build(root);
    expect(fs.readFileSync(path.join(root, "dist/gallery/index.html"), "utf8")).not.toContain("<picture");
  });
});

describe("audit counts the images browsers download", () => {
  const imageBytes = (root: string) => measurePages(path.join(root, "dist"), [{ route: "/gallery/", outFile: "gallery/index.html" }])[0]!.bytes.image;
  const size = (root: string, url: string) => fs.statSync(path.join(root, "dist", url)).size;
  const largest = (srcset: string) => srcset.split(", ").at(-1)!.split(" ")[0]!;

  it("counts the largest WebP copy, not the original", async () => {
    const root = await site();
    await build(root);
    const doc = new JSDOM(fs.readFileSync(path.join(root, "dist/gallery/index.html"), "utf8")).window.document;
    const photo = doc.querySelector('img[alt="A blue photo"]')!;
    const logo = doc.querySelector('img[alt="Logo"]')!;
    const logoBytes = logo.getAttribute("srcset") ? size(root, largest(logo.getAttribute("srcset")!)) : size(root, logo.getAttribute("src")!);
    expect(imageBytes(root)).toBe(size(root, largest(photo.getAttribute("srcset")!)) + logoBytes);
    expect(imageBytes(root)).not.toBe(size(root, "/images/photo.jpg") + logoBytes);
  });

  it("counts the AVIF copy when images.avif is on", async () => {
    const root = await site();
    write(root, "vage.config.ts", 'export default { site: "https://fixture.example", title: "Fixture Site", images: { optimize: true, avif: true, widths: [400, 800, 1600] } };');
    await build(root);
    const doc = new JSDOM(fs.readFileSync(path.join(root, "dist/gallery/index.html"), "utf8")).window.document;
    const counted = [...doc.querySelectorAll("img")]
      .filter((img) => !/^https?:/.test(img.getAttribute("src") ?? ""))
      .map((img) => {
        const source = img.parentElement!.nodeName === "PICTURE" ? img.parentElement!.querySelector("source")!.getAttribute("srcset") : img.getAttribute("srcset");
        return size(root, source ? largest(source) : img.getAttribute("src")!);
      });
    expect(imageBytes(root)).toBe(counted.reduce((a, b) => a + b, 0));
    expect(doc.querySelector("source")!.getAttribute("srcset")).toMatch(/\.avif /);
  });
});
