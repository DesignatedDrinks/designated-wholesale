# Designated Drinks Wholesale

The canonical Designated Drinks wholesale ordering experience:

- Production: https://designateddrinks.github.io/designated-wholesale/
- Product and order source of truth: the existing **Designated Wholesale** Google Sheet
- Backend source: `apps-script/Code.gs`
- Independent Shopify inventory sync: `apps-script/ShopifyInventorySync.gs`

## Architecture

```
GitHub Pages catalogue + cart + checkout
                ↓
Google Apps Script web app
                ↓
Designated Wholesale Google Sheet
  ├─ Sheet1 (products)
  ├─ Orders
  ├─ Order Items
  ├─ Settings
  └─ Logs
                ↑
Daily Shopify inventory sync
```

The frontend loads active products from the Apps Script JSONP endpoint and falls back to the existing Sheet CSV export while an older backend deployment is still active. Checkout submits SKU, catalogue title, quantity, customer details, and a unique submission ID.

## Apps Script deployment

1. Keep `apps-script/Code.gs` in the existing wholesale Apps Script project.
2. Add `apps-script/ShopifyInventorySync.gs` to that same Apps Script project as a second script file.
3. Run `setupSystem()` once if the wholesale backend has not already been initialized.
4. Deploy a new version of the existing Web app when backend web-app code changes, executing as the owner with access set to anyone.
5. Verify `?action=products` returns the active catalogue and `?action=status&submissionId=...` returns JSON.

Do not create another wholesale spreadsheet or another wholesale web-app endpoint.

## Independent Shopify inventory sync

The daily inventory refresh runs entirely inside Google Apps Script. ChatGPT is not part of the production path.

### Shopify app

Create an app in Shopify's Dev Dashboard for the Designated Drinks store and release/install a version with only these Admin API scopes:

- `read_products`
- `read_inventory`

The app is a server-side integration for the Designated Drinks store. It uses Shopify's client-credentials grant and requests a fresh short-lived Admin API access token each time it runs.

### Apps Script secrets

In the existing wholesale Apps Script project, open **Project Settings → Script Properties** and add:

- `SHOPIFY_SHOP` = `designateddrinks`
- `SHOPIFY_CLIENT_ID` = the Shopify Dev Dashboard Client ID
- `SHOPIFY_CLIENT_SECRET` = the Shopify Dev Dashboard Client secret

Never put the Client secret into GitHub or browser JavaScript.

### Turn on the daily sync

1. Add the three Script Properties above.
2. Run `testShopifyInventoryConnection()` once. It should return `status: success`.
3. Run `setupShopifyInventorySync()` once. This creates the daily trigger for about 6:00 AM America/Toronto.
4. Run `syncShopifyWholesaleInventory()` manually once to populate the inventory diagnostics immediately.
5. Check `getLastShopifyInventorySyncResult()` for the last run summary.

The sync treats the rows already present in `Sheet1` as the wholesale whitelist. It does not add/delete wholesale rows or change pricing, formulas, images, category, SKU, case format, or sort order.

For each row it:

- matches the wholesale product to Shopify conservatively;
- uses the base can/bottle/single variant inventory where possible;
- calculates `Wholesale Cases Available = floor(available units / case size)`;
- sets `Status` to `yes` only when at least one full wholesale case is available;
- leaves `Status` unchanged when a product or inventory variant cannot be matched safely;
- records diagnostics in hidden columns N:R;
- clears the wholesale product cache after a successful sync;
- records the run in `Logs`;
- emails `sales@designateddrinks.ca` if the sync itself fails.

## Local verification

```bash
node --test tests/app.test.js
python3 -m http.server 4173
```
