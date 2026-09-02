/**
 * Designated Drinks Wholesale — independent Shopify catalogue + inventory sync.
 *
 * Shopify Product ID is the permanent identity.
 * Shopify title, image, vendor, base variant title, and retail price are canonical.
 * Existing wholesale pricing remains 70% of Shopify retail per single unit.
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
  CASE_SIZE: 24,
  MAX_PAGES: 50
});

function setupShopifyInventorySync() {
  const connection = testShopifyInventoryConnection();
  const spreadsheet = openWholesaleSpreadsheet_();
  ensureShopifySyncColumns_(getWholesaleProductSheet_(spreadsheet));
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
  const data = shopifyGraphql_(credentials.shop, token, "query { shop { name myshopifyDomain } }", {});
  return { status: "success", shop: data.shop && (data.shop.myshopifyDomain || data.shop.name) || credentials.shop };
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
    const products = fetchShopifyProductInventory_(credentials.shop, token);
    if (!products.length) throw new Error("Shopify returned no active products.");

    spreadsheet = openWholesaleSpreadsheet_();
    const sheet = getWholesaleProductSheet_(spreadsheet);
    ensureShopifySyncColumns_(sheet);

    const initialLastRow = Math.max(sheet.getLastRow(), 1);
    const existingCount = Math.max(0, initialLastRow - 1);
    const existingValues = existingCount
      ? sheet.getRange(2, 1, existingCount, SHOPIFY_SYNC_CONFIG.COL_SHOPIFY_PRODUCT_ID).getValues()
      : [];

    const index = buildShopifyProductIndex_(products);
    const syncTime = new Date();
    const usedProductIds = {};
    const summary = {
      rows: existingCount,
      matched: 0,
      matchedById: 0,
      matchedByImage: 0,
      matchedByTitle: 0,
      added: 0,
      available: 0,
      unavailable: 0,
      unmatchedProduct: 0,
      unmatchedVariant: 0,
      skippedNonSingle: 0
    };

    const titleOutput = [];
    const packOutput = [];
    const retailOutput = [];
    const imageOutput = [];
    const statusOutput = [];
    const brandOutput = [];
    const categoryOutput = [];
    const styleOutput = [];
    const caseFormatOutput = [];
    const metadataOutput = [];

    existingValues.forEach(function (row) {
      const existingTitle = cleanSyncText_(row[SHOPIFY_SYNC_CONFIG.COL_TITLE - 1]);
      const existingPack = cleanSyncText_(row[SHOPIFY_SYNC_CONFIG.COL_PACK_SIZE - 1]);
      const existingRetail = row[SHOPIFY_SYNC_CONFIG.COL_RETAIL_PRICE - 1];
      const existingImage = cleanSyncText_(row[SHOPIFY_SYNC_CONFIG.COL_IMAGE_URL - 1]);
      const existingBrand = cleanSyncText_(row[SHOPIFY_SYNC_CONFIG.COL_BRAND - 1]);
      const existingCategory = cleanSyncText_(row[SHOPIFY_SYNC_CONFIG.COL_CATEGORY - 1]);
      const existingStyle = cleanSyncText_(row[SHOPIFY_SYNC_CONFIG.COL_STYLE - 1]);
      const existingCaseFormat = cleanSyncText_(row[SHOPIFY_SYNC_CONFIG.COL_CASE_FORMAT - 1]);
      const storedProductId = cleanSyncText_(row[SHOPIFY_SYNC_CONFIG.COL_SHOPIFY_PRODUCT_ID - 1]);

      if (!existingTitle) {
        titleOutput.push([""]);
        packOutput.push([existingPack]);
        retailOutput.push([existingRetail || ""]);
        imageOutput.push([existingImage]);
        statusOutput.push([""]);
        brandOutput.push([existingBrand]);
        categoryOutput.push([existingCategory]);
        styleOutput.push([existingStyle]);
        caseFormatOutput.push([existingCaseFormat]);
        metadataOutput.push(["", "", "", "", "", ""]);
        return;
      }

      const resolution = resolveExistingProduct_(storedProductId, existingTitle, existingImage, index);
      if (!resolution.product) {
        titleOutput.push([existingTitle]);
        packOutput.push([existingPack]);
        retailOutput.push([existingRetail || ""]);
        imageOutput.push([existingImage]);
        statusOutput.push(["no"]);
        brandOutput.push([existingBrand]);
        categoryOutput.push([existingCategory]);
        styleOutput.push([existingStyle]);
        caseFormatOutput.push([existingCaseFormat]);
        metadataOutput.push(["", "", "", syncTime, "unmatched product", ""]);
        summary.unmatchedProduct += 1;
        return;
      }

      const product = resolution.product;
      usedProductIds[product.id] = true;
      const baseVariant = chooseBaseVariant_(product.variants, existingPack);
      if (!baseVariant) {
        titleOutput.push([product.title]);
        packOutput.push([existingPack]);
        retailOutput.push([existingRetail || ""]);
        imageOutput.push([product.imageUrl || existingImage]);
        statusOutput.push(["no"]);
        brandOutput.push([product.vendor || existingBrand]);
        categoryOutput.push([inferCategory_(product)]);
        styleOutput.push([inferStyle_(product.title, inferCategory_(product))]);
        caseFormatOutput.push([existingCaseFormat || ("24 × " + existingPack)]);
        metadataOutput.push([product.title, "", "", syncTime, "unmatched inventory variant", product.id]);
        summary.unmatchedVariant += 1;
        return;
      }

      const availableUnits = Math.max(0, Number(baseVariant.inventoryQuantity) || 0);
      const casesAvailable = Math.floor(availableUnits / SHOPIFY_SYNC_CONFIG.CASE_SIZE);
      const category = inferCategory_(product);

      titleOutput.push([product.title]);
      packOutput.push([baseVariant.title]);
      retailOutput.push([Number(baseVariant.price) || existingRetail || ""]);
      imageOutput.push([product.imageUrl || existingImage]);
      statusOutput.push([casesAvailable >= 1 ? "yes" : "no"]);
      brandOutput.push([product.vendor || existingBrand]);
      categoryOutput.push([category]);
      styleOutput.push([inferStyle_(product.title, category)]);
      caseFormatOutput.push([SHOPIFY_SYNC_CONFIG.CASE_SIZE + " × " + baseVariant.title]);
      metadataOutput.push([product.title, availableUnits, casesAvailable, syncTime, resolution.method, product.id]);

      summary.matched += 1;
      summary[resolution.summaryKey] += 1;
      if (casesAvailable >= 1) summary.available += 1;
      else summary.unavailable += 1;
    });

    if (existingCount) {
      sheet.getRange(2, SHOPIFY_SYNC_CONFIG.COL_TITLE, existingCount, 1).setValues(titleOutput);
      sheet.getRange(2, SHOPIFY_SYNC_CONFIG.COL_PACK_SIZE, existingCount, 1).setValues(packOutput);
      sheet.getRange(2, SHOPIFY_SYNC_CONFIG.COL_RETAIL_PRICE, existingCount, 1).setValues(retailOutput);
      sheet.getRange(2, SHOPIFY_SYNC_CONFIG.COL_IMAGE_URL, existingCount, 1).setValues(imageOutput);
      sheet.getRange(2, SHOPIFY_SYNC_CONFIG.COL_STATUS, existingCount, 1).setValues(statusOutput);
      sheet.getRange(2, SHOPIFY_SYNC_CONFIG.COL_BRAND, existingCount, 1).setValues(brandOutput);
      sheet.getRange(2, SHOPIFY_SYNC_CONFIG.COL_CATEGORY, existingCount, 1).setValues(categoryOutput);
      sheet.getRange(2, SHOPIFY_SYNC_CONFIG.COL_STYLE, existingCount, 1).setValues(styleOutput);
      sheet.getRange(2, SHOPIFY_SYNC_CONFIG.COL_CASE_FORMAT, existingCount, 1).setValues(caseFormatOutput);
      sheet.getRange(2, SHOPIFY_SYNC_CONFIG.COL_SHOPIFY_MATCH, existingCount, 6).setValues(metadataOutput);
    }

    const nextSkuNumber = findNextSkuNumber_(existingValues);
    const nextSortOrder = findNextSortOrder_(existingValues);
    const newRows = [];
    let skuNumber = nextSkuNumber;
    let sortOrder = nextSortOrder;

    products.forEach(function (product) {
      if (usedProductIds[product.id]) return;
      const baseVariant = chooseBaseVariant_(product.variants, "");
      if (!baseVariant || !isEligibleShopifyBeverage_(product, baseVariant)) return;

      const availableUnits = Math.max(0, Number(baseVariant.inventoryQuantity) || 0);
      const casesAvailable = Math.floor(availableUnits / SHOPIFY_SYNC_CONFIG.CASE_SIZE);
      const category = inferCategory_(product);
      const rowNumber = initialLastRow + newRows.length + 1;
      const sku = "DDW-" + String(skuNumber).padStart(4, "0");

      newRows.push([
        product.title,
        baseVariant.title,
        Number(baseVariant.price) || 0,
        "=ROUND(C" + rowNumber + "*0.7, 2)",
        product.imageUrl || "",
        "=D" + rowNumber + "*" + SHOPIFY_SYNC_CONFIG.CASE_SIZE,
        casesAvailable >= 1 ? "yes" : "no",
        sku,
        product.vendor || "",
        category,
        inferStyle_(product.title, category),
        SHOPIFY_SYNC_CONFIG.CASE_SIZE + " × " + baseVariant.title,
        sortOrder,
        product.title,
        availableUnits,
        casesAvailable,
        syncTime,
        "added from Shopify",
        product.id
      ]);

      skuNumber += 1;
      sortOrder += 1;
      summary.added += 1;
      summary.matched += 1;
      if (casesAvailable >= 1) summary.available += 1;
      else summary.unavailable += 1;
    });

    if (newRows.length) {
      const startRow = initialLastRow + 1;
      const target = sheet.getRange(startRow, 1, newRows.length, SHOPIFY_SYNC_CONFIG.COL_SHOPIFY_PRODUCT_ID);
      target.setValues(newRows);

      if (initialLastRow >= 2) {
        sheet.getRange(initialLastRow, 1, 1, SHOPIFY_SYNC_CONFIG.COL_SHOPIFY_PRODUCT_ID)
          .copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
      }
      sheet.getRange(startRow, SHOPIFY_SYNC_CONFIG.COL_LAST_SYNC, newRows.length, 1)
        .setNumberFormat("yyyy-mm-dd hh:mm");
    }

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
  const value = PropertiesService.getScriptProperties().getProperty(SHOPIFY_SYNC_CONFIG.LAST_RESULT_PROPERTY);
  if (!value) return { status: "never-run" };
  try { return JSON.parse(value); }
  catch (error) { return { status: "error", error: "Stored result is unreadable." }; }
}

function resolveExistingProduct_(storedProductId, title, imageUrl, index) {
  if (storedProductId && index.byId[storedProductId]) {
    return { product: index.byId[storedProductId], method: "matched product id", summaryKey: "matchedById" };
  }

  const imageKey = normalizeImageUrl_(imageUrl);
  if (imageKey) {
    const imageMatches = index.byImage[imageKey] || [];
    if (imageMatches.length === 1) {
      return { product: imageMatches[0], method: "matched image", summaryKey: "matchedByImage" };
    }
  }

  const titleMatches = index.byTitle[normalizeTitle_(title)] || [];
  if (titleMatches.length === 1) {
    return { product: titleMatches[0], method: "matched exact title", summaryKey: "matchedByTitle" };
  }

  return { product: null, method: "unmatched product", summaryKey: "unmatchedProduct" };
}

function chooseBaseVariant_(variants, preferredPackSize) {
  const eligible = (variants || []).filter(function (variant) {
    return isSingleUnitVariant_(variant.title);
  });
  if (!eligible.length) return null;

  const preferred = normalizePack_(preferredPackSize);
  if (preferred) {
    const exact = eligible.filter(function (variant) {
      return normalizePack_(variant.title) === preferred;
    });
    if (exact.length === 1) return exact[0];
  }

  return eligible.length === 1 ? eligible[0] : null;
}

function isEligibleShopifyBeverage_(product, variant) {
  if (!product || !variant || !isSingleUnitVariant_(variant.title)) return false;
  const productType = cleanSyncText_(product.productType).toLowerCase();
  const tags = (product.tags || []).map(function (tag) { return cleanSyncText_(tag).toLowerCase(); });
  const title = cleanSyncText_(product.title).toLowerCase();
  return productType.indexOf("beverage") !== -1 || tags.some(function (tag) {
    return tag.indexOf("category_") === 0;
  }) || title.indexOf("non-alcoholic") !== -1 || title.indexOf("non alcoholic") !== -1;
}

function isSingleUnitVariant_(value) {
  const text = normalizePack_(value);
  if (!text) return false;
  if (/^\d+pack$/.test(text)) return false;
  return /\d+ml/.test(text) && /(can|bottle|single)/.test(text);
}

function buildShopifyProductIndex_(products) {
  const byId = {};
  const byImage = {};
  const byTitle = {};

  products.forEach(function (product) {
    byId[product.id] = product;

    const image = normalizeImageUrl_(product.imageUrl);
    if (image) {
      if (!byImage[image]) byImage[image] = [];
      byImage[image].push(product);
    }

    const title = normalizeTitle_(product.title);
    if (!byTitle[title]) byTitle[title] = [];
    byTitle[title].push(product);
  });

  return { byId: byId, byImage: byImage, byTitle: byTitle };
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
    if (page > SHOPIFY_SYNC_CONFIG.MAX_PAGES) throw new Error("Shopify pagination exceeded the safety limit.");

    const data = shopifyGraphql_(shop, token, query, { after: after });
    const connection = data.productVariants;
    if (!connection || !Array.isArray(connection.nodes)) throw new Error("Shopify inventory response was incomplete.");

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

    after = connection.pageInfo && connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);

  return Object.keys(productsById).map(function (key) { return productsById[key]; });
}

function inferCategory_(product) {
  const tags = (product.tags || []).map(function (tag) { return cleanSyncText_(tag).toLowerCase(); });
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

function findNextSkuNumber_(rows) {
  let max = 0;
  rows.forEach(function (row) {
    const match = cleanSyncText_(row[SHOPIFY_SYNC_CONFIG.COL_SKU - 1]).match(/^DDW-(\d+)$/i);
    if (match) max = Math.max(max, Number(match[1]) || 0);
  });
  return max + 1;
}

function findNextSortOrder_(rows) {
  let max = 0;
  rows.forEach(function (row) {
    max = Math.max(max, Number(row[SHOPIFY_SYNC_CONFIG.COL_SORT_ORDER - 1]) || 0);
  });
  return max + 1;
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
  sheet.getRange(2, SHOPIFY_SYNC_CONFIG.COL_LAST_SYNC, Math.max(1, sheet.getMaxRows() - 1), 1)
    .setNumberFormat("yyyy-mm-dd hh:mm");
  try { sheet.hideColumns(SHOPIFY_SYNC_CONFIG.COL_SHOPIFY_MATCH, headers.length); }
  catch (error) { console.warn("Could not hide Shopify sync columns:", error); }
}

function openWholesaleSpreadsheet_() {
  return SpreadsheetApp.openById(SHOPIFY_SYNC_CONFIG.SPREADSHEET_ID);
}

function getWholesaleProductSheet_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(SHOPIFY_SYNC_CONFIG.PRODUCTS_SHEET_NAME);
  if (!sheet) throw new Error('Wholesale product sheet "' + SHOPIFY_SYNC_CONFIG.PRODUCTS_SHEET_NAME + '" was not found.');
  return sheet;
}

function fetchShopifyAccessToken_(credentials) {
  const response = UrlFetchApp.fetch("https://" + credentials.shop + ".myshopify.com/admin/oauth/access_token", {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    payload: {
      grant_type: "client_credentials",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret
    },
    muteHttpExceptions: true
  });

  const statusCode = response.getResponseCode();
  let payload = {};
  try { payload = JSON.parse(response.getContentText()); } catch (error) {}
  if (statusCode < 200 || statusCode >= 300 || !payload.access_token) {
    throw new Error("Shopify authentication failed (HTTP " + statusCode + "). " + cleanShopifyError_(payload, response.getContentText()));
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
    throw new Error("Shopify GraphQL request failed (HTTP " + statusCode + "). " + cleanShopifyError_(body, response.getContentText()));
  }
  if (body.errors && body.errors.length) {
    throw new Error("Shopify GraphQL error: " + body.errors.map(function (item) { return item.message; }).join("; "));
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
  if (missing.length) throw new Error("Missing Apps Script properties: " + missing.join(", ") + ".");
  return { shop: shop, clientId: clientId, clientSecret: clientSecret };
}

function normalizeShopDomain_(value) {
  return cleanSyncText_(value).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.myshopify\.com$/, "");
}

function normalizeTitle_(value) {
  let text = cleanSyncText_(value).toLowerCase();
  try { text = text.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (error) {}
  return text.replace(/[’‘]/g, "'").replace(/[–—−]/g, "-").replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeImageUrl_(value) {
  return cleanSyncText_(value).replace(/[?&]v=\d+.*$/i, "").replace(/^https?:\/\//i, "").toLowerCase();
}

function normalizePack_(value) {
  return cleanSyncText_(value).toLowerCase().replace(/millilitres?|milliliters?/g, "ml").replace(/[^a-z0-9]/g, "");
}

function storeShopifySyncResult_(result) {
  PropertiesService.getScriptProperties().setProperty(SHOPIFY_SYNC_CONFIG.LAST_RESULT_PROPERTY, JSON.stringify(result));
}

function logShopifySync_(spreadsheet, result, errorMessage) {
  const logs = spreadsheet.getSheetByName(SHOPIFY_SYNC_CONFIG.LOGS_SHEET_NAME);
  if (!logs) return;
  const s = result && result.summary ? result.summary : {};
  const text = result && result.status === "success"
    ? ["matched=" + (s.matched || 0), "added=" + (s.added || 0), "available=" + (s.available || 0),
       "unavailable=" + (s.unavailable || 0), "unmatchedProduct=" + (s.unmatchedProduct || 0),
       "unmatchedVariant=" + (s.unmatchedVariant || 0)].join(", ")
    : "failed";
  logs.appendRow([new Date(), "", "", "SHOPIFY_INVENTORY_SYNC", safeSyncSheetCell_(text), safeSyncSheetCell_(errorMessage || "")]);
}

function notifyShopifySyncFailure_(message) {
  try {
    MailApp.sendEmail({
      to: SHOPIFY_SYNC_CONFIG.FAILURE_EMAIL,
      subject: "Wholesale Shopify inventory sync failed",
      body: "The daily Shopify → Designated Wholesale sync failed.\n\nError: " + message +
        "\n\nCustomer-visible product availability may be stale. Open Apps Script Executions for details.",
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
  if (payload && payload.error_description) return cleanSyncText_(payload.error_description).slice(0, 240);
  if (payload && payload.error) return cleanSyncText_(payload.error).slice(0, 240);
  return cleanSyncText_(rawText).slice(0, 240) || "No error details were returned.";
}

function cleanSyncText_(value) {
  return String(value == null ? "" : value).replace(/\u0000/g, "").trim();
}
