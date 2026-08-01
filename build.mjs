/**
 * build.mjs — pre-render the portfolio into one real URL per language.
 *
 *   src/index.html     →  /index.html (de)  /en/index.html     /pl/index.html
 *   src/projects.html  →  /projects.html    /en/projects.html  /pl/projects.html
 *   + sitemap.xml, robots.txt
 *
 * WHY THIS EXISTS
 * The site used to be one English document that swapped its own text with JS. Google
 * indexes what is in the HTML, so the German and Polish versions did not exist as far
 * as search was concerned — an English page competing for German queries in Berlin.
 * Language is now a URL, and each URL ships its text already in place.
 *
 * HOW
 * The i18n code in src/ is the single source of truth for every string. Rather than
 * reimplementing it here, Playwright loads the page, calls the real setLang(), and we
 * serialise the result — so the generated text cannot drift from what the switcher does.
 * Post-processing then fixes what belongs to the URL rather than the language: paths,
 * canonical, hreflang, and the language switcher (buttons → real links).
 *
 * Run:  node build.mjs        (from portfolio/)
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, "src");
const ORIGIN = "https://clearsitestudio.de";

// Playwright is installed once, in the capture toolkit — it ships a browser build, so
// a second copy here would cost hundreds of MB for the same binary. Resolve it from
// there instead of adding a package.json to the portfolio repo.
const TOOLKIT = path.join(ROOT, "..", "prospects", "_toolkit");
// require(), not import() — playwright is CommonJS and its named exports do not survive
// ESM interop here (chromium comes back undefined).
const require = createRequire(path.join(TOOLKIT, "package.json"));
const { chromium } = require("playwright");

// German is the root: the market is Berlin, and / carries the most authority.
// `dir` is the output subdirectory, "" meaning the site root.
const LANGS = [
  { code: "de", dir: "", locale: "de_DE", switchLabel: "Sprache" },
  { code: "en", dir: "en", locale: "en_GB", switchLabel: "Language" },
  { code: "pl", dir: "pl", locale: "pl_PL", switchLabel: "Język" },
];

const PAGES = [
  { src: "index.html", out: "index.html", urlPath: "" },
  { src: "projects.html", out: "projects.html", urlPath: "projects.html" },
];

/** Public URL for a given language + page. */
const urlFor = (lang, page) =>
  `${ORIGIN}/${lang.dir ? lang.dir + "/" : ""}${page.urlPath}`;

/** Root-relative base for in-site links from a page in this language. */
const baseFor = (lang) => `/${lang.dir ? lang.dir + "/" : ""}`;

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Replace the content="" of a <meta> matched by `attr="value"`.
 * Returns the string unchanged (and warns) if the tag is not found, so a renamed meta
 * shows up as a warning at build time instead of silently shipping the English copy.
 */
function setMeta(html, attr, value, content) {
  const re = new RegExp(`(<meta[^>]*${attr}="${value}"[^>]*content=")[^"]*(")`);
  if (!re.test(html)) {
    console.warn(`  ! meta ${attr}="${value}" not found — left as-is`);
    return html;
  }
  return html.replace(re, `$1${esc(content)}$2`);
}

async function renderPage(browser, page, lang, dict) {
  const view = await browser.newPage();
  await view.goto(pathToFileURL(path.join(SRC, page.src)).href, { waitUntil: "load" });

  // Run the site's own switcher, then serialise what it produced.
  await view.evaluate((code) => setLang(code), lang.code);

  // The reveal-on-scroll observer marks whatever happened to be in the headless
  // viewport. Strip it so every generated page starts from the same state and the
  // animation still runs for a real visitor.
  await view.evaluate(() => {
    document.querySelectorAll(".reveal.in").forEach((el) => el.classList.remove("in"));
  });

  let html = await view.evaluate(() => document.documentElement.outerHTML);
  await view.close();

  const self = urlFor(lang, page);
  const base = baseFor(lang);

  // ---- strip the i18n runtime -------------------------------------------------
  // Language is a URL now. If this stayed, its localStorage/navigator.language
  // detection would re-translate the page after paint — a German visitor could land
  // on /pl/ and watch it turn German, with Google seeing something else again.
  html = html.replace(/<!--\s*i18n[\s\S]*?-->\s*/g, "");
  html = html.replace(/\s*<script id="i18n">[\s\S]*?<\/script>/, "");
  if (/setLang\(initial\)/.test(html)) {
    throw new Error(`${page.src}/${lang.code}: i18n script was not stripped`);
  }

  // ---- in-site paths become root-absolute -------------------------------------
  // The same markup is served from /, /en/ and /pl/, so relative paths would resolve
  // to /en/assets/... and 404. This includes the preview-video src built in JS.
  html = html
    .replace(/(href|src)="assets\//g, '$1="/assets/')
    .replace(/"assets\/preview\/"/g, '"/assets/preview/"')
    .replace(/href="index\.html#/g, `href="${base}#`)
    .replace(/href="index\.html"/g, `href="${base}"`)
    .replace(/href="projects\.html"/g, `href="${base}projects.html"`)
    .replace(new RegExp(`href="${ORIGIN}/projects\\.html"`, "g"), `href="${base}projects.html"`)
    .replace(/href="(impressum|datenschutz)\.html"/g, 'href="/$1.html"');

  // Impressum and Datenschutz stay single German documents at the root — they are
  // legal texts for one German business, not content to translate per locale.

  // ---- head: identity of THIS url ---------------------------------------------
  html = html.replace(
    /<link rel="canonical" href="[^"]*">/,
    () => {
      const alts = LANGS.map(
        (l) => `\n  <link rel="alternate" hreflang="${l.code}" href="${urlFor(l, page)}">`
      ).join("");
      return (
        `<link rel="canonical" href="${self}">` +
        alts +
        `\n  <link rel="alternate" hreflang="x-default" href="${urlFor(LANGS[0], page)}">`
      );
    }
  );

  html = setMeta(html, "name", "description", dict._desc);
  html = setMeta(html, "property", "og:url", self);
  html = setMeta(html, "property", "og:title", dict._title);
  html = setMeta(html, "property", "og:description", dict._ogDesc || dict._desc);

  // og:locale — one for this page, the rest declared as alternates.
  const locales =
    `<meta property="og:locale" content="${lang.locale}">` +
    LANGS.filter((l) => l.code !== lang.code)
      .map((l) => `\n  <meta property="og:locale:alternate" content="${l.locale}">`)
      .join("");
  html = html.replace(/<meta property="og:type"[^>]*>/, (m) => `${m}\n  ${locales}`);

  // ---- JSON-LD ----------------------------------------------------------------
  // One business, three pages. A stable @id keeps the three language versions
  // pointing at the SAME entity instead of reading as three separate companies.
  html = html
    .replace(
      /("@type": "ProfessionalService",)/,
      `$1\n    "@id": "${ORIGIN}/#business",`
    )
    .replace(
      /("description": ")[^"]*(")/,
      (_m, a, b) => `${a}${esc(dict._desc)}${b}`
    )
    .replace(
      /("knowsLanguage": \[[^\]]*\])/,
      `$1,\n    "inLanguage": "${lang.code}"`
    );

  // ---- language switcher: buttons → real links --------------------------------
  // A <button> is invisible to a crawler and cannot be followed. These are the links
  // that let Google discover the other two language versions in the first place.
  const links = LANGS.map((l) => {
    const cls = l.code === lang.code ? ' class="active"' : "";
    const cur = l.code === lang.code ? ' aria-current="page"' : "";
    return `\n        <a href="${urlFor(l, page).replace(ORIGIN, "")}" hreflang="${l.code}"${cls}${cur}>${l.code.toUpperCase()}</a>`;
  }).join("");
  const switcher = `<div class="lang-switch" role="group" aria-label="${lang.switchLabel}">${links}\n      </div>`;
  const before = html;
  html = html.replace(/<div class="lang-switch"[\s\S]*?<\/div>/, switcher);
  if (html === before) throw new Error(`${page.src}/${lang.code}: language switcher not found`);

  // ---- banner ------------------------------------------------------------------
  html =
    `<!DOCTYPE html>\n<!--\n  GENERATED FILE — do not edit.\n` +
    `  Source: src/${page.src}   Rebuild: node build.mjs   (edits here are erased)\n-->\n` +
    html +
    "\n";

  const outDir = path.join(ROOT, lang.dir);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, page.out), html, "utf8");
  return { url: self, bytes: Buffer.byteLength(html) };
}

async function writeSitemap(entries) {
  const today = new Date().toISOString().slice(0, 10);

  // Every URL carries the full alternates cluster, including a self-reference —
  // Google treats an entry without one as an incomplete cluster and may ignore it.
  const urls = PAGES.map((page) =>
    LANGS.map((lang) => {
      const alts = LANGS.map(
        (l) => `    <xhtml:link rel="alternate" hreflang="${l.code}" href="${urlFor(l, page)}"/>`
      ).join("\n");
      return [
        "  <url>",
        `    <loc>${urlFor(lang, page)}</loc>`,
        alts,
        `    <xhtml:link rel="alternate" hreflang="x-default" href="${urlFor(LANGS[0], page)}"/>`,
        `    <lastmod>${today}</lastmod>`,
        "  </url>",
      ].join("\n");
    }).join("\n")
  ).join("\n");

  const legal = ["impressum.html", "datenschutz.html"]
    .map((f) => `  <url>\n    <loc>${ORIGIN}/${f}</loc>\n    <lastmod>${today}</lastmod>\n  </url>`)
    .join("\n");

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
    `        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
    `${urls}\n${legal}\n</urlset>\n`;

  await fs.writeFile(path.join(ROOT, "sitemap.xml"), xml, "utf8");
  return entries.length + 2;
}

async function writeRobots() {
  const txt = [
    "User-agent: *",
    "Allow: /",
    "",
    "# Outreach demos. These are landing pages built FOR other businesses — some of them",
    "# real companies that never asked to appear on this domain, some fictional vertical",
    "# kits. They must keep returning 200 because sent outreach links point at them, but",
    "# they should not be indexed as content about ClearSite Studio. The demos also carry",
    "# their own noindex meta tag; this is the belt to that pair of braces.",
    "Disallow: /demo/",
    "",
    `Sitemap: ${ORIGIN}/sitemap.xml`,
    "",
  ].join("\n");
  await fs.writeFile(path.join(ROOT, "robots.txt"), txt, "utf8");
}

// Same launch strategy as capture.mjs: the system Chrome first, because this machine
// has no ms-playwright browser download and adding one costs ~150 MB for nothing.
async function launch() {
  for (const opts of [{ channel: "chrome" }, {}]) {
    try {
      const b = await chromium.launch(opts);
      console.log(`browser: ${opts.channel ? "system chrome" : "bundled chromium"}\n`);
      return b;
    } catch (e) {
      if (opts.channel) continue;
      throw e;
    }
  }
}

const browser = await launch();
const built = [];
for (const page of PAGES) {
  for (const lang of LANGS) {
    // projects.html has its own dictionary; read it from the page being rendered.
    const view = await browser.newPage();
    await view.goto(pathToFileURL(path.join(SRC, page.src)).href, { waitUntil: "load" });
    const pageDicts = await view.evaluate(() => I18N);
    await view.close();

    const dict = pageDicts[lang.code];
    if (!dict?._desc) throw new Error(`${page.src}: missing _desc for "${lang.code}"`);

    const r = await renderPage(browser, page, lang, dict);
    console.log(`  ✓ ${r.url.padEnd(48)} ${(r.bytes / 1024).toFixed(1)} KB`);
    built.push(r);
  }
}
await browser.close();

const n = await writeSitemap(built);
await writeRobots();
console.log(`\n  sitemap.xml — ${n} urls`);
console.log("  robots.txt");
console.log(`\nBuilt ${built.length} pages. Sources live in src/ — never edit the generated ones.`);
