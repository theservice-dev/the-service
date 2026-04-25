#!/usr/bin/env node
// One-off: pull images from shakawear.com/collections/t-shirts onto every
// product in the store whose title contains "Shaka", and tag with "tmp".
// See README.md for setup. Defaults to dry-run; pass --apply to mutate.

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- Config ----------
// Shakawear has /products.json and /products/<handle>.json disabled (404),
// so we scrape the public HTML: collection page for handles, product page
// for title + images (parsed out of the JSON-LD block).
const SOURCE_COLLECTION_URL = 'https://www.shakawear.com/collections/t-shirts';
const SOURCE_MAX_PAGES = 10;
const SOURCE_PRODUCT_CONCURRENCY = 3;
const SOURCE_PRODUCT_DELAY_MS = 200;
const USER_AGENT =
  'Mozilla/5.0 (compatible; the-service-script/1.0; +https://the-service.local)';
const STORE_TITLE_QUERY = 'title:*Shaka*';
const MATCH_THRESHOLD_DEFAULT = 0.55;
const THROTTLE_MS = 250;
const MAX_RETRIES = 1;
const TAG = 'tmp';

// ---------- CLI flags ----------
const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const SOURCE_ONLY = args.has('--source-only');
const thresholdArg = [...args].find((a) => a.startsWith('--threshold='));
const limitArg = [...args].find((a) => a.startsWith('--limit='));
const MATCH_THRESHOLD = thresholdArg
  ? Number(thresholdArg.split('=')[1])
  : MATCH_THRESHOLD_DEFAULT;
const STORE_LIMIT = limitArg ? Number(limitArg.split('=')[1]) : Infinity;

// ---------- Logging ----------
const runStart = new Date();
const stamp = runStart.toISOString().replace(/[:.]/g, '-');
const logDir = resolve(__dirname, 'logs');
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
const logPath = resolve(logDir, `run-${stamp}.log`);

function log(level, event, data = {}) {
  const entry = { ts: new Date().toISOString(), level, event, ...data };
  const line = JSON.stringify(entry);
  appendFileSync(logPath, line + '\n');
  const pretty = `[${level}] ${event}` + (Object.keys(data).length ? ` ${JSON.stringify(data)}` : '');
  if (level === 'error') console.error(pretty);
  else console.log(pretty);
}

// ---------- Env ----------
const { SHOPIFY_STORE, SHOPIFY_ADMIN_TOKEN } = process.env;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';
if (!SOURCE_ONLY) {
  if (!SHOPIFY_STORE || !SHOPIFY_ADMIN_TOKEN) {
    console.error(
      'Missing SHOPIFY_STORE or SHOPIFY_ADMIN_TOKEN. Copy scripts/.env.example to scripts/.env and fill in values.'
    );
    process.exit(1);
  }
  if (SHOPIFY_STORE === 'your-store.myshopify.com' || /^shpat_x+$/i.test(SHOPIFY_ADMIN_TOKEN)) {
    console.error(
      'scripts/.env still has placeholder values. Edit scripts/.env and set SHOPIFY_STORE (e.g. my-store.myshopify.com) and a real SHOPIFY_ADMIN_TOKEN (shpat_...).'
    );
    process.exit(1);
  }
  if (!/\.myshopify\.com$/i.test(SHOPIFY_STORE)) {
    console.error(
      `SHOPIFY_STORE must be the *.myshopify.com domain, not a custom domain. Got: ${SHOPIFY_STORE}`
    );
    process.exit(1);
  }
}
const GRAPHQL_URL = SHOPIFY_STORE
  ? `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`
  : null;

// ---------- Utilities ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[_\-/]/g, ' ')
    .replace(/\bounces?\b/g, 'oz')
    .replace(/(\d+(?:\.\d+)?)\s*oz\b/g, '$1oz')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Sørensen–Dice coefficient over character bigrams.
function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bigrams = (s) => {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let intersection = 0;
  for (const [g, ca] of A) {
    const cb = B.get(g);
    if (cb) intersection += Math.min(ca, cb);
  }
  const total = [...A.values()].reduce((s, n) => s + n, 0) + [...B.values()].reduce((s, n) => s + n, 0);
  return total === 0 ? 0 : (2 * intersection) / total;
}

// ---------- HTTP ----------
async function fetchText(url, { retries = MAX_RETRIES } = {}) {
  let attempt = 0;
  while (true) {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' },
      redirect: 'follow',
    });
    if (res.status === 429 && attempt < retries) {
      const wait = Number(res.headers.get('retry-after') || 2) * 1000;
      log('warn', 'http_throttled', { url, wait });
      await sleep(wait);
      attempt++;
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText} at ${url}: ${body.slice(0, 300)}`);
    }
    return res.text();
  }
}

async function graphql(query, variables = {}) {
  let attempt = 0;
  while (true) {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const wait = Number(res.headers.get('retry-after') || 2) * 1000;
      log('warn', 'graphql_throttled', { wait });
      await sleep(wait);
      attempt++;
      continue;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.errors) {
      throw new Error(`GraphQL error: ${JSON.stringify(json.errors || json)}`);
    }
    const throttled = (json.extensions?.cost?.throttleStatus?.currentlyAvailable ?? 1000) < 100;
    if (throttled) await sleep(500);
    return json.data;
  }
}

// ---------- Source catalog (shakawear.com, HTML scrape) ----------
// Shakawear has /products.json and per-product .json endpoints disabled, so
// we parse the rendered HTML. Product handles come from the collection page;
// each product's JSON-LD <script> block has { name, image: [...] }.

function extractProductHandles(html) {
  const handles = new Set();
  const re = /href=["']\/products\/([a-z0-9][a-z0-9-]*)(?:[?#"'/][^"']*)?["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const handle = m[1];
    if (handle && !handle.includes('.') && handle.length < 120) handles.add(handle);
  }
  return [...handles];
}

function extractJsonLdProducts(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const nodes = Array.isArray(parsed) ? parsed : [parsed];
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const type = node['@type'];
      const isProduct = type === 'Product' || (Array.isArray(type) && type.includes('Product'));
      if (isProduct) out.push(node);
    }
  }
  return out;
}

// Shopify CDN size suffixes like `_400x.jpg` or `_400x500_crop_center.jpg`
// are rewritten back to the master image for best quality.
function stripShopifySize(url) {
  if (typeof url !== 'string') return url;
  let clean = url.startsWith('//') ? `https:${url}` : url;
  clean = clean.replace(/_(\d+x\d*|\d*x\d+)(_crop_[a-z]+)?(?=\.(?:jpg|jpeg|png|webp|gif))/i, '');
  return clean.split('?')[0];
}

// Keep only the part of the HTML above the "related / recommendation" section.
// Shakawear places gallery images in the first ~1/4 of the document and
// cross-sell carousels (with other products' images) after these markers.
function scopeToGallerySection(html) {
  // Boundaries where cross-sell carousels (other products' images) begin.
  // Keep this list conservative: "shop the look" / "complete the look" can
  // appear inside product galleries as styling notes, so they're excluded.
  const boundaries = [
    'recommendation',
    'you may also',
    'related products',
    'also bought',
    'frequently bought',
    'pairs well',
  ];
  let cut = html.length;
  const lower = html.toLowerCase();
  for (const b of boundaries) {
    const i = lower.indexOf(b);
    if (i > 0 && i < cut) cut = i;
  }
  return html.slice(0, cut);
}

function isObviousNonGalleryImage(url) {
  const filename = (url.split('/').pop() || '').toLowerCase();
  if (!filename) return true;
  // Pure brand chrome / UI assets. Note we deliberately avoid a blanket "logo"
  // prefix match: Shakawear names some lifestyle shots like
  // `logo_thermal_white_001.jpg`, which are valid product images.
  if (/^(color-?swatch|favicon|sprite|placeholder|shape[-_]|banner[-_]|hero[-_])/i.test(filename)) return true;
  if (/^(logo|icon|social)[.-]/i.test(filename)) return true;
  if (/(favicon|sprite|placeholder)/i.test(filename)) return true;
  return false;
}

function normalizeFilenameKey(url) {
  const file = (url.split('/').pop() || '').toLowerCase();
  // Drop the 36-char UUID tail Shopify appends to duplicate uploads plus the
  // extension; leaves the human-readable descriptor for comparison.
  return file
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, '')
    .replace(/[^a-z0-9]/g, '');
}

// Longest common substring length between two strings. O(n*m) with rolling rows.
function longestCommonSubstring(a, b) {
  if (!a || !b) return 0;
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  let max = 0;
  let prev = new Uint32Array(m + 1);
  let curr = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) {
        curr[j] = prev[j - 1] + 1;
        if (curr[j] > max) max = curr[j];
      } else {
        curr[j] = 0;
      }
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }
  return max;
}

function extractImagesFromProductHtml(html, handle) {
  const scope = scopeToGallerySection(html);
  const images = new Set();
  const primaries = []; // URLs trusted as on-topic; also drive the LCS filter.

  const pushPrimary = (v) => {
    if (typeof v !== 'string' || !v) return;
    const clean = stripShopifySize(v);
    images.add(clean);
    primaries.push(clean);
  };

  // 1) JSON-LD Product images — the most authoritative set on the page.
  for (const p of extractJsonLdProducts(scope)) {
    const img = p.image;
    if (Array.isArray(img)) img.forEach((u) => (typeof u === 'string' ? pushPrimary(u) : pushPrimary(u?.url)));
    else if (typeof img === 'string') pushPrimary(img);
    else if (img && typeof img === 'object') pushPrimary(img.url);
  }

  // 2) og:image for pages where the primary image isn't in JSON-LD.
  const og = scope.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i);
  if (og && og[1]) pushPrimary(og[1]);

  // Build two independent references for the LCS filter:
  // - handleKey: normalized product handle (e.g. "75ozmaxheavyweightshortsleeve")
  // - primaryKey: longest normalized primary filename we found
  // A candidate passes if it matches EITHER reference well enough. This keeps
  // coverage high when one reference is weak (short handle / noisy primary).
  const handleKey = String(handle || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const primaryKey =
    primaries
      .map(normalizeFilenameKey)
      .filter((k) => k.length >= 18)
      .sort((a, b) => b.length - a.length)[0] || '';
  // Distinctive portion of the handle: strip leading generic tokens
  // ("heavyweight", ounce sizing, numbers) so "oversized-tee" beats the noisy
  // shared stem "max-heavyweight". Used as a substring filter because it's
  // short enough that an LCS threshold would drop it.
  const genericTokens = new Set(['max', 'heavy', 'heavyweight', 'weight', 'oz', 'g']);
  const handleTokens = String(handle || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let skip = 0;
  while (
    skip < handleTokens.length &&
    (genericTokens.has(handleTokens[skip]) || /^\d+(oz|g)?$/.test(handleTokens[skip]))
  ) {
    skip++;
  }
  const distinctiveSuffix = handleTokens.slice(skip).join('');
  const useSuffix = distinctiveSuffix.length >= 6;

  const MIN_LCS = 15;
  const hasReference = handleKey.length >= 12 || !!primaryKey || useSuffix;
  const cdnRe = /https?:\/\/(?:[a-z0-9-]+\.)?(?:cdn\.shopify\.com|shakawear\.com\/cdn)\/s\/files\/[^\s"'<>]+?\.(?:jpg|jpeg|png|webp)/gi;
  const candidates = [];
  const kept = [];
  let m;
  while ((m = cdnRe.exec(scope)) !== null) {
    const url = stripShopifySize(m[0]);
    if (isObviousNonGalleryImage(url)) continue;
    candidates.push(url);
    if (!hasReference) {
      kept.push(url);
      continue;
    }
    const key = normalizeFilenameKey(url);
    const passesSuffix = useSuffix && key.includes(distinctiveSuffix);
    const vsHandle = handleKey.length >= 12 ? longestCommonSubstring(key, handleKey) : 0;
    const vsPrimary = primaryKey ? longestCommonSubstring(key, primaryKey) : 0;
    const passesLcs = Math.max(vsHandle, vsPrimary) >= MIN_LCS;
    if (passesSuffix || passesLcs) kept.push(url);
  }

  // Self-correcting fallback: if the LCS filter rejected the overwhelming
  // majority (and we still have ≥15 candidates to choose from), the filter is
  // likely mis-tuned for this product's filename convention (e.g. SKU-coded
  // names like SHVEE that don't share tokens with the handle). Fall back to
  // accepting every non-obvious candidate so the gallery isn't lost.
  // Count unique kept URLs (the regex often matches the same URL many times in
  // the page markup) so the fallback trips on low *coverage*, not raw match
  // count. Without this, SKU-coded galleries (e.g. Raglan uses `SHRAG_*`) keep
  // only the single `Raglan_*` featured image 15 times over and skip fallback.
  const uniqueKept = new Set(kept);
  const uniqueCandidates = new Set(candidates);
  const useFallback = uniqueKept.size < 8 && uniqueCandidates.size >= 15;
  const final = useFallback ? candidates : kept;
  for (const url of final) images.add(url);
  if (process.env.DEBUG_EXTRACT) {
    console.error(
      `[debug] ${handle} scope=${scope.length} cands=${uniqueCandidates.size}/${candidates.length} kept=${uniqueKept.size}/${kept.length} fallback=${useFallback} suffix="${distinctiveSuffix}" handleKey="${handleKey}" primaryKey="${primaryKey}" images=${images.size}`
    );
  }

  return [...images];
}

function decodeHtmlEntities(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function extractProductTitle(html) {
  // <h1> on the PDP is the human-facing product name; SEO apps often rewrite
  // JSON-LD `name` and `<title>` for search but leave <h1> alone.
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1 && h1[1]) {
    const text = decodeHtmlEntities(h1[1].replace(/<[^>]+>/g, '')).trim();
    if (text) return text;
  }
  for (const p of extractJsonLdProducts(html)) {
    if (typeof p.name === 'string' && p.name.trim()) return p.name.trim();
  }
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og && og[1]) return decodeHtmlEntities(og[1]).trim();
  const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (t && t[1]) return decodeHtmlEntities(t[1]).replace(/\s*\|\s*Shakawear.*$/i, '').trim();
  return null;
}

async function loadSourceCatalog() {
  // Step 1: paginate the collection HTML for product handles.
  const allHandles = new Set();
  for (let page = 1; page <= SOURCE_MAX_PAGES; page++) {
    const url = page === 1 ? SOURCE_COLLECTION_URL : `${SOURCE_COLLECTION_URL}?page=${page}`;
    log('info', 'source_fetch_collection', { page, url });
    const html = await fetchText(url);
    const handles = extractProductHandles(html);
    const sizeBefore = allHandles.size;
    handles.forEach((h) => allHandles.add(h));
    const added = allHandles.size - sizeBefore;
    log('info', 'source_collection_handles', { page, pageHandles: handles.length, newHandles: added });
    if (added === 0) break;
    await sleep(SOURCE_PRODUCT_DELAY_MS);
  }

  const handles = [...allHandles];
  log('info', 'source_handles_total', { count: handles.length });
  if (handles.length === 0) {
    throw new Error('Could not extract any product handles from the shakawear collection page.');
  }

  // Step 2: fetch each product page with small concurrency, parse title + images.
  const catalog = [];
  for (let i = 0; i < handles.length; i += SOURCE_PRODUCT_CONCURRENCY) {
    const slice = handles.slice(i, i + SOURCE_PRODUCT_CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (handle) => {
        const url = `https://www.shakawear.com/products/${handle}`;
        try {
          const html = await fetchText(url);
          const title = extractProductTitle(html) || handle.replace(/-/g, ' ');
          const images = extractImagesFromProductHtml(html, handle);
          log('info', 'source_product_ok', { handle, title, imageCount: images.length });
          return { handle, title, images, normalized: normalizeTitle(title) };
        } catch (err) {
          log('error', 'source_product_failed', { handle, message: err.message });
          return null;
        }
      })
    );
    for (const entry of results) if (entry) catalog.push(entry);
    await sleep(SOURCE_PRODUCT_DELAY_MS);
  }

  log('info', 'source_loaded', { count: catalog.length });
  return catalog;
}

// ---------- Store products ----------
const PRODUCTS_QUERY = /* GraphQL */ `
  query ShakaProducts($cursor: String) {
    products(first: 100, after: $cursor, query: "${STORE_TITLE_QUERY}") {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          handle
          tags
        }
      }
    }
  }
`;

async function loadStoreProducts() {
  const out = [];
  let cursor = null;
  while (true) {
    const data = await graphql(PRODUCTS_QUERY, { cursor });
    const edges = data.products.edges || [];
    for (const { node } of edges) {
      out.push({ ...node, normalized: normalizeTitle(node.title) });
      if (out.length >= STORE_LIMIT) break;
    }
    if (out.length >= STORE_LIMIT) break;
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }
  log('info', 'store_loaded', { count: out.length });
  return out;
}

// ---------- Matcher ----------
function bestMatch(storeProduct, catalog) {
  let best = { score: 0, source: null };
  for (const src of catalog) {
    const score = dice(storeProduct.normalized, src.normalized);
    if (score > best.score) best = { score, source: src };
  }
  return best;
}

// ---------- Mutations ----------
const CREATE_MEDIA = /* GraphQL */ `
  mutation CreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media {
        id
        mediaContentType
        status
      }
      mediaUserErrors {
        field
        message
        code
      }
    }
  }
`;

const TAGS_ADD = /* GraphQL */ `
  mutation TagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

async function attachImagesWithRetry(productId, imageUrls) {
  const media = imageUrls.map((url) => ({
    originalSource: url,
    mediaContentType: 'IMAGE',
    alt: 'Shaka product image (tmp)',
  }));
  let attempt = 0;
  while (true) {
    const data = await graphql(CREATE_MEDIA, { productId, media });
    const errors = data.productCreateMedia?.mediaUserErrors || [];
    const throttled = errors.some((e) => /throttle/i.test(e.code || '') || /throttle/i.test(e.message || ''));
    if (throttled && attempt < MAX_RETRIES) {
      await sleep(1000);
      attempt++;
      continue;
    }
    return { created: data.productCreateMedia?.media || [], errors };
  }
}

async function addTagWithRetry(productId) {
  let attempt = 0;
  while (true) {
    const data = await graphql(TAGS_ADD, { id: productId, tags: [TAG] });
    const errors = data.tagsAdd?.userErrors || [];
    const throttled = errors.some((e) => /throttle/i.test(e.message || ''));
    if (throttled && attempt < MAX_RETRIES) {
      await sleep(1000);
      attempt++;
      continue;
    }
    return { errors };
  }
}

// ---------- Main ----------
async function main() {
  log('info', 'run_start', {
    apply: APPLY,
    sourceOnly: SOURCE_ONLY,
    threshold: MATCH_THRESHOLD,
    limit: Number.isFinite(STORE_LIMIT) ? STORE_LIMIT : null,
    store: SHOPIFY_STORE || null,
    apiVersion: API_VERSION,
    logPath,
  });

  if (SOURCE_ONLY) {
    const catalog = await loadSourceCatalog();
    console.log('\n--- Source catalog ---');
    for (const c of catalog) {
      console.log(`- ${c.title} (handle: ${c.handle}, images: ${c.images.length})`);
    }
    console.log(`Total: ${catalog.length} products. Log: ${logPath}`);
    return;
  }

  const [catalog, storeProducts] = await Promise.all([loadSourceCatalog(), loadStoreProducts()]);

  if (catalog.length === 0) {
    log('error', 'source_empty');
    process.exit(2);
  }

  const summary = { scanned: 0, matched: 0, skipped: 0, imagesAdded: 0, tagsAdded: 0, errors: 0 };

  for (const product of storeProducts) {
    summary.scanned++;
    const { score, source } = bestMatch(product, catalog);

    if (!source || score < MATCH_THRESHOLD) {
      summary.skipped++;
      log('info', 'skip_no_match', {
        productId: product.id,
        title: product.title,
        bestScore: Number(score.toFixed(3)),
        bestCandidate: source?.title || null,
      });
      continue;
    }

    summary.matched++;
    log('info', 'match', {
      productId: product.id,
      title: product.title,
      sourceHandle: source.handle,
      sourceTitle: source.title,
      score: Number(score.toFixed(3)),
      imageCount: source.images.length,
    });

    if (!APPLY) {
      log('info', 'dry_run_plan', {
        productId: product.id,
        wouldAddImages: source.images,
        wouldAddTag: TAG,
      });
      continue;
    }

    try {
      if (source.images.length > 0) {
        const { created, errors } = await attachImagesWithRetry(product.id, source.images);
        if (errors.length) {
          summary.errors++;
          log('error', 'media_errors', { productId: product.id, errors });
        }
        summary.imagesAdded += created.length;
        log('info', 'media_created', { productId: product.id, count: created.length });
        await sleep(THROTTLE_MS);
      }

      if (!product.tags.includes(TAG)) {
        const { errors } = await addTagWithRetry(product.id);
        if (errors.length) {
          summary.errors++;
          log('error', 'tag_errors', { productId: product.id, errors });
        } else {
          summary.tagsAdded++;
          log('info', 'tag_added', { productId: product.id, tag: TAG });
        }
        await sleep(THROTTLE_MS);
      } else {
        log('info', 'tag_already_present', { productId: product.id, tag: TAG });
      }
    } catch (err) {
      summary.errors++;
      log('error', 'product_failed', { productId: product.id, message: err.message });
    }
  }

  log('info', 'run_end', { ...summary, durationMs: Date.now() - runStart.getTime() });
  console.log('\n--- Summary ---');
  console.log(summary);
  console.log(`Log: ${logPath}`);
  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to mutate the store.');
  }
}

main().catch((err) => {
  log('error', 'fatal', { message: err.message, stack: err.stack });
  console.error(err);
  process.exit(1);
});
