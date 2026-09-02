/**
 * Designated Drinks Wholesale — independent Shopify inventory mirror.
 *
 * GOVERNING RULES
 * 1. Shopify is the source of truth for product identity, title, image, vendor,
 *    retail price and inventory.
 * 2. Singles are the physical inventory source of truth.
 * 3. Sheet1 contains ONLY active Shopify beverages that can make at least one
 *    complete 24-unit wholesale case.
 * 4. If a product falls below 24 available singles, it disappears from Sheet1.
 * 5. If it rises back to 24+ singles, it reappears automatically.
 * 6. ChatGPT is not part of the production sync path.
 *
 * Required Apps Script Properties:
 *   SHOPIFY_SHOP          designateddrinks (or designateddrinks.myshopify.com)
 *   SHOPIFY_CLIENT_ID     Shopify Dev Dashboard app Client ID
 *   SHOPIFY_CLIENT_SECRET Shopify Dev Dashboard app Client secret
 *
 * Required Shopify scopes:
 *   read_products
 *   read_inventory
 */
const SHOPIFY_SYNC_CONFIG = Object.freeze({
  SPREADSHEET_ID: "17bcjrwi7Ah8_SXaPc9VrCIi2fdYnnNofmUoGy4LKBQ8",
  PRODUCTS_SHEET_NAME: "Sheet1",
  LOGS_SHEET_NAME: "Logs",
  FAILURE_EMAIL: "sales@designateddrinks.ca",
  API_VERSION: "2026-07",
  SHOP_PROPERTY: "SHOPIFY_SHOP",
  CLIENT_ID_PROPERTY: "SHOPIFY_CLIENT_ID",
  CLIENT_SECRET_PROPERTY: "SHOPIFY_CLIENT_SECRET",
  LAST_RESULT_PROPERTY: "SHOPIFY_SYNC_LAST_RESULT",
  SKU_MAP_PROPERTY: "SHOPIFY_WHOLESALE_SKU_MAP",
  TIME_ZONE: "America/Toronto",
  TRIGGER_HOUR: 6,
  HANDLER: "syncShopifyWholesaleInventory",
  FIRST_DATA_ROW: 2,
  CASE_SIZE: 24,
  COLUMN_COUNT: 19,
  COL_TITLE: 1,
  COL_PACK_SIZE: 2,
  COL_RETAIL_PRICE: 3,
  COL_WHOLESALE_PRICE: 4,
  COL_IMAGE_URL: 5,
  COL_CASE_PRICE: 6,
  COL_STATUS: 7,
  COL_SKU: 8,
  COL_BRAND: 9,
  COL_CATEGORY: 10,
  COL_STYLE: 11,
  COL_CASE_FORMAT: 12,
  COL_SORT_ORDER: 13,
  COL_SHOPIFY_MATCH: 14,
  COL_AVAILABLE_UNITS: 15,
  COL_CASES_AVAILABLE: 16,
  COL_LAST_SYNC: 17,
  COL_SYNC_STATUS: 18,
  COL_SHOPIFY_PRODUCT_ID: 19,
  MAX_PAGES: 50
});

function setupShopifyInventorySync() {
  const connection = testShopifyInventoryConnection();
  const spreadsheet = openWholesaleSpreadsheet_();
  const sheet = getWholesaleProductSheet_(spreadsheet);
  ensureShopifySyncColumns_(sheet);
  seedSkuMapFromSheet_(sheet);
  installShopifyInventoryTrigger_();
  return {
    status: "ready",
    shop: connection.shop,
    rule: "Sheet1 contains only products with at least one complete 24-unit case",
    trigger: "daily around 6:00 AM America/Toronto",
    apiVersion: SHOPIFY_SYNC_CONFIG.API_VERSION
  };
}

function testShopifyInventoryConnection() {
  const credentials = requireShopifyCredentials_();
  const token = fetchShopifyAccessToken_(credentials);
  const data = shopifyGraphql_(
    credentials.shop,
    token,
    "query { shop { name myshopifyDomain } }",
    {}
  );
  return {
    status: "success",
    shop: data.shop && (data.shop.myshopifyDomain || data.shop.name) || credentials.shop
  };
}

function diagnoseShopifyInventorySync() {
  const properties = PropertiesService.getScriptProperties();
  return {
    spreadsheetId: SHOPIFY_SYNC_CONFIG.SPREADSHEET_ID,
    productSheet: SHOPIFY_SYNC_CONFIG.PRODUCTS_SHEET_NAME,
    shop: normalizeShopDomain_(properties.getProperty(SHOPIFY_SYNC_CONFIG.SHOP_PROPERTY)) || "missing",
    clientIdConfigured: Boolean(cleanSyncText_(properties.getProperty(SHOPIFY_SYNC_CONFIG.CLIENT_ID_PROPERTY))),
    clientSecretConfigured: Boolean(cleanSyncText_(properties.getProperty(SHOPIFY_SYNC_CONFIG.CLIENT_SECRET_PROPERTY))),
    triggerInstalled: ScriptApp.getProjectTriggers().some(function (trigger) {
      return trigger.getHandlerFunction() === SHOPIFY_SYNC_CONFIG.HANDLER;
    }),
    rule: "Only Shopify products with 24+ available singles are written to Sheet1",
    lastResult: getLastShopifyInventorySyncResult()
  };
}

function installShopifyInventoryTrigger_() {
  removeShopifyInventoryTrigger();
  ScriptApp.newTrigger(SHOPIFY_SYNC_CONFIG.HANDLER)
    .timeBased()
    .atHour(SHOPIFY_SYNC_CONFIG.TRIGGER_HOUR)
    .nearMinute(0)
    .everyDays(1)
    .inTimezone(SHOPIFY_SYNC_CONFIG.TIME_ZONE)
    .create();
}

function removeShopifyInventoryTrigger() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === SHOPIFY_SYNC_CONFIG.HANDLER) {
      ScriptApp.deleteTrigger(trigger);
      removed += 1;
    }
  });
  return { status: "success", removed: removed };
}

function syncShopifyWholesaleInventory() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error("Shopify inventory sync is already running.");

  const startedAt = new Date();
  let spreadsheet = null;

  try {
    const credentials = requireShopifyCredentials_();
    const token = fetchShopifyAccessToken_(credentials);

    // Fetch everything successfully before touching Sheet1.
    const products = fetchShopifyProductInventory_(credentials.shop, token);
    if (!products.length) throw new Error("Shopify returned no active products.");

    const eligible = products.map(function (product) {
      const baseVariant = chooseBaseVariant_(product.variants);
      if (!baseVariant) return null;
      if (!isEligibleShopifyBeverage_(product, baseVariant)) return null;

      const availableUnits = Math.max(0, Number(baseVariant.inventoryQuantity) || 0);
      const casesAvailable = Math.floor(availableUnits / SHOPIFY_SYNC_CONFIG.CASE_SIZE);
      if (casesAvailable < 1) return null;

      return {
        product: product,
        variant: baseVariant,
        availableUnits: availableUnits,
        casesAvailable: casesAvailable
      };
    }).filter(Boolean);

    eligible.sort(function (a, b) {
      const vendorCompare = cleanSyncText_(a.product.vendor).localeCompare(cleanSyncText_(b.product.vendor), "en", { sensitivity: "base" });
      if (vendorCompare !== 0) return vendorCompare;
      return cleanSyncText_(a.product.title).localeCompare(cleanSyncText_(b.product.title), "en", { sensitivity: "base" });
    });

    spreadsheet = openWholesaleSpreadsheet_();
    const sheet = getWholesaleProductSheet_(spreadsheet);
    ensureShopifySyncColumns_(sheet);

    const skuState = buildSkuState_(sheet);
    const syncTime = new Date();
    const rows = eligible.map(function (item, index) {
      const rowNumber = SHOPIFY_SYNC_CONFIG.FIRST_DATA_ROW + index;
      const product = item.product;
      const variant = item.variant;
      const category = inferCategory_(product);
      const sku = getStableSku_(product, skuState);

      return [
        product.title,
        variant.title,
        Number(variant.price) || 0,
        "=ROUND(C" + rowNumber + "*0.7, 2)",
        product.imageUrl || "",
        "=D" + rowNumber + "*" + SHOPIFY_SYNC_CONFIG.CASE_SIZE,
        "yes",
        sku,
        product.vendor || "",
        category,
        inferStyle_(product.title, category),
        SHOPIFY_SYNC_CONFIG.CASE_SIZE + " × " + variant.title,
        index + 1,
        product.title,
        item.availableUnits,
        item.casesAvailable,
        syncTime,
        "in stock",
        product.id
      ];
    });

    persistSkuMap_(skuState.map);
    replaceSheet1Data_(sheet, rows);
    SpreadsheetApp.flush();

    const result = {
      status: "success",
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      summary: {
        activeShopifyProducts: products.length,
        displayedWholesaleProducts: rows.length,
        hiddenBecauseLessThanOneCase: products.length - rows.length
      }
    };

    storeShopifySyncResult_(result);
    logShopifySync_(spreadsheet, result, "");
    return result;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const failed = {
      status: "error",
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      error: message
    };
    storeShopifySyncResult_(failed);
    try {
      if (!spreadsheet) spreadsheet = openWholesaleSpreadsheet_();
      logShopifySync_(spreadsheet, failed, message);
    } catch (logError) {
      console.error("Could not log Shopify sync failure:", logError);
    }
    notifyShopifySyncFailure_(message);
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function replaceSheet1Data_(sheet, rows) {
  const requiredLastRow = Math.max(1, rows.length + 1);
  if (sheet.getMaxRows() < requiredLastRow) {
    sheet.insertRowsAfter(sheet.getMaxRows(), requiredLastRow - sheet.getMaxRows());
  }

  const currentLastRow = Math.max(sheet.getLastRow(), 1);
  if (currentLastRow >= SHOPIFY_SYNC_CONFIG.FIRST_DATA_ROW) {
    sheet.getRange(
      SHOPIFY_SYNC_CONFIG.FIRST_DATA_ROW,
      1,
      currentLastRow - 1,
      SHOPIFY_SYNC_CONFIG.COLUMN_COUNT
    ).clearContent();
  }

  if (!rows.length) return;

  const target = sheet.getRange(
    SHOPIFY_SYNC_CONFIG.FIRST_DATA_ROW,
    1,
    rows.length,
    SHOPIFY_SYNC_CONFIG.COLUMN_COUNT
  );
  target.setValues(rows);

  // Preserve the existing table look without modifying the values/formulas.
  if (sheet.getMaxRows() >= 2) {
    const template = sheet.getRange(2, 1, 1, SHOPIFY_SYNC_CONFIG.COLUMN_COUNT);
    template.copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  }

  sheet.getRange(2, SHOPIFY_SYNC_CONFIG.COL_RETAIL_PRICE, rows.length, 2)
    .setNumberFormat("0.00");
  sheet.getRange(2, SHOPIFY_SYNC_CONFIG.COL_LAST_SYNC, rows.length, 1)
    .setNumberFormat("yyyy-mm-dd hh:mm");
}

function fetchShopifyProductInventory_(shop, token) {
  const query = [
    "query WholesaleInventory($after: String) {",
    "  productVariants(first: 250, after: $after) {",
    "    nodes {",
    "      id",
    "      title",
    "      price",
    "      inventoryQuantity",
    "      product {",
    "        id",
    "        title",
    "        vendor",
    "        status",
    "        productType",
    "        tags",
    "        featuredMedia { ... on MediaImage { image { url } } }",
    "      }",
    "    }",
    "    pageInfo { hasNextPage endCursor }",
    "  }",
    "}"
  ].join("\n");

  const productsById = {};
  let after = null;
  let page = 0;

  do {
    page += 1;
    if (page > SHOPIFY_SYNC_CONFIG.MAX_PAGES) {
      throw new Error("Shopify pagination exceeded the safety limit.");
    }

    const data = shopifyGraphql_(shop, token, query, { after: after });
    const connection = data.productVariants;
    if (!connection || !Array.isArray(connection.nodes)) {
      throw new Error("Shopify inventory response was incomplete.");
    }

    connection.nodes.forEach(function (variant) {
      if (!variant || !variant.product) return;
      if (String(variant.product.status || "").toUpperCase() !== "ACTIVE") return;

      const productId = String(variant.product.id || "");
      if (!productsById[productId]) {
        productsById[productId] = {
          id: productId,
          title: cleanSyncText_(variant.product.title),
          vendor: cleanSyncText_(variant.product.vendor),
          productType: cleanSyncText_(variant.product.productType),
          tags: Array.isArray(variant.product.tags) ? variant.product.tags : [],
          imageUrl: variant.product.featuredMedia && variant.product.featuredMedia.image
            ? cleanSyncText_(variant.product.featuredMedia.image.url)
            : "",
          variants: []
        };
      }

      productsById[productId].variants.push({
        id: String(variant.id || ""),
        title: cleanSyncText_(variant.title),
        price: Number(variant.price) || 0,
        inventoryQuantity: Number(variant.inventoryQuantity) || 0
      });
    });

    after = connection.pageInfo && connection.pageInfo.hasNextPage
      ? connection.pageInfo.endCursor
      : null;
  } while (after);

  return Object.keys(productsById).map(function (key) { return productsById[key]; });
}

function chooseBaseVariant_(variants) {
  const eligible = (variants || []).filter(function (variant) {
    return isSingleUnitVariant_(variant.title);
  });
  if (eligible.length === 1) return eligible[0];

  // Never guess when Shopify has multiple possible single-unit variants.
  return null;
}

function isEligibleShopifyBeverage_(product, variant) {
  if (!product || !variant || !isSingleUnitVariant_(variant.title)) return false;

  const type = cleanSyncText_(product.productType).toLowerCase();
  const tags = (product.tags || []).map(function (tag) {
    return cleanSyncText_(tag).toLowerCase();
  });
  const title = cleanSyncText_(product.title).toLowerCase();

  return type.indexOf("beverage") !== -1 ||
    tags.some(function (tag) { return tag.indexOf("category_") === 0; }) ||
    title.indexOf("non-alcoholic") !== -1 ||
    title.indexOf("non alcoholic") !== -1;
}

function isSingleUnitVariant_(value) {
  const text = normalizePack_(value);
  if (!text) return false;
  if (/^\d+pack$/.test(text)) return false;
  return /\d+ml/.test(text) && /(can|bottle|single)/.test(text);
}

function inferCategory_(product) {
  const tags = (product.tags || []).map(function (tag) {
    return cleanSyncText_(tag).toLowerCase();
  });

  if (tags.indexOf("category_beer") !== -1) return "Beer";
  if (tags.indexOf("category_cider") !== -1) return "Cider";
  if (tags.indexOf("category_cocktails") !== -1 || tags.indexOf("category_cocktail") !== -1) return "Cocktails";
  if (tags.indexOf("category_hop_water") !== -1) return "Hop Water";
  if (tags.indexOf("category_wine") !== -1) return "Wine";

  const value = cleanSyncText_(product.title).toLowerCase();
  if (/cider|cidery|apple sparkle|pear sparkle/.test(value)) return "Cider";
  if (/hop\s?water|hopped water|sparkling hop/.test(value)) return "Hop Water";
  if (/wine|ros[eé]|prosecco|chardonnay|cabernet|pinot|riesling|sauvignon/.test(value)) return "Wine";
  if (/cocktail|mocktail|margarita|mojito|negroni|spritz|sangria|gin|tonic|cosmo|paloma|martini|mule|collins|mimosa|rum|vodka|tequila|amaro/.test(value)) return "Cocktails";
  return "Beer";
}

function inferStyle_(title, category) {
  const value = cleanSyncText_(title).toLowerCase();
  const rules = [
    ["IPA", /\bipa\b|india pale ale/],
    ["Pale Ale", /pale ale/],
    ["Lager", /lager/],
    ["Pilsner", /pilsner/],
    ["Stout", /stout/],
    ["Porter", /porter/],
    ["Sour", /sour|gose/],
    ["Wheat", /wheat|witbier|\bwit\b/],
    ["Blonde Ale", /blonde/],
    ["Amber Ale", /amber/],
    ["Radler", /radler/]
  ];

  for (let index = 0; index < rules.length; index += 1) {
    if (rules[index][1].test(value)) return rules[index][0];
  }
  return category;
}

function buildSkuState_(sheet) {
  const properties = PropertiesService.getScriptProperties();
  let map = {};
  try {
    map = JSON.parse(properties.getProperty(SHOPIFY_SYNC_CONFIG.SKU_MAP_PROPERTY) || "{}");
  } catch (error) {
    map = {};
  }

  let next = 1;
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const rows = sheet.getRange(2, 1, lastRow - 1, SHOPIFY_SYNC_CONFIG.COLUMN_COUNT).getValues();
    rows.forEach(function (row) {
      const productId = cleanSyncText_(row[SHOPIFY_SYNC_CONFIG.COL_SHOPIFY_PRODUCT_ID - 1]);
      const sku = cleanSyncText_(row[SHOPIFY_SYNC_CONFIG.COL_SKU - 1]);
      if (productId && sku) map[productId] = sku;
      const match = sku.match(/^DDW-(\d+)$/i);
      if (match) next = Math.max(next, Number(match[1]) + 1);
    });
  }

  Object.keys(map).forEach(function (key) {
    const match = cleanSyncText_(map[key]).match(/^DDW-(\d+)$/i);
    if (match) next = Math.max(next, Number(match[1]) + 1);
  });

  return { map: map, next: next };
}

function seedSkuMapFromSheet_(sheet) {
  const state = buildSkuState_(sheet);
  persistSkuMap_(state.map);
}

function getStableSku_(product, state) {
  if (state.map[product.id]) return state.map[product.id];
  const sku = "DDW-" + String(state.next).padStart(4, "0");
  state.map[product.id] = sku;
  state.next += 1;
  return sku;
}

function persistSkuMap_(map) {
  PropertiesService.getScriptProperties().setProperty(
    SHOPIFY_SYNC_CONFIG.SKU_MAP_PROPERTY,
    JSON.stringify(map || {})
  );
}

function ensureShopifySyncColumns_(sheet) {
  const headers = [
    "Shopify Product Match",
    "Available Units",
    "Wholesale Cases Available",
    "Last Shopify Sync",
    "Shopify Sync Status",
    "Shopify Product ID"
  ];
  sheet.getRange(1, SHOPIFY_SYNC_CONFIG.COL_SHOPIFY_MATCH, 1, headers.length).setValues([headers]);
  try {
    sheet.hideColumns(SHOPIFY_SYNC_CONFIG.COL_SHOPIFY_MATCH, headers.length);
  } catch (error) {
    console.warn("Could not hide Shopify sync columns:", error);
  }
}

function getLastShopifyInventorySyncResult() {
  const value = PropertiesService.getScriptProperties().getProperty(
    SHOPIFY_SYNC_CONFIG.LAST_RESULT_PROPERTY
  );
  if (!value) return { status: "never-run" };
  try { return JSON.parse(value); }
  catch (error) { return { status: "error", error: "Stored result is unreadable." }; }
}

function storeShopifySyncResult_(result) {
  PropertiesService.getScriptProperties().setProperty(
    SHOPIFY_SYNC_CONFIG.LAST_RESULT_PROPERTY,
    JSON.stringify(result)
  );
}

function openWholesaleSpreadsheet_() {
  return SpreadsheetApp.openById(SHOPIFY_SYNC_CONFIG.SPREADSHEET_ID);
}

function getWholesaleProductSheet_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(SHOPIFY_SYNC_CONFIG.PRODUCTS_SHEET_NAME);
  if (!sheet) {
    throw new Error('Wholesale product sheet "' + SHOPIFY_SYNC_CONFIG.PRODUCTS_SHEET_NAME + '" was not found.');
  }
  return sheet;
}

function fetchShopifyAccessToken_(credentials) {
  const response = UrlFetchApp.fetch(
    "https://" + credentials.shop + ".myshopify.com/admin/oauth/access_token",
    {
      method: "post",
      contentType: "application/x-www-form-urlencoded",
      payload: {
        grant_type: "client_credentials",
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret
      },
      muteHttpExceptions: true
    }
  );

  const statusCode = response.getResponseCode();
  let payload = {};
  try { payload = JSON.parse(response.getContentText()); } catch (error) {}

  if (statusCode < 200 || statusCode >= 300 || !payload.access_token) {
    throw new Error(
      "Shopify authentication failed (HTTP " + statusCode + "). " +
      cleanShopifyError_(payload, response.getContentText())
    );
  }
  return payload.access_token;
}

function shopifyGraphql_(shop, token, query, variables) {
  const response = UrlFetchApp.fetch(
    "https://" + shop + ".myshopify.com/admin/api/" + SHOPIFY_SYNC_CONFIG.API_VERSION + "/graphql.json",
    {
      method: "post",
      contentType: "application/json",
      headers: { "X-Shopify-Access-Token": token },
      payload: JSON.stringify({ query: query, variables: variables || {} }),
      muteHttpExceptions: true
    }
  );

  const statusCode = response.getResponseCode();
  let body = {};
  try { body = JSON.parse(response.getContentText()); } catch (error) {}

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(
      "Shopify GraphQL request failed (HTTP " + statusCode + "). " +
      cleanShopifyError_(body, response.getContentText())
    );
  }
  if (body.errors && body.errors.length) {
    throw new Error(
      "Shopify GraphQL error: " + body.errors.map(function (item) {
        return item.message;
      }).join("; ")
    );
  }
  if (!body.data) throw new Error("Shopify GraphQL returned no data.");
  return body.data;
}

function requireShopifyCredentials_() {
  const properties = PropertiesService.getScriptProperties();
  const shop = normalizeShopDomain_(properties.getProperty(SHOPIFY_SYNC_CONFIG.SHOP_PROPERTY));
  const clientId = cleanSyncText_(properties.getProperty(SHOPIFY_SYNC_CONFIG.CLIENT_ID_PROPERTY));
  const clientSecret = cleanSyncText_(properties.getProperty(SHOPIFY_SYNC_CONFIG.CLIENT_SECRET_PROPERTY));
  const missing = [];

  if (!shop) missing.push(SHOPIFY_SYNC_CONFIG.SHOP_PROPERTY);
  if (!clientId) missing.push(SHOPIFY_SYNC_CONFIG.CLIENT_ID_PROPERTY);
  if (!clientSecret) missing.push(SHOPIFY_SYNC_CONFIG.CLIENT_SECRET_PROPERTY);
  if (missing.length) {
    throw new Error("Missing Apps Script properties: " + missing.join(", ") + ".");
  }

  return { shop: shop, clientId: clientId, clientSecret: clientSecret };
}

function normalizeShopDomain_(value) {
  return cleanSyncText_(value)
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.myshopify\.com$/, "");
}

function normalizePack_(value) {
  return cleanSyncText_(value)
    .toLowerCase()
    .replace(/millilitres?|milliliters?/g, "ml")
    .replace(/[^a-z0-9]/g, "");
}

function logShopifySync_(spreadsheet, result, errorMessage) {
  const logs = spreadsheet.getSheetByName(SHOPIFY_SYNC_CONFIG.LOGS_SHEET_NAME);
  if (!logs) return;

  const s = result && result.summary ? result.summary : {};
  const text = result && result.status === "success"
    ? [
        "shopify=" + (s.activeShopifyProducts || 0),
        "displayed=" + (s.displayedWholesaleProducts || 0),
        "hidden=" + (s.hiddenBecauseLessThanOneCase || 0)
      ].join(", ")
    : "failed";

  logs.appendRow([
    new Date(),
    "",
    "",
    "SHOPIFY_INVENTORY_SYNC",
    safeSyncSheetCell_(text),
    safeSyncSheetCell_(errorMessage || "")
  ]);
}

function notifyShopifySyncFailure_(message) {
  try {
    MailApp.sendEmail({
      to: SHOPIFY_SYNC_CONFIG.FAILURE_EMAIL,
      subject: "Wholesale Shopify inventory sync failed",
      body: [
        "The daily Shopify → Designated Wholesale inventory sync failed.",
        "",
        "Error: " + message,
        "",
        "Sheet1 was not intentionally rebuilt after this failure.",
        "Open Apps Script Executions for details."
      ].join("\n"),
      name: "Designated Drinks Wholesale"
    });
  } catch (error) {
    console.error("Could not send Shopify sync failure email:", error);
  }
}

function safeSyncSheetCell_(value) {
  const text = cleanSyncText_(value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function cleanShopifyError_(payload, rawText) {
  if (payload && payload.error_description) {
    return cleanSyncText_(payload.error_description).slice(0, 240);
  }
  if (payload && payload.error) {
    return cleanSyncText_(payload.error).slice(0, 240);
  }
  return cleanSyncText_(rawText).slice(0, 240) || "No error details were returned.";
}

function cleanSyncText_(value) {
  return String(value == null ? "" : value).replace(/\u0000/g, "").trim();
}
