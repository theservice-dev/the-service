# Scripts

One-off maintenance scripts for the-service Shopify store. These are **not** part of the theme build and do not ship to the storefront.

## populate-shaka-images.mjs

For every product in your store whose title contains "Shaka", fuzzy-match it to a product on `shakawear.com/collections/t-shirts`, upload all of that product's images, and add the tag `tmp`.

Default mode is a dry run. Nothing is written to your store unless you pass `--apply`.

### Legal note

The images on `shakawear.com` are that brand's assets. The `tmp` tag exists so you can identify and bulk-remove every affected product afterwards. Do not ship these products to production.

### One-time setup

1. In Shopify Admin, go to **Apps → Develop apps → Create an app**.
2. Under **Configuration → Admin API integration**, grant scopes:
   - `read_products`
   - `write_products`
3. Install the app. Copy the **Admin API access token** (starts with `shpat_`).
4. Create `scripts/.env` from the template:

   ```bash
   cp .env.example .env
   ```

   Fill in:

   ```dotenv
   SHOPIFY_STORE=your-store.myshopify.com
   SHOPIFY_ADMIN_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   SHOPIFY_API_VERSION=2025-01
   ```

5. Install dependencies (requires Node 18.17+):

   ```bash
   cd scripts
   npm install
   ```

### Run

Dry run (default, no writes):

```bash
node populate-shaka-images.mjs
```

Apply for real:

```bash
node populate-shaka-images.mjs --apply
```

Optional flags:

| Flag | Default | Purpose |
|---|---|---|
| `--apply` | off | Actually call `productCreateMedia` and `tagsAdd`. |
| `--threshold=0.55` | `0.55` | Minimum Dice similarity to accept a title match. Lower = more matches but noisier. |
| `--limit=10` | none | Process at most N store products. Useful for a smoke test. |
| `--source-only` | off | Only scrape the source catalog from `shakawear.com` and print it. Does **not** require `SHOPIFY_STORE` / `SHOPIFY_ADMIN_TOKEN` and never writes anything. Use this to sanity-check titles and image counts before connecting to your store. |

Recommended first run:

```bash
node populate-shaka-images.mjs --source-only
node populate-shaka-images.mjs --limit=3
```

Inspect the printed source catalog, then the `match` / `skip_no_match` lines, then re-run full apply.

### Output

- Structured JSONL log written to `scripts/logs/run-<timestamp>.log` (git-ignored via `node_modules`/`.env` rules; logs folder is not committed because it only exists after the first run — add it to `.gitignore` if desired).
- Console summary at the end: `scanned`, `matched`, `skipped`, `imagesAdded`, `tagsAdded`, `errors`.

### What it does

1. Scrapes `https://www.shakawear.com/collections/t-shirts` (paginated, HTML — shakawear.com has `/products.json` disabled, so we cannot use the standard JSON endpoint) to collect product handles.
2. For each handle, fetches the product page HTML and extracts:
   - **Title**: prefers the page `<h1>`, then JSON-LD `Product.name`, then `og:title`, then `<title>`. This avoids SEO-stuffed titles like "Shaka Wear — Premium Heavyweight Tees for Streetwear".
   - **Images**: primary images from JSON-LD `Product.image` and `og:image`, plus every Shopify CDN image URL in the main gallery section of the page. Cross-sell / "Recommendations" / "You may also like" carousels are cut off before extraction. Remaining candidates are filtered against (a) an obvious-noise denylist (swatches, favicons, sprites, brand logo files), and (b) a filename similarity check that keeps an image if its normalized filename shares a 15+ char substring with either the product handle or the strongest primary image, **or** contains the distinctive product suffix (e.g. `oversizedtee`, `thermal`, `vneckshortsleeve`). If that filter would wipe out a product's gallery (unique kept count below 8 while 15+ unique candidates exist), it falls back to every non-obvious candidate on the page — this is necessary for products like "6.0oz Raglan" whose filenames are SKU-coded (`SHRAG_*`) and share no tokens with the handle.
3. Queries your store's Admin GraphQL API for products matching `title:*Shaka*` (paginated via cursor).
4. For each store product:
   - Normalizes the title (lowercase, punctuation stripped, `oz` collapsed) and scores it against every source title using Sørensen–Dice on character bigrams.
   - Skips the product if the best score is below `--threshold`.
   - Otherwise, calls `productCreateMedia` once per image URL from the matched source product. Shopify pulls the image server-side from shakawear's CDN.
   - Calls `tagsAdd` with `["tmp"]` if the tag is not already present.
5. Throttles 250 ms between mutations and retries once on `THROTTLED` / HTTP 429.

### Debugging the image filter

Set `DEBUG_EXTRACT=1` to get a one-line-per-product trace of how the scraper sliced up each product page:

```bash
DEBUG_EXTRACT=1 node populate-shaka-images.mjs --source-only
```

Each line shows `scope` size, unique/raw candidate counts, unique/raw kept counts, whether the fallback triggered, and the handle / primary / distinctive-suffix references the filter compared against.

### Rollback

Every touched product gets the `tmp` tag. In Shopify Admin:

1. **Products** → filter by **Tagged with: `tmp`**.
2. Bulk select → **Actions → Edit products** to remove images, or delete the tag, or restore from a backup.

If you want a scripted rollback, ask for a `--rollback` mode (not currently implemented).

### Safety checklist before `--apply`

- [ ] You are pointing at the correct store (`SHOPIFY_STORE`).
- [ ] You have run a `--limit=3` dry run and the matches look correct.
- [ ] You accept that images will be attached to the end of each product's existing media (nothing is replaced or deleted).
- [ ] You accept the legal note above.
