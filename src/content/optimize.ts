import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "node-html-parser";
import { VageError } from "../core/errors.js";
import { insidePublic } from "../dev/guard.js";
import { imageSize } from "./images.js";

/**
 * Opt-in image pipeline (images.optimize): resized WebP copies of the images used in
 * page content, offered to browsers with srcset; with images.avif, AVIF copies too,
 * offered first through <picture>. Needs the `sharp` package in the
 * project. Results are cached in node_modules/.cache/vagejs/img, keyed by the file's
 * content and the settings, so unchanged images are never processed twice.
 */

export interface ImageOptions {
  optimize: boolean;
  widths: number[];
  quality: number;
  sizes: string;
  avif?: boolean;
}

export interface Variants {
  /** "url 480w, url 960w" (WebP) */
  srcset: string;
  /** The same widths as AVIF, when images.avif is on. */
  avifSrcset?: string;
  /** Published path (e.g. "_vage/img/photo-ab12cd34-480.webp") -> cached file on disk. */
  files: Map<string, string>;
}

/** Turns an image into WebP (or AVIF) at a given width. Injected in tests; sharp otherwise. */
export type Resize = (input: Buffer, width: number, quality: number, format?: "webp" | "avif") => Promise<Buffer>;

const RASTER = /\.(jpe?g|png|webp)$/i;
export const IMAGE_DIR = "_vage/img";

export function cacheDir(root: string): string {
  return path.join(root, "node_modules", ".cache", "vagejs", "img");
}

/** Loads sharp from the project (not from vagejs), with a clear message if it's missing. */
export async function sharpResize(root: string): Promise<Resize> {
  let resolved: string;
  try {
    resolved = createRequire(path.join(root, "package.json")).resolve("sharp");
  } catch {
    throw new VageError('images.optimize needs the "sharp" package. Install it with: npm install --save-dev sharp');
  }
  type Encoder = { toBuffer: () => Promise<Buffer> };
  const sharp = ((await import(pathToFileURL(resolved).href)) as { default: (input: Buffer) => { resize: (o: object) => { webp: (o: object) => Encoder; avif: (o?: object) => Encoder } } }).default;
  // rotate() applies EXIF orientation first, so phone photos aren't served sideways.
  // AVIF uses sharp's own default quality: its scale differs from WebP's, so images.quality would overshoot.
  return (input, width, quality, format = "webp") => {
    const resized = (sharp(input) as unknown as { rotate: () => ReturnType<typeof sharp> }).rotate().resize({ width, withoutEnlargement: true });
    return (format === "avif" ? resized.avif() : resized.webp({ quality })).toBuffer();
  };
}

/**
 * WebP variants for one site-path image in public/. Undefined for remote images,
 * non-raster formats (SVG, GIF), paths outside public/ and unreadable files.
 */
export async function imageVariants(src: string, root: string, options: ImageOptions, resize: Resize): Promise<Variants | undefined> {
  if (!/^\/(?!\/)/.test(src)) return undefined;
  let rel: string;
  try {
    rel = decodeURIComponent(src.split(/[?#]/)[0]!);
  } catch {
    return undefined;
  }
  if (!RASTER.test(rel)) return undefined;
  const publicDir = path.join(root, "public");
  const file = path.join(publicDir, rel);
  if (!file.startsWith(publicDir + path.sep)) return undefined;
  // Never follow symlinked files or folders: they can point outside the project.
  if (!insidePublic(file, publicDir)) return undefined;
  const size = imageSize(file);
  if (!size) return undefined;

  const input = fs.readFileSync(file);
  // "v2": variants are auto-rotated; older cached files (not rotated) must not be reused.
  const hash = createHash("sha256").update(input).update(`q${options.quality}|v2`).digest("hex").slice(0, 10);
  const slug = path.basename(rel).replace(RASTER, "").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  const base = /[a-z0-9]/i.test(slug) ? slug : "image";
  // Never upscale; include the original width when it's smaller than every configured width.
  const widths = [...new Set(options.widths.filter((w) => w < size.width).concat(size.width <= Math.max(...options.widths) ? [size.width] : []))].sort((a, b) => a - b);
  const dir = cacheDir(root);
  fs.mkdirSync(dir, { recursive: true });

  const files = new Map<string, string>();
  const srcsets: Partial<Record<"webp" | "avif", string>> = {};
  // Real widths, read from the WebP files; AVIF copies are resized the same way (vagejs can't read AVIF sizes).
  const realWidth = new Map<number, number>();
  for (const format of options.avif ? (["webp", "avif"] as const) : (["webp"] as const)) {
    const entries: string[] = [];
    for (const w of widths) {
      const name = `${base}-${hash}-${w}.${format}`;
      const cached = path.join(dir, name);
      if (!fs.existsSync(cached)) {
        const tmp = `${cached}.${process.pid}.tmp`;
        let data: Buffer;
        try {
          data = await resize(input, w, options.quality, format);
        } catch (err) {
          throw new VageError(`Couldn't make a ${format === "avif" ? "AVIF" : "WebP"} copy of ${src}: ${(err as Error).message}. Replace the file, or turn off ${format === "avif" ? "images.avif" : "images.optimize"}.`);
        }
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, cached);
      }
      // Label with the file's real width (rotation can change it); publish each width once.
      const actual = format === "webp" ? (imageSize(cached)?.width ?? w) : (realWidth.get(w) ?? w);
      if (format === "webp") realWidth.set(w, actual);
      if (entries.some((e) => e.endsWith(` ${actual}w`))) continue;
      files.set(`${IMAGE_DIR}/${name}`, cached);
      entries.push(`/${IMAGE_DIR}/${name} ${actual}w`);
    }
    if (entries.length) srcsets[format] = entries.join(", ");
  }
  return srcsets.webp ? { srcset: srcsets.webp, avifSrcset: srcsets.avif, files } : undefined;
}

/** Image sources used in rendered Markdown, read with an HTML parser (so entities decode like the DOM's). */
export function contentImageSources(html: string): string[] {
  return [...new Set(parse(html).querySelectorAll("img").map((img) => img.getAttribute("src")).filter((s): s is string => !!s))];
}
