/**
 * Designated Drinks Wholesale — independent Shopify inventory sync.
 *
 * This file is intentionally self-contained. It can live in its own Google
 * Apps Script project and does NOT depend on the wholesale web-app Code.gs.
 *
 * Required Script Properties:
 *   SHOPIFY_SHOP          designateddrinks   (or designateddrinks.myshopify.com)
 *   SHOPIFY_CLIENT_ID     Shopify Dev Dashboard app Client ID
 *   SHOPIFY_CLIENT_SECRET Shopify Dev Dashboard app Client secret
 *
 * Required Shopify app scopes:
 *   read_products
 *   read_inventory
 *
 * Setup:
 *   1. Add the three Script Properties above.
 *   2. Run testShopifyInventoryConnection().
 *   3. Run setupShopifyInventorySync().
 *   4. Run syncShopifyWholesaleInventory() once to verify the first sync.
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
  DEFAULT_CASE_SIZE: 24,
  MAX_PAGES: 50
});


function setupShopifyInventorySync() {
  const connection = testShopifyInventoryConnection();
  ensureShopifySyncColumns_();
  installShopifyInventoryTrigger_();
  return {
    status: "ready",
    shop: connection.shop,
    trigger: "daily around 6:00 AM America/Toronto",
    apiVersion: SHOPIFY_SYNC_CONFIG.API_VERSION,
    spreadsheetId: SHOPIFY_SYNC_CONFIG.SPREADSHEET_ID
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
  const shop = normalizeShopDomain_(properties.getProperty(SHOPIFY_SYNC_CONFIG.SHOP_PROPERTY));
  return {
    spreadsheetId: SHOPIFY_SYNC_CONFIG.SPREADSHEET_ID,
    productSheet: SHOPIFY_SYNC_CONFIG.PRODUCTS_SHEET_NAME,
    shop: shop || "missing",
    clientIdConfigured: Boolean(cleanSyncText_(properties.getProperty(SHOPIFY_SYNC_CONFIG.CLIENT_ID_PROPERTY))),
    clientSecretConfigured: Boolean(cleanSyncText_(properties.getProperty(SHOPIFY_SYNC_CONFIG.CLIENT_SECRET_PROPERTY))),
    apiVersion: SHOPIFY_SYNC_CONFIG.API_VERSION,
    triggerInstalled: ScriptApp.getProjectTriggers().some(function (trigger) {
      return trigger.getHandlerFunction() === SHOPIFY_SYNC_CONFIG.HANDLER;
    }),
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
  if (!lock.tryLock(30000)) {
    throw new Error("Shopify inventory sync is already running.");
  }

  const startedAt = new Date();
  let spreadsheet = null;

  try {
    const credentials = requireShopifyCredentials_();
    const token = fetchShopifyAccessToken_(credentials);

    // Fetch the complete Shopify snapshot before any customer-visible sheet write.
    const products = fetchShopifyProductInventory_(credentials.shop, token);
    if (!products.length) throw new Error("Shopify returned no active products.");

    spreadsheet = openWholesaleSpreadsheet_();
    const sheet = getWholesaleProductSheet_(spreadsheet);
    ensureShopifySyncColumns_(sheet);

    const lastRow = sheet.getLastRow();
    if (lastRow < SHOPIFY_SYNC_CONFIG.FIRST_DATA_ROW) {
      const emptyResult = {
        status: "success",
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        summary: { rows: 0, matched: 0 }
      };
      storeShopifySyncResult_(emptyResult);
      logShopifySync_(spreadsheet, emptyResult, "");
      return emptyResult;
    }

    const rowCount = lastRow - SHOPIFY_SYNC_CONFIG.FIRST_DATA_ROW + 1;
    const values = sheet.getRange(
      SHOPIFY_SYNC_CONFIG.FIRST_DATA_ROW,
      1,
      rowCount,
      SHOPIFY_SYNC_CONFIG.COL_SYNC_STATUS
    ).getValues();

    const index = buildShopifyProductIndex_(products);
    const syncTime = new Date();
    const statusOutput = [];
    const metadataOutput = [];
    const summary = {
      rows: 0,
      matched: 0,
      matchedCasePack: 0,
      available: 0,
      unavailable: 0,
      unmatchedProduct: 0,
      unmatchedVariant: 0,
      skippedNonSingle: 0,
      blankRows: 0
    };

    values.forEach(function (row) {
      const title = cleanSyncText_(row[SHOPIFY_SYNC_CONFIG.COL_TITLE - 1]);
      const packSize = cleanSyncText_(row[SHOPIFY_SYNC_CONFIG.COL_PACK_SIZE - 1]);
      const existingStatus = cleanSyncText_(row[SHOPIFY_SYNC_CONFIG.COL_STATUS - 1]);
      const brand = cleanSyncText_(row[SHOPIFY_SYNC_CONFIG.COL_BRAND - 1]);
      const caseFormat = cleanSyncText_(row[SHOPIFY_SYNC_CONFIG.COL_CASE_FORMAT - 1]);
      const persistedMatch = cleanSyncText_(row[SHOPIFY_SYNC_CONFIG.COL_SHOPIFY_MATCH - 1]);
      const previousSync = row[SHOPIFY_SYNC_CONFIG.COL_LAST_SYNC - 1] || "";

      if (!title) {
        statusOutput.push([existingStatus]);
        metadataOutput.push([persistedMatch, "", "", previousSync, ""]);
        summary.blankRows += 1;
        return;
      }

      summary.rows += 1;

      // The wholesale catalogue is intended to derive cases from physical
      // single units. Rows that are themselves multipacks are deliberately not
      // allowed to change Status automatically.
      if (!isSingleUnitPack_(packSize)) {
        statusOutput.push([existingStatus]);
        metadataOutput.push([persistedMatch, "", "", syncTime, "skipped non-single wholesale row"]);
        summary.skippedNonSingle += 1;
        return;
      }

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
      } else {
        // Some Shopify products are tracked only as true case variants (for
        // example a 24 Pack). If an exact wholesale-case variant exists, use
        // that quantity directly rather than inventing single-unit inventory.
        const caseVariant = findExactCasePackVariant_(product.variants, caseSize);
        if (caseVariant) {
          casesAvailable = Math.max(0, Number(caseVariant.inventoryQuantity) || 0);
          availableUnits = casesAvailable * caseSize;
          matchStatus = "matched via case pack";
          summary.matchedCasePack += 1;
        }
      }

      if (casesAvailable == null) {
        statusOutput.push([existingStatus]);
        metadataOutput.push([product.title, "", "", syncTime, "unmatched inventory variant"]);
        summary.unmatchedVariant += 1;
        return;
      }

      summary.matched += 1;
      const nextStatus = casesAvailable >= 1 ? "yes" : "no";
      if (nextStatus === "yes") summary.available += 1;
      else summary.unavailable += 1;

      statusOutput.push([nextStatus]);
      metadataOutput.push([
        product.title,
        availableUnits,
        casesAvailable,
        syncTime,
        matchStatus
      ]);
    });

    // Diagnostics first; customer-visible Status last. If a diagnostics write
    // fails, the catalogue remains untouched.
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

    SpreadsheetApp.flush();

    const result = {
      status: "success",
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      summary: summary
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


function getLastShopifyInventorySyncResult() {
  const value = PropertiesService.getScriptProperties().getProperty(
    SHOPIFY_SYNC_CONFIG.LAST_RESULT_PROPERTY
  );
  if (!value) return { status: "never-run" };
  try {
    return JSON.parse(value);
  } catch (error) {
    return { status: "error", error: "Stored result is unreadable." };
  }
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
    throw new Error(
      'Wholesale product sheet "' + SHOPIFY_SYNC_CONFIG.PRODUCTS_SHEET_NAME + '" was not found.'
    );
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
  try {
    payload = JSON.parse(response.getContentText());
  } catch (error) {}

  if (statusCode < 200 || statusCode >= 300 || !payload.access_token) {
    throw new Error(
      "Shopify authentication failed (HTTP " + statusCode + "). " +
      cleanShopifyError_(payload, response.getContentText())
    );
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
          variants: []
        };
      }

      productsById[productId].variants.push({
        id: String(variant.id || ""),
        title: cleanSyncText_(variant.title),
        inventoryQuantity: Number(variant.inventoryQuantity) || 0
      });
    });

    after = connection.pageInfo && connection.pageInfo.hasNextPage
      ? connection.pageInfo.endCursor
      : null;
  } while (after);

  return Object.keys(productsById).map(function (key) {
    return productsById[key];
  });
}


function shopifyGraphql_(shop, token, query, variables) {
  const response = UrlFetchApp.fetch(
    "https://" + shop + ".myshopify.com/admin/api/" +
      SHOPIFY_SYNC_CONFIG.API_VERSION + "/graphql.json",
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
  try {
    body = JSON.parse(response.getContentText());
  } catch (error) {}

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
  const preferredMatches = index.byNormalizedTitle[normalizeShopifyText_(preferred)] || [];
  if (preferredMatches.length === 1) return preferredMatches[0];

  if (persistedMatch) {
    const titleMatches = index.byNormalizedTitle[normalizeShopifyText_(title)] || [];
    if (titleMatches.length === 1) return titleMatches[0];
  }

  const normalizedBrand = normalizeShopifyText_(brand);
  const candidates = index.products.filter(function (product) {
    const vendor = normalizeShopifyText_(product.vendor);
    const productTitle = normalizeShopifyText_(product.title);
    if (normalizedBrand && normalizedBrand !== "designated drinks") {
      return vendor === normalizedBrand || productTitle.indexOf(normalizedBrand + " ") === 0;
    }

    const firstWord = normalizeShopifyText_(title).split(" ")[0];
    return firstWord && productTitle.indexOf(firstWord + " ") === 0;
  });

  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) return null;

  const rowTokens = descriptorTokens_(title, brand);
  const scored = candidates.map(function (product) {
    return {
      product: product,
      score: tokenSimilarity_(
        rowTokens,
        descriptorTokens_(product.title, product.vendor)
      )
    };
  }).sort(function (a, b) {
    return b.score - a.score;
  });

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
  if (exact.length === 1 && isSingleUnitPack_(exact[0].title)) return exact[0];

  const targetMl = extractMl_(packSize);
  if (!targetMl) return null;

  const compatible = variants.filter(function (variant) {
    return isSingleUnitPack_(variant.title) && extractMl_(variant.title) === targetMl;
  });
  return compatible.length === 1 ? compatible[0] : null;
}


function findExactCasePackVariant_(variants, caseSize) {
  const compatible = variants.filter(function (variant) {
    const match = cleanSyncText_(variant.title).match(/^(\d+)\s*[- ]?pack$/i);
    return match && Number(match[1]) === Number(caseSize);
  });
  return compatible.length === 1 ? compatible[0] : null;
}


function parseWholesaleCaseSize_(caseFormat) {
  const match = cleanSyncText_(caseFormat).match(/^\s*(\d+)/);
  const size = match ? Number(match[1]) : SHOPIFY_SYNC_CONFIG.DEFAULT_CASE_SIZE;
  return Number.isFinite(size) && size > 0
    ? size
    : SHOPIFY_SYNC_CONFIG.DEFAULT_CASE_SIZE;
}


function isSingleUnitPack_(value) {
  const text = normalizePackText_(value);
  if (!text) return false;
  if (/^\d+pack$/.test(text)) return false;
  return /ml|can|bottle|single/.test(text);
}


function normalizePackText_(value) {
  return cleanSyncText_(value)
    .toLowerCase()
    .replace(/millilitres?|milliliters?/g, "ml")
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
    brewing: true,
    brewery: true,
    company: true,
    co: true,
    beer: true,
    alcoholic: true,
    non: true,
    limited: true,
    edition: true
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
  a.forEach(function (token) {
    if (bSet[token]) overlap += 1;
  });
  return (2 * overlap) / (a.length + b.length);
}


function normalizeShopifyText_(value) {
  let text = cleanSyncText_(value).toLowerCase();
  try {
    text = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  } catch (error) {}

  return text
    .replace(/[’‘]/g, "'")
    .replace(/[–—−]/g, "-")
    .replace(/&/g, " and ")
    .replace(/\bnon[\s-]*alcoholic\b/g, " ")
    .replace(/\blimited[\s-]*edition\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


function requireShopifyCredentials_() {
  const properties = PropertiesService.getScriptProperties();
  const shop = normalizeShopDomain_(
    properties.getProperty(SHOPIFY_SYNC_CONFIG.SHOP_PROPERTY)
  );
  const clientId = cleanSyncText_(
    properties.getProperty(SHOPIFY_SYNC_CONFIG.CLIENT_ID_PROPERTY)
  );
  const clientSecret = cleanSyncText_(
    properties.getProperty(SHOPIFY_SYNC_CONFIG.CLIENT_SECRET_PROPERTY)
  );

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


function ensureShopifySyncColumns_(optionalSheet) {
  const sheet = optionalSheet || getWholesaleProductSheet_(openWholesaleSpreadsheet_());
  const headers = [
    "Shopify Product Match",
    "Available Units",
    "Wholesale Cases Available",
    "Last Shopify Sync",
    "Shopify Sync Status"
  ];

  sheet.getRange(
    1,
    SHOPIFY_SYNC_CONFIG.COL_SHOPIFY_MATCH,
    1,
    headers.length
  ).setValues([headers]);

  const dataRows = Math.max(1, sheet.getMaxRows() - 1);
  sheet.getRange(
    SHOPIFY_SYNC_CONFIG.FIRST_DATA_ROW,
    SHOPIFY_SYNC_CONFIG.COL_LAST_SYNC,
    dataRows,
    1
  ).setNumberFormat("yyyy-mm-dd hh:mm");

  try {
    sheet.hideColumns(SHOPIFY_SYNC_CONFIG.COL_SHOPIFY_MATCH, headers.length);
  } catch (error) {
    console.warn("Could not hide Shopify sync columns:", error);
  }
}


function logShopifySync_(spreadsheet, result, errorMessage) {
  const logs = spreadsheet.getSheetByName(SHOPIFY_SYNC_CONFIG.LOGS_SHEET_NAME);
  if (!logs) return;

  const summary = result && result.summary ? result.summary : {};
  const resultText = result && result.status === "success"
    ? [
        "matched=" + (summary.matched || 0),
        "available=" + (summary.available || 0),
        "unavailable=" + (summary.unavailable || 0),
        "unmatchedProduct=" + (summary.unmatchedProduct || 0),
        "unmatchedVariant=" + (summary.unmatchedVariant || 0),
        "skippedNonSingle=" + (summary.skippedNonSingle || 0)
      ].join(", ")
    : "failed";

  // Match the existing Logs sheet's six-column layout without depending on the
  // wholesale backend's logEvent_ helper.
  logs.appendRow([
    new Date(),
    "",
    "",
    "SHOPIFY_INVENTORY_SYNC",
    safeSyncSheetCell_(resultText),
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
        "Customer-visible product Status was not intentionally changed after this failure.",
        "Open the Google Apps Script Executions screen for details."
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
