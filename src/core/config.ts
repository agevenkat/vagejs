import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { VageError } from "./errors.js";
import { ruleData } from "../guidelines/pack.js";

export const CONFIG_FILES = ["vage.config.ts", "vage.config.js", "vage.config.mjs"];

/** `true` -> defaults, `false` -> disabled, object -> options. */
function toggle<T extends z.ZodType>(options: T) {
  return z
    .union([z.boolean(), options])
    .default(true)
    .transform((v): z.output<T> | false => (v === true ? options.parse({}) : v === false ? false : (v as z.output<T>)));
}

// No whitespace or control characters: these values become robots.txt lines and output paths.
const token = z.string().min(1).regex(/^[^\s\u0000-\u001f\u007f]+$/, "must not contain spaces or line breaks");
const userAgents = z.union([token, z.array(token).min(1)]);
const urlPath = token.regex(/^\//, 'must start with "/"');
/** Redirect source: a site path without ".." segments (it becomes a file path under dist/). */
const redirectSource = urlPath.refine((p) => !p.split("/").some((seg) => seg === ".." || seg === "."), 'must not contain "." or ".." segments');
/** Redirect target: a site path ("/x", not "//host") or an absolute http(s) URL. */
const redirectTarget = token.regex(/^(\/(?!\/)|https?:\/\/)/, 'must be a site path starting with a single "/" or an http(s) URL');

const robotsSchema = z.strictObject({
  rules: z
    .array(
      z.strictObject({
        userAgent: userAgents,
        allow: z.array(urlPath).default([]),
        disallow: z.array(urlPath).default([]),
      }),
    )
    .default([])
    .describe("Explicit robots.txt groups, written in order."),
  aiTraining: z
    .enum(["allow", "disallow"])
    .optional()
    .describe("Groups for documented AI training crawlers (GPTBot, ClaudeBot, Google-Extended, Applebot-Extended). Google-Extended also covers grounding in Gemini Apps and Vertex AI. Unset: the * group applies."),
  aiSearch: z
    .enum(["allow", "disallow"])
    .optional()
    .describe("Groups for documented AI search crawlers (OAI-SearchBot, Claude-SearchBot, PerplexityBot). Unset: the * group applies."),
});

const seoSchema = z.strictObject({
  robots: toggle(robotsSchema).describe("Generate robots.txt (true/false or options)."),
  feeds: z
    .array(
      z.strictObject({
        under: z.string().regex(/^\/(?:[\w-]+\/)*$/, 'must be a section path like "/blog/" (letters, digits, "_" and "-")').describe("Section whose pages the feed lists."),
        title: z.string().min(1).optional().describe("Feed title. Defaults to the section page's title."),
        description: z.string().min(1).optional().describe("Feed description. Defaults to the section page's description."),
        limit: z.number().int().min(1).max(500).default(20).describe("Most recent pages to include."),
      }),
    )
    .default([])
    .describe('RSS feeds, e.g. [{ under: "/blog/" }] writes /blog/feed.xml (needs `site`). Pages in the section link to it.'),
  lastmod: z
    .enum(["frontmatter", "git"])
    .default("frontmatter")
    .describe('Where sitemap <lastmod> dates come from: "frontmatter" (dateModified/datePublished) or "git" (each page\'s last commit; dateModified still wins). Git dates are skipped in shallow clones.'),
  markdownCopies: z.boolean().default(false).describe("Also publish each listed page as Markdown at /<path>.md (e.g. /docs/cli.md), linked from the page, for AI tools."),
  sitemap: z.boolean().default(true).describe("Generate sitemap.xml (needs `site`)."),
  llmsTxt: toggle(
    z.strictObject({
      full: z.boolean().default(false).describe("Also emit llms-full.txt with the Markdown of every listed page."),
    }),
  ).describe("Generate llms.txt (needs `title`)."),
  structuredData: toggle(
    z.strictObject({
      organization: z
        .strictObject({
          name: z.string().min(1),
          url: z.url().optional(),
          logo: z.string().min(1).optional(),
          sameAs: z.array(z.url()).optional(),
        })
        .optional()
        .describe("Organization JSON-LD on the home page. Only true, visible facts."),
    }),
  ).describe("Automatic JSON-LD (WebSite, Organization, Article)."),
});

const score = z.number().int().min(0).max(100);
const kb = z.number().positive();

const budgetsSchema = z.strictObject({
  performance: score.default(90).describe("Minimum Lighthouse performance score (lab)."),
  accessibility: score.default(95).describe("Minimum Lighthouse accessibility score (lab)."),
  seo: score.default(95).describe("Minimum Lighthouse SEO score (lab)."),
  bestPractices: score.default(90).describe("Minimum Lighthouse best-practices score (lab)."),
  javascriptKb: kb.default(100).describe("Max uncompressed JavaScript per page, KB."),
  cssKb: kb.default(50).describe("Max uncompressed CSS per page, KB."),
  imageKb: kb.default(500).describe("Max image bytes per page, KB."),
  fontKb: kb.default(150).describe("Max font bytes per page, KB."),
  totalKb: kb.default(1000).describe("Max total local bytes per page, KB."),
  requests: z.number().int().positive().default(30).describe("Max resource requests per page (incl. the HTML)."),
});

const performanceSchema = z.strictObject({
  budgets: budgetsSchema.default(() => budgetsSchema.parse({})).describe("Starting points, not universal standards. Adjust per site."),
  lighthouse: z
    .strictObject({
      enabled: z.boolean().default(false).describe("Run Lighthouse in `vage audit` without --lighthouse. Needs the lighthouse package and Chrome."),
      pages: z.array(z.string().regex(/^\//)).min(1).default(["/"]).describe("Routes to audit with Lighthouse."),
    })
    .default({ enabled: false, pages: ["/"] }),
});

// GA4 naming rules and limits: rule pack "ga4.naming".
const GA4 = ruleData<{ maxNameLength: number; reservedParamPrefixes: string[] }>("ga4.naming");
const ga4Name = z
  .string()
  .max(GA4.maxNameLength)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "must start with a letter and use only letters, numbers and underscores");
const ga4Param = ga4Name.refine((p) => !GA4.reservedParamPrefixes.some((prefix) => p.startsWith(prefix)), "uses a reserved prefix");

/** Event map whose keys are validated with GA4 naming rules (record keys alone give unhelpful errors). */
const ga4Events = z.record(z.string(), z.strictObject({ params: z.array(ga4Param).default([]) })).superRefine((events, ctx) => {
  for (const name of Object.keys(events)) {
    const result = ga4Name.safeParse(name);
    if (!result.success) ctx.addIssue({ code: "custom", path: [name], message: `event name "${name}" ${result.error.issues[0]!.message}` });
  }
});

const consentDefault = z
  .enum(["denied", "granted"])
  .default("denied")
  .describe("Consent mode default for analytics/ads storage before the visitor chooses. Your site provides the consent UI.");

/** A tracking snippet pasted from the provider's dashboard; inserted verbatim into <head>. */
const snippet = z
  .string()
  .max(5000)
  .refine((v) => /<script[\s>]/i.test(v), "must be the <script> snippet from the provider's dashboard")
  .refine((v) => !/googletagmanager\.com/.test(v), "Google tags belong in integrations.ga4 or integrations.gtm");

const INDEXNOW = ruleData<{ endpoint: string; keyPattern: string }>("indexnow.protocol");

const integrationsSchema = z
  .strictObject({
    ga4: z
      .strictObject({
        measurementId: z
          .string()
          .regex(/^G-[A-Z0-9]+$/, 'must look like "G-XXXXXXX"')
          .optional()
          .describe("GA4 web stream measurement ID (public). Tags are added only when set, e.g. process.env.GA4_MEASUREMENT_ID."),
        propertyId: z.string().regex(/^\d+$/, "must be the numeric GA4 property ID").optional().describe("Numeric property ID for `vage report analytics`."),
        consentDefault,
        events: ga4Events
          .default({})
          .describe('Allowed custom events for data-vage-event attributes, e.g. { signup_click: { params: ["plan"] } }.'),
      })
      .optional(),
    gtm: z
      .strictObject({
        containerId: z.string().regex(/^GTM-[A-Z0-9]+$/, 'must look like "GTM-XXXXXX"').optional().describe("Google Tag Manager container ID."),
        consentDefault,
        events: ga4Events.default({}),
      })
      .optional(),
    plausible: z
      .strictObject({
        snippet: snippet.describe("Your site's script snippet from Plausible (Site settings → Site installation)."),
        events: z
          .record(z.string().min(1).max(120), z.strictObject({ params: z.array(z.string().min(1)).default([]) }))
          .default({})
          .describe("Custom events for data-vage-event, sent with plausible(name, { props })."),
      })
      .optional(),
    clarity: z
      .strictObject({
        snippet: snippet.describe("Tracking code from Clarity (Settings → Setup → Install manually)."),
      })
      .optional()
      .describe("Microsoft Clarity. window.vageConsent.update() also sends Clarity's consentv2 signal."),
    indexNow: z
      .strictObject({
        key: z.string().regex(new RegExp(INDEXNOW.keyPattern), "must be 8-128 characters: letters, digits or dashes").describe("Public IndexNow key; served as /<key>.txt."),
        endpoint: z.url().default(INDEXNOW.endpoint).describe("IndexNow endpoint (default: the shared api.indexnow.org)."),
      })
      .optional(),
    searchConsole: z
      .strictObject({
        property: z
          .string()
          .regex(/^(sc-domain:[^/\s]+|https?:\/\/\S+\/)$/, 'must be "sc-domain:example.com" or a URL prefix ending in "/"')
          .optional()
          .describe("Search Console property for `vage report search`."),
      })
      .optional(),
  })
  .refine((i) => !(i.ga4?.measurementId && i.gtm?.containerId), {
    message: "Configure GA4 directly (ga4.measurementId) or through Tag Manager (gtm.containerId), not both: loading both double-counts.",
  });

export const configSchema = z.strictObject({
  site: z
    .url({ protocol: /^https?$/ })
    .refine((s) => new URL(s).pathname === "/", "must be an origin without a path (base paths are not supported yet)")
    .transform((s) => new URL(s).origin)
    .optional()
    .describe("Production origin, e.g. https://example.com. Needed for canonical URLs and sitemap.xml."),
  title: z.string().min(1).optional().describe("Site name: page titles, og:site_name, llms.txt heading."),
  description: z.string().min(1).optional().describe("Fallback meta description; llms.txt summary."),
  lang: z.string().min(1).default("en").describe("<html lang> value."),
  images: z
    .strictObject({
      optimize: z.boolean().default(false).describe('Make resized WebP copies of images in page content and offer them with srcset. Needs "sharp" in the project (npm install --save-dev sharp).'),
      widths: z.array(z.number().int().min(16).max(8000)).min(1).max(8).default([480, 960, 1600]).describe("Widths to generate (never larger than the original)."),
      quality: z.number().int().min(1).max(100).default(75).describe("WebP quality."),
      avif: z.boolean().default(false).describe("Also make AVIF copies (usually smaller than WebP, slower to make) and offer both with <picture>: browsers that support AVIF use it, others use WebP."),
      sizes: z.string().regex(/^[^<>"]+$/).default("(max-width: 48rem) 100vw, 48rem").describe('The sizes attribute: how wide images display, so browsers pick the right file.'),
    })
    .default({ optimize: false, widths: [480, 960, 1600], quality: 75, avif: false, sizes: "(max-width: 48rem) 100vw, 48rem" }),
  markdown: z
    .strictObject({
      html: z
        .enum(["sanitize", "allow"])
        .default("sanitize")
        .describe('"sanitize" removes scripts, event handlers, javascript: URLs, iframes and forms from page content. "allow" trusts all content authors.'),
      inlineStyles: z
        .boolean()
        .default(false)
        .describe('Keep style="..." attributes in page content (sanitize mode). Off by default: inline styles are the usual way to hide spam links. Put styling in layouts.'),
    })
    .default({ html: "sanitize", inlineStyles: false }),
  seo: seoSchema.default(() => seoSchema.parse({})),
  performance: performanceSchema.default(() => performanceSchema.parse({})),
  deploy: z
    .strictObject({
      target: z
        .enum(["github-pages", "cloudflare-pages", "cloudflare-workers"])
        .default("github-pages")
        .describe("Host used by `vage deploy`. Cloudflare now creates new sites as Workers: prefer cloudflare-workers there."),
      cloudflareProject: z.string().regex(/^[a-z0-9][a-z0-9-]{0,57}$/).optional().describe("Cloudflare Pages project name."),
      cloudflareWorker: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
        .optional()
        .describe("Cloudflare Worker name (cloudflare-workers target, when the project has no wrangler config). Defaults to cloudflareProject."),
    })
    .default({ target: "github-pages" }),
  security: z
    .strictObject({
      headers: z.boolean().default(true).describe("Write a _headers file with security headers (Cloudflare targets)."),
      csp: z
        .enum(["enforce", "report-only", "off"])
        .default("enforce")
        .describe("Content Security Policy generated from the built pages: hashes of inline scripts/styles plus the origins your layouts and analytics load."),
      cspSources: z
        .partialRecord(
          z.enum(["script-src", "style-src", "img-src", "font-src", "connect-src", "frame-src", "media-src"]),
          z.array(z.string().regex(/^('[a-z0-9-]+'|https?:\/\/[^\s;,']+|[a-z]+:)$/, "must be a source like https://cdn.example.com or 'self'")),
        )
        .default({})
        .describe("Extra sources per directive, e.g. { \"connect-src\": [\"https://api.example.com\"] }."),
      outboundLinks: z
        .enum(["require", "lock", "off"])
        .default("lock")
        .describe('"lock": when links.lock.json exists, every external domain the site links to must be listed there (approve with `vage links approve`); new domains fail `vage check`. Catches injected spam links. "require": the same, and a missing links.lock.json is an error, so deleting it can\'t switch the guard off. "off": no guard.'),
      spamPatterns: z.boolean().default(true).describe("Warn in `vage check` about common spam words (casino, pills, payday loans...) in page text and links."),
    })
    .default({ headers: true, csp: "enforce", cspSources: {}, outboundLinks: "lock", spamPatterns: true }),
  guidelines: z
    .strictObject({
      rulePack: z
        .string()
        .regex(/^\d{4}\.\d{1,2}\.\d+$/)
        .optional()
        .describe("Pin the rule-pack version. Builds fail when the installed vagejs ships a different pack, until you review its changelog and update the pin."),
    })
    .default({}),
  integrations: integrationsSchema.default({}).describe("Optional analytics and search integrations. All off unless configured."),
  redirects: z
    .record(z.string(), redirectTarget)
    .superRefine((redirects, ctx) => {
      for (const from of Object.keys(redirects)) {
        const result = redirectSource.safeParse(from);
        if (!result.success) ctx.addIssue({ code: "custom", path: [from], message: `redirect source "${from}" ${result.error.issues[0]!.message}` });
      }
    })
    .default({})
    .describe("Old path -> new path or URL. Built as noindex meta-refresh pages; dev answers 301."),
});

export type UserConfig = z.input<typeof configSchema>;
export type SiteConfig = z.output<typeof configSchema>;

/** Identity helper that gives config files type checking. */
export function defineConfig(config: UserConfig): UserConfig {
  return config;
}

export function findConfigFile(root: string): string | undefined {
  return CONFIG_FILES.map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
}

export type ModuleLoader = (file: string) => Promise<Record<string, unknown>>;

export async function loadConfig(root: string, load: ModuleLoader): Promise<SiteConfig> {
  const file = findConfigFile(root);
  return parseConfig(file ? (await load(file)).default : {}, file);
}

/** Validates a raw config object and applies defaults. */
export function parseConfig(raw: unknown, file?: string): SiteConfig {
  const result = configSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new VageError(`Invalid config:\n${z.prettifyError(result.error)}`, file);
  }
  return result.data;
}
