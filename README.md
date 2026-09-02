# Designated Drinks Wholesale

Canonical wholesale ordering system for Designated Drinks.

- Production site: https://designateddrinks.github.io/designated-wholesale/
- Frontend: `index.html` + `app.js` + `styles.css` + `catalogue-ux.css`
- Checkout backend: `apps-script/Code.gs`
- Independent Shopify inventory mirror: `apps-script/ShopifyInventorySync.gs`
- Product/order data: existing **Designated Wholesale** Google Sheet

## Architecture

```text
Shopify Admin API
      ↓ daily inventory mirror
Google Apps Script inventory sync
      ↓
Designated Wholesale / Sheet1
      ↓
GitHub Pages catalogue + cart + checkout
      ↓
Google Apps Script checkout backend
      ↓
Orders + Order Items + email confirmations
```

There is one frontend controller. Do not reintroduce the retired `checkout-flow.js`, `checkout-transport.js`, or `catalogue-ux.js` patch layers.

## Inventory rules

Shopify is authoritative for product identity, product title, vendor, image, retail price and inventory.

Singles are the physical inventory source of truth. Wholesale cases contain 24 units.

Every successful inventory sync rebuilds `Sheet1` from eligible Shopify products:

- Shopify product must be ACTIVE.
- Product must be an eligible beverage.
- Product must have one unambiguous single can/bottle variant.
- Available singles must be at least 24.
- `Wholesale Cases Available = floor(available singles / 24)`.
- Products below one complete case are not written to `Sheet1` and therefore do not appear on the wholesale site.
- Products automatically reappear when Shopify inventory returns to 24+ singles.
- Shopify Product ID is retained as the durable identity key.
- Shopify's exact product title is used on the wholesale site.

The frontend reads `Wholesale Cases Available` and prevents customers from selecting more cases than are shown available. The checkout backend revalidates the same limit against `Sheet1` before accepting the order.

## Frontend behaviour

`app.js` owns catalogue, filters, cart, checkout, tax preview, dialog lifecycle and order submission.

Key UX/reliability rules:

- Product cards are created once and reused when filtering/sorting.
- Search, category, brewery and price/name sorting do not rebuild the full catalogue unnecessarily.
- Catalogue data is refreshed from the Sheet export, with API fallback and a short session cache for fast repeat navigation.
- Long product names wrap naturally instead of being ellipsized.
- Product images are lazy-loaded and asynchronously decoded.
- Cart quantities are capped by live wholesale case availability.
- Cart items can be adjusted directly in the order summary or review dialog.
- Removing the final item from checkout closes the dialog and always releases page scroll/body lock.
- Checkout and success dialogs share one lock-state controller so closing with buttons, Escape or browser page restoration cannot leave the page frozen.
- Checkout remembers repeat customer/contact/address details locally but clears order-specific PO/notes after success.

## Checkout and tax

The checkout backend is `apps-script/Code.gs` and should be deployed as the existing production Web app. Do not create another endpoint.

GST/HST is calculated from the delivery province; pickup is treated as Ontario. The backend recalculates tax server-side rather than trusting the browser.

The backend also:

- validates current product availability and pricing under a script lock;
- rejects quantities above `Wholesale Cases Available`;
- writes the order and order items before notifying the browser of saved status;
- sets durable `stage: saved` status immediately after persistence, before email delivery, so checkout can complete quickly;
- sends internal and customer confirmation emails after the order has safely persisted;
- preserves idempotency using `submissionId`.

When `apps-script/Code.gs` changes, update the existing checkout Apps Script project and deploy a **new version of the existing Web app deployment** so its URL remains unchanged.

Recommended backend verification after updating Apps Script:

1. `setupSystem()`
2. `testTaxRules()`
3. `testInventoryGuard()`
4. `testSetup()`
5. Deploy → Manage deployments → existing Web app → Edit → New version → Deploy

## Independent Shopify sync setup

The inventory sync can live in a separate Apps Script project and is independent of the checkout backend.

Required Script Properties:

- `SHOPIFY_SHOP` = `designateddrinks`
- `SHOPIFY_CLIENT_ID` = Shopify Dev Dashboard app Client ID
- `SHOPIFY_CLIENT_SECRET` = Shopify Dev Dashboard app Client secret

Required Shopify Admin API scopes:

- `read_products`
- `read_inventory`

Run once:

1. `testShopifyInventoryConnection()`
2. `setupShopifyInventorySync()`
3. `syncShopifyWholesaleInventory()`

The setup function creates the daily trigger for roughly 6:00 AM America/Toronto.

## Tests

```bash
npm test
```

The regression suite covers CSV parsing, Shopify-backed product normalization, case availability caps, catalogue filtering/sorting, Canadian postal codes, GST/HST rules, structured checkout validation, quantity bounds and dialog/body-lock behaviour.
