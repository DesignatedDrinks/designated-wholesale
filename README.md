# Designated Drinks Wholesale

The canonical Designated Drinks wholesale ordering experience:

- Production: https://designateddrinks.github.io/designated-wholesale/
- Product and order source of truth: the existing **Designated Wholesale** Google Sheet
- Checkout/backend source: `apps-script/Code.gs`
- Independent Shopify inventory sync: `apps-script/ShopifyInventorySync.gs`

## Architecture

```
GitHub Pages catalogue + cart + checkout
                ↓
Google Apps Script checkout web app
                ↓
Designated Wholesale Google Sheet
  ├─ Sheet1 (products)
  ├─ Orders
  ├─ Order Items
  ├─ Settings
  └─ Logs
                ↑
Standalone daily Shopify inventory sync
                ↑
Shopify Admin API
```

The Shopify inventory sync is deliberately independent of the checkout Apps Script. It can run in its own Apps Script project and does not require the checkout backend's `CONFIG` object or helper functions.

## Checkout Apps Script

Keep `apps-script/Code.gs` in the Apps Script project used by the production wholesale web-app endpoint. Deploy a new version of that existing Web app only when checkout/backend web-app code changes.

Do not create another wholesale spreadsheet or another wholesale web-app endpoint.

## Independent Shopify inventory sync

### Governing rule

**Shopify product identity and Shopify product titles are authoritative.**

The first safe match is established by one of these deterministic signals only:

1. a stored Shopify Product ID;
2. the unique Shopify featured-image URL already used by the wholesale row;
3. an exact normalized Shopify product title.

There is no fuzzy title matching. Once matched, the Shopify Product ID is stored permanently and column A is rewritten to Shopify's exact current title on every successful sync. That means future Shopify title changes automatically flow into wholesale without breaking product identity.

### Shopify app

Create an app in Shopify's Dev Dashboard for the Designated Drinks store, release a version, and install it on the store with only these Admin API scopes:

- `read_products`
- `read_inventory`

The sync uses Shopify's client-credentials grant. It exchanges the Client ID and Client secret for a fresh short-lived Admin API access token whenever it runs.

### Apps Script project

Create or use a separate Google Apps Script project for the inventory sync. Its entire `Code.gs` can be the contents of:

`apps-script/ShopifyInventorySync.gs`

The sync file is self-contained. Do not paste the checkout backend `CONFIG` object into it and do not combine the two files just to satisfy dependencies.

### Script Properties

In the inventory-sync Apps Script project, open **Project Settings → Script Properties** and add:

- `SHOPIFY_SHOP` = `designateddrinks`
- `SHOPIFY_CLIENT_ID` = the Shopify Dev Dashboard Client ID
- `SHOPIFY_CLIENT_SECRET` = the Shopify Dev Dashboard Client secret

Never put the Client secret into GitHub or browser JavaScript.

### Turn on the daily sync

Run these functions in order:

1. `testShopifyInventoryConnection()` — should return `status: success`.
2. `setupShopifyInventorySync()` — verifies the connection, prepares hidden sync columns N:S, and creates the daily trigger for about 6:00 AM America/Toronto.
3. `syncShopifyWholesaleInventory()` — runs the first inventory refresh immediately.
4. `getLastShopifyInventorySyncResult()` — returns the latest run summary.
5. `diagnoseShopifyInventorySync()` — safe diagnostic output showing configuration/trigger state without revealing the Client secret.

The sync treats rows already present in `Sheet1` as the wholesale whitelist. It does not add or delete wholesale rows and does not change pricing, formulas, categories, SKUs, case formats, or sort order.

For each eligible single-unit wholesale row it:

- identifies the Shopify product by Product ID, unique featured image, or exact normalized title only;
- stores the Shopify Product ID as the permanent identity key;
- overwrites column A with Shopify's exact current product title;
- uses the matching base can/bottle/single variant inventory when available;
- calculates `Wholesale Cases Available = floor(available units / case size)`;
- can use a true Shopify case variant directly when the exact wholesale case size exists;
- sets `Status` to `yes` only when at least one full wholesale case is available;
- sets `Status` to `no` when a product is unavailable, unmatched, ambiguous, or cannot be represented safely;
- records diagnostics in hidden columns N:S;
- records each run in the existing `Logs` tab when present;
- emails `sales@designateddrinks.ca` if the sync itself fails.

The sync fetches the complete Shopify inventory snapshot before changing customer-visible status. It fails closed rather than guessing.

## Local verification

```bash
node --test tests/app.test.js
python3 -m http.server 4173
```
