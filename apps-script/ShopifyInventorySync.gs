/**
 * Designated Drinks Wholesale — independent Shopify inventory sync.
 *
 * This file runs entirely inside Google Apps Script. ChatGPT is not involved.
 * Shopify remains the inventory source of truth; the existing wholesale sheet
 * remains the catalogue/order source consumed by the website.
 *
 * Required Script Properties:
 *   SHOPIFY_SHOP          designateddrinks   (or designateddrinks.myshopify.com)
 *   SHOPIFY_CLIENT_ID     Dev Dashboard app client ID
 *   SHOPIFY_CLIENT_SECRET Dev Dashboard app client secret
 *
 * Required Shopify app scopes:
 *   read_products
 *   read_inventory
 *
 * After adding the properties, run setupShopifyInventorySync() once.
 */
const SHOPIFY_SYNC_CONFIG = Object.freeze({
  API_VERSION: "2026-07",
  SHOP_PROPERTY: "SHOPIFY_SHOP",
  CLIENT_ID_PROPERTY: "SHOPIFY_CLIENT_ID",
  CLIENT_SECRET_PROPERTY: "SHOPIFY_CLIENT_SECRET",
  TIME_ZONE: "America/Toronto",
  TRIGGER_HOUR: 6,
  HANDLER: "syncShopifyWholesaleInventory",
  FIRST_DATA_ROW: 2,
  COL_TITLE: 1,
  COL_PACK_SIZE: 2,
  COL_STATUS: 7,
  COL_BRAND: 9,
  COL_CASE_FORMAT: 12,
  COL_SHOPIFY_MATCH: 14,
  COL_AVAILABLE_UNITS: 15,
  COL_CASES_AVAILABLE: 16,
  COL_LAST_SYNC: 17,
  COL_SYNC_STATUS: 18,
  PRODUCT_PAGE_SIZE: 250,
  DEFAULT_CASE_SIZE: 24
});


function setupShopifyInventorySync() {
  ensureShopifySyncColumns_();
  requireShopifyCredentials_();
  const connection = testShopifyInventoryConnection();
  installShopifyInventoryTrigger_();
  return {
    status: "ready",
    shop: connection.shop,
    trigger: "daily around 6:00 AM America/Toronto",
    apiVersion: SHOPIFY_SYNC_CONFIG.API_VERSION
  };
}


function testShopifyInventoryConnection() {
  const credentials = requireShopifyCredentials_();
  const token = fetchShopifyAccessToken_(credentials);
  const data = shopifyGraphql_(credentials.shop, token, "query { shop { name myshopifyDomain } }");
  return {
    status: "success",
    shop: data.shop && (data.shop.myshopifyDomain || data.shop.name) || credentials.shop
  };
}


function installShopifyInventoryTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === SHOPIFY_SYNC_CONFIG.HANDLER) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

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
  try {
    const credentials = requireShopifyCredentials_();
    const token = fetchShopifyAccessToken_(credentials);

    // Fetch the complete Shopify snapshot before touching customer-visible status.
    const products = fetchShopifyProductInventory_(credentials.shop, token);
    if (!products.length) throw new Error("Shopify returned no active products.");

    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName(CONFIG.PRODUCTS_SHEET_NAME);
    if (!sheet) throw new Error("Wholesale product sheet was not found.");

    ensureShopifySyncColumns_();

    const lastRow = sheet.getLastRow();
    if (lastRow < SHOPIFY_SYNC_CONFIG.FIRST_DATA_ROW) {
      return { status: "success", updated: 0, message: "No wholesale products to sync." };
    }

    const rowCount = lastRow - SHOPIFY_SYNC_CONFIG.FIRST_DATA_ROW + 1;
    const values = sheet.getRange(SHOPIFY_SYNC_CONFIG.FIRST_DATA_ROW, 1, rowCount, SHOPIFY_SYNC_CONFIG.COL_SYNC_STATUS).getValues();
    const index = buildShopifyProductIndex_(products);
    const syncTime = new Date();

    const statusOutput = [];
    const metadataOutput = [];
    const summary = {
      rows: 0,
      matched: 0,
      matchedCasePack: 0,
      unavailable: 0,
      unmatchedProduct: 0,
      unmatchedVariant: 0,
      unchangedBlankRows: 0
    };

    values.forEach(function (row) {
      const title = cleanSyncText_(row[SHOPIFY_SYNC_CONFIG.COL_TITLE - 1]);
      const existingStatus = cleanSyncText_(row[SHOPIFY_SYNC_CONFIG.COL_STATUS - 1]);
      const packSize = cleanSyncText_(row[SHOPIFY_SYNC_CONFIG.COL_PACK_SIZE - 1]);
      const brand = cleanSyncText_(row[SHOPIFY_SYNC_CONFIG.COL_BRAND - 1]);
      const caseFormat = cleanSyncText_(row[SHOPIFY_SYNC_CONFIG.COL_CASE_FORMAT - 1]);
      const persistedMatch = cleanSyncText_(row[SHOPIFY_SYNC_CONFIG.COL_SHOPIFY_MATCH - 1]);

      if (!title) {
        statusOutput.push([existingStatus]);
        metadataOutput.push([persistedMatch, "", "", row[SHOPIFY_SYNC_CONFIG.COL_LAST_SYNC - 1] || "", ""]);
        summary.unchangedBlankRows += 1;
        return;
      }

      summary.rows += 1;
      const product = findShopifyProductMatch_(title, brand, persistedMatch, index);
      if (!product) {
        statusOutput.push([existingStatus]);
        metadataOutput.push([persistedMatch, "", "", syncTime, "unmatched product"]);
        summary.unmatchedProduct += 1;
        return;
      }

      const caseSize = parseWholesaleCaseSize_(caseFormat);
      const baseVariant = findBaseInventoryVariant_(product.variants, packSize);
      let availableUnits = null;
      let casesAvailable = null;
      let matchStatus = "";

      if (baseVariant) {
        availableUnits = Math.max(0, Number(baseVariant.inventoryQuantity) || 0);
        casesAvailable = Math.floor(availableUnits / caseSize);
        matchStatus = "matched";
        summary.matched += 1;
      } else if (isSingleUnitPack_(packSize)) {
        const caseVariant = findExactCasePackVariant_(product.variants, caseSize);
        if (caseVariant) {
          casesAvailable = Math.max(0, Number(caseVariant.inventoryQuantity) || 0);
          availableUnits = casesAvailable * caseSize;
          matchStatus = "matched via case pack";
          summary.matched += 1;
          summary.matchedCasePack += 1;
        }
      }

      if (casesAvailable == null) {
        statusOutput.push([existingStatus]);
        metadataOutput.push([product.title, "", "", syncTime, "unmatched inventory variant"]);
        summary.unmatchedVariant += 1;
        return;
      }

      const nextStatus = casesAvailable >= 1 ? "yes" : "no";
      if (nextStatus === "no") summary.unavailable += 1;
      statusOutput.push([nextStatus]);
      metadataOutput.push([product.title, availableUnits, casesAvailable, syncTime, matchStatus]);
    });

    // Write diagnostics first. Status is deliberately written last so a metadata
    // write failure cannot partially change what customers see on the website.
    sheet.getRange(
      SHOPIFY_SYNC_CONFIG.FIRST_DATA_ROW,
      SHOPIFY_SYNC_CONFIG.COL_SHOPIFY_MATCH,
      rowCount,
      5
    ).setValues(metadataOutput);

    sheet.getRange(
      SHOPIFY_SYNC_CONFIG.FIRST_DATA_ROW,
      SHOPIFY_SYNC_CONFIG.COL_STATUS,
      rowCount,
      1
    ).setValues(statusOutput);

    CacheService.getScriptCache().remove("ddw-products-v" + CONFIG.VERSION);

    const result = {
      status: "success",
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      summary: summary
    };
    PropertiesService.getScriptProperties().setProperty("SHOPIFY_SYNC_LAST_RESULT", JSON.stringify(result));
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
    PropertiesService.getScriptProperties().setProperty("SHOPIFY_SYNC_LAST_RESULT", JSON.stringify(failed));
    try {
      const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
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


function getLastShopifyInventorySyncResult() {
  const value = PropertiesService.getScriptProperties().getProperty("SHOPIFY_SYNC_LAST_RESULT");
  if (!value) return { status: "never-run" };
  try { return JSON.parse(value); } catch (error) { return { status: "error", error: "Stored result is unreadable." }; }
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
  let payload;
  try { payload = JSON.parse(response.getContentText()); } catch (error) { payload = {}; }
  if (statusCode < 200 || statusCode >= 300 || !payload.access_token) {
    throw new Error("Shopify authentication failed (HTTP " + statusCode + "). " + cleanShopifyError_(payload, response.getContentText()));
  }
  return payload.access_token;
}


function fetchShopifyProductInventory_(shop, token) {
  const query = [
    "query WholesaleInventory($after: String) {",
    "  productVariants(first: 250, after: $after) {",
    "    nodes {",
    "      id",
    "      title",
    "      inventoryQuantity",
    "      product { id title vendor status }",
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
    if (page > 50) throw new Error("Shopify pagination exceeded the safety limit.");
    const data = shopifyGraphql_(shop, token, query, { after: after });
    const connection = data.productVariants;
    if (!connection || !Array.isArray(connection.nodes)) throw new Error("Shopify inventory response was incomplete.");

    connection.nodes.forEach(function (variant) {
      if (!variant || !variant.product || String(variant.product.status || "").toUpperCase() !== "ACTIVE") return;
      const productId = String(variant.product.id || "");
      if (!productsById[productId]) {
        productsById[productId] = {
          id: productId,
          title: cleanSyncText_(variant.product.title),
          vendor: cleanSyncText_(variant.product.vendor),
          variants: []
        };
      }
      productsById[productId].variants.push({
        id: String(variant.id || ""),
        title: cleanSyncText_(variant.title),
        inventoryQuantity: Math.max(0, Number(variant.inventoryQuantity) || 0)
      });
    });

    after = connection.pageInfo && connection.pageInfo.hasNextPage
      ? connection.pageInfo.endCursor
      : null;
  } while (after);

  return Object.keys(productsById).map(function (key) { return productsById[key]; });
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
  let body;
  try { body = JSON.parse(response.getContentText()); } catch (error) { body = {}; }
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error("Shopify GraphQL request failed (HTTP " + statusCode + "). " + cleanShopifyError_(body, response.getContentText()));
  }
  if (body.errors && body.errors.length) {
    throw new Error("Shopify GraphQL error: " + body.errors.map(function (item) { return item.message; }).join("; "));
  }
  if (!body.data) throw new Error("Shopify GraphQL returned no data.");
  return body.data;
}


function buildShopifyProductIndex_(products) {
  const byNormalizedTitle = {};
  products.forEach(function (product) {
    const key = normalizeShopifyText_(product.title);
    if (!byNormalizedTitle[key]) byNormalizedTitle[key] = [];
    byNormalizedTitle[key].push(product);
  });
  return { products: products, byNormalizedTitle: byNormalizedTitle };
}


function findShopifyProductMatch_(title, brand, persistedMatch, index) {
  const preferred = persistedMatch || title;
  const preferredKey = normalizeShopifyText_(preferred);
  const preferredMatches = index.byNormalizedTitle[preferredKey] || [];
  if (preferredMatches.length === 1) return preferredMatches[0];

  if (persistedMatch) {
    const rowMatches = index.byNormalizedTitle[normalizeShopifyText_(title)] || [];
    if (rowMatches.length === 1) return rowMatches[0];
  }

  const rowBrand = normalizeShopifyText_(brand);
  const titleKey = normalizeShopifyText_(title);
  const inferredBrand = titleKey.split(" ").slice(0, 5).join(" ");
  const candidates = index.products.filter(function (product) {
    const vendor = normalizeShopifyText_(product.vendor);
    const productTitle = normalizeShopifyText_(product.title);
    if (rowBrand && rowBrand !== "designated drinks" && (vendor === rowBrand || productTitle.indexOf(rowBrand + " ") === 0)) return true;
    return inferredBrand && productTitle.indexOf(inferredBrand) === 0;
  });

  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) return null;

  const rowTokens = descriptorTokens_(title, brand);
  const scored = candidates.map(function (product) {
    return { product: product, score: tokenSimilarity_(rowTokens, descriptorTokens_(product.title, product.vendor)) };
  }).sort(function (a, b) { return b.score - a.score; });

  if (!scored.length || scored[0].score < 0.72) return null;
  if (scored.length > 1 && scored[0].score - scored[1].score < 0.15) return null;
  return scored[0].product;
}


function findBaseInventoryVariant_(variants, packSize) {
  const target = normalizePackText_(packSize);
  if (!target) return null;

  const exact = variants.filter(function (variant) {
    return normalizePackText_(variant.title) === target;
  });
  if (exact.length === 1) return exact[0];

  const targetMl = extractMl_(packSize);
  if (!targetMl) return null;
  const compatible = variants.filter(function (variant) {
    if (!isSingleUnitPack_(variant.title)) return false;
    return extractMl_(variant.title) === targetMl;
  });
  return compatible.length === 1 ? compatible[0] : null;
}


function findExactCasePackVariant_(variants, caseSize) {
  const compatible = variants.filter(function (variant) {
    const match = cleanSyncText_(variant.title).match(/^(\d+)\s*[- ]?pack$/i);
    return match && Number(match[1]) === caseSize;
  });
  return compatible.length === 1 ? compatible[0] : null;
}


function parseWholesaleCaseSize_(caseFormat) {
  const match = cleanSyncText_(caseFormat).match(/^\s*(\d+)/);
  const size = match ? Number(match[1]) : SHOPIFY_SYNC_CONFIG.DEFAULT_CASE_SIZE;
  return Number.isFinite(size) && size > 0 ? size : SHOPIFY_SYNC_CONFIG.DEFAULT_CASE_SIZE;
}


function isSingleUnitPack_(value) {
  const text = normalizePackText_(value);
  if (!text) return false;
  if (/\b\d+pack\b/.test(text) || /^\d+pack$/.test(text)) return false;
  return /ml|can|bottle|single/.test(text);
}


function normalizePackText_(value) {
  return cleanSyncText_(value)
    .toLowerCase()
    .replace(/[×x]/g, "x")
    .replace(/millilitres?|milliliters?/g, "ml")
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9]/g, "");
}


function extractMl_(value) {
  const match = cleanSyncText_(value).toLowerCase().match(/(\d+)\s*ml\b/);
  return match ? Number(match[1]) : 0;
}


function descriptorTokens_(title, brand) {
  let normalized = normalizeShopifyText_(title);
  const normalizedBrand = normalizeShopifyText_(brand);
  if (normalizedBrand && normalized.indexOf(normalizedBrand) === 0) {
    normalized = normalized.slice(normalizedBrand.length).trim();
  }
  const stop = {
    brewing: true, brewery: true, company: true, co: true,
    beer: true, alcoholic: true, non: true, limited: true, edition: true
  };
  const seen = {};
  return normalized.split(" ").filter(function (token) {
    if (!token || stop[token] || seen[token]) return false;
    seen[token] = true;
    return true;
  });
}


function tokenSimilarity_(a, b) {
  if (!a.length || !b.length) return 0;
  const bSet = {};
  b.forEach(function (token) { bSet[token] = true; });
  let overlap = 0;
  a.forEach(function (token) { if (bSet[token]) overlap += 1; });
  return (2 * overlap) / (a.length + b.length);
}


function normalizeShopifyText_(value) {
  let text = cleanSyncText_(value).toLowerCase();
  try { text = text.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (error) {}
  return text
    .replace(/[’‘]/g, "'")
    .replace(/[–—−]/g, "-")
    .replace(/&/g, " and ")
    .replace(/\bnon[\s-]*alcoholic\b/g, " ")
    .replace(/\blimited[\s-]*edition\b/g, " ")
    .replace(/\bkolsch\b/g, "kolsch")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  if (missing.length) throw new Error("Missing Apps Script properties: " + missing.join(", ") + ".");
  return { shop: shop, clientId: clientId, clientSecret: clientSecret };
}


function normalizeShopDomain_(value) {
  return cleanSyncText_(value)
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.myshopify\.com$/, "");
}


function ensureShopifySyncColumns_() {
  const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = spreadsheet.getSheetByName(CONFIG.PRODUCTS_SHEET_NAME);
  if (!sheet) throw new Error("Wholesale product sheet was not found.");

  const headers = [
    "Shopify Product Match",
    "Available Units",
    "Wholesale Cases Available",
    "Last Shopify Sync",
    "Shopify Sync Status"
  ];
  sheet.getRange(1, SHOPIFY_SYNC_CONFIG.COL_SHOPIFY_MATCH, 1, headers.length).setValues([headers]);
  sheet.getRange(2, SHOPIFY_SYNC_CONFIG.COL_LAST_SYNC, Math.max(1, sheet.getMaxRows() - 1), 1)
    .setNumberFormat("yyyy-mm-dd hh:mm");
  try { sheet.hideColumns(SHOPIFY_SYNC_CONFIG.COL_SHOPIFY_MATCH, headers.length); } catch (error) { console.warn(error); }
}


function logShopifySync_(spreadsheet, result, errorMessage) {
  const logs = spreadsheet.getSheetByName(CONFIG.LOGS_SHEET_NAME);
  if (!logs) return;
  const summary = result && result.summary ? result.summary : {};
  const message = result && result.status === "success"
    ? "matched=" + (summary.matched || 0) + ", unavailable=" + (summary.unavailable || 0) +
      ", unmatchedProduct=" + (summary.unmatchedProduct || 0) + ", unmatchedVariant=" + (summary.unmatchedVariant || 0)
    : "failed";
  if (typeof logEvent_ === "function") {
    logEvent_(logs, "", "", "shopify-inventory-sync", message, errorMessage || "");
  }
}


function notifyShopifySyncFailure_(message) {
  try {
    MailApp.sendEmail({
      to: CONFIG.SALES_EMAIL,
      subject: "Wholesale Shopify inventory sync failed",
      body: [
        "The daily Shopify → Designated Wholesale inventory sync failed.",
        "",
        "Error: " + message,
        "",
        "The wholesale Status column was not intentionally changed after the failure.",
        "Open the Apps Script Executions screen for details."
      ].join("\n"),
      name: "Designated Drinks Wholesale"
    });
  } catch (error) {
    console.error("Could not send Shopify sync failure email:", error);
  }
}


function cleanShopifyError_(payload, rawText) {
  if (payload && payload.error_description) return cleanSyncText_(payload.error_description).slice(0, 240);
  if (payload && payload.error) return cleanSyncText_(payload.error).slice(0, 240);
  return cleanSyncText_(rawText).slice(0, 240) || "No error details were returned.";
}


function cleanSyncText_(value) {
  return String(value == null ? "" : value).replace(/\u0000/g, "").trim();
}
