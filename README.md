# Designated Drinks Wholesale

The canonical Designated Drinks wholesale ordering experience:

- Production: https://designateddrinks.github.io/designated-wholesale/
- Product and order source of truth: the existing **Designated Wholesale** Google Sheet
- Backend source: `apps-script/Code.gs`

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
```

The frontend loads active products from the Apps Script JSONP endpoint and falls back to the existing Sheet CSV export while an older backend deployment is still active. Checkout submits SKU, catalogue title, quantity, customer details, and a unique submission ID. The browser does not show success until status polling confirms the server stored the order.

## Apps Script deployment

1. Replace the existing wholesale Apps Script source with `apps-script/Code.gs`.
2. Run `setupSystem()` once.
3. Run `testSetup()` and `testStatusStorage()`.
4. Deploy a new version of the existing Web app, executing as the owner with access set to anyone.
5. Verify `?action=products` returns the active catalogue and `?action=status&submissionId=...` returns JSON.

Do not create another Apps Script deployment or another spreadsheet. Update the existing deployment so the endpoint URL in `app.js` remains unchanged.

## Local verification

```bash
node --test tests/app.test.js
python3 -m http.server 4173
```
