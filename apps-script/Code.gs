/**
 * Designated Drinks Wholesale backend v8.0
 * Reliable order persistence, province-aware GST/HST, live catalogue pricing,
 * server-side inventory caps, idempotent submissions, and fast saved-status polling.
 */
const CONFIG = Object.freeze({
  SPREADSHEET_ID: "17bcjrwi7Ah8_SXaPc9VrCIi2fdYnnNofmUoGy4LKBQ8",
  PRODUCTS_SHEET_NAME: "Sheet1",
  ORDERS_SHEET_NAME: "Orders",
  ORDER_ITEMS_SHEET_NAME: "Order Items",
  SETTINGS_SHEET_NAME: "Settings",
  LOGS_SHEET_NAME: "Logs",
  SALES_EMAIL: "sales@designateddrinks.ca",
  BACKUP_EMAIL: "designateddrinksonline@gmail.com",
  SUPPORT_EMAIL: "sales@designateddrinks.ca",
  MAX_ITEMS: 200,
  MAX_QUANTITY_PER_ITEM: 999,
  STATUS_TTL_SECONDS: 21600,
  STATUS_RETENTION_MS: 24 * 60 * 60 * 1000,
  PRODUCT_CACHE_SECONDS: 30,
  BRAND_LOGO_URL: "https://designateddrinks.github.io/designated-wholesale/dd-logo.png",
  BRAND_WEBSITE: "https://designateddrinks.ca",
  VERSION: "8.1"
});

const TAX_RULES = Object.freeze({
  AB: { province: "Alberta", label: "GST", rate: 0.05 },
  BC: { province: "British Columbia", label: "GST", rate: 0.05 },
  MB: { province: "Manitoba", label: "GST", rate: 0.05 },
  NB: { province: "New Brunswick", label: "HST", rate: 0.15 },
  NL: { province: "Newfoundland and Labrador", label: "HST", rate: 0.15 },
  NS: { province: "Nova Scotia", label: "HST", rate: 0.14 },
  NT: { province: "Northwest Territories", label: "GST", rate: 0.05 },
  NU: { province: "Nunavut", label: "GST", rate: 0.05 },
  ON: { province: "Ontario", label: "HST", rate: 0.13 },
  PE: { province: "Prince Edward Island", label: "HST", rate: 0.15 },
  QC: { province: "Quebec", label: "GST", rate: 0.05 },
  SK: { province: "Saskatchewan", label: "GST", rate: 0.05 },
  YT: { province: "Yukon", label: "GST", rate: 0.05 }
});

const ORDER_HEADERS = Object.freeze([
  "Order ID", "Timestamp", "Company", "Contact", "Email", "Phone", "Fulfilment",
  "Delivery Address", "PO Number", "Notes", "Total Cases", "Subtotal", "Sales Tax",
  "Estimated Total", "Order Status", "Notification Status", "Notification Warnings",
  "Submission ID", "Province", "Tax Label", "Tax Rate"
]);

const ITEM_HEADERS = Object.freeze([
  "Order ID", "SKU", "Product", "Brand", "Quantity", "Case Format", "Case Price", "Line Total"
]);

const LOG_HEADERS = Object.freeze([
  "Timestamp", "Submission ID", "Order ID", "Action", "Result", "Error"
]);

const SETTINGS_HEADERS = Object.freeze(["Key", "Value", "Description"]);

function doGet(e) {
  const parameters = e && e.parameter ? e.parameter : {};
  const action = cleanText_(parameters.action, 40).toLowerCase();
  const callback = cleanCallback_(parameters.callback);
  let payload;

  try {
    if (action === "products") {
      payload = { status: "success", version: CONFIG.VERSION, products: getPublicProducts_() };
    } else if (action === "status") {
      const submissionId = cleanText_(parameters.submissionId, 120);
      payload = submissionId ? getStatus_(submissionId) : { status: "error", message: "Missing submission ID." };
    } else if (action === "tax") {
      const code = normalizeProvince_(parameters.province) || "ON";
      payload = Object.assign({ status: "success", code: code }, TAX_RULES[code]);
    } else {
      payload = { status: "ok", version: CONFIG.VERSION, message: "Wholesale order endpoint is live." };
    }
  } catch (error) {
    console.error("doGet error:", error);
    payload = { status: "error", message: "The wholesale service could not complete the request." };
  }

  return outputResponse_(payload, callback);
}

function doPost(e) {
  let lock = null;
  let submissionId = "";
  let orderId = "";

  try {
    if (!e || !e.parameter) throw new Error("No order data was received.");
    const parameters = e.parameter;
    submissionId = cleanText_(parameters.submissionId, 120);
    if (!submissionId) throw new Error("The order is missing its submission ID.");

    cleanupOldStatuses_();
    const prior = getStatus_(submissionId);
    if (prior && prior.status === "success") return textResponse_("duplicate");

    setStatus_(submissionId, {
      status: "processing",
      stage: "validating",
      message: "The order is being validated."
    });

    if (cleanText_(parameters.website, 200)) {
      setStatus_(submissionId, { status: "success", stage: "complete" });
      return textResponse_("success");
    }

    const customer = parseCustomer_(parameters);
    const requestedItems = parseItems_(parameters);
    if (!requestedItems.length) throw new Error("Please select at least one product.");
    if (requestedItems.length > CONFIG.MAX_ITEMS) throw new Error("The order contains too many line items.");

    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheets = ensureSystemSheets_(spreadsheet);
    const settings = getSettings_(sheets.settings);
    if (String(settings.ordering_enabled || "true").toLowerCase() === "false") {
      throw new Error("Wholesale ordering is temporarily unavailable. Please contact " + settings.support_email + ".");
    }

    lock = LockService.getScriptLock();
    lock.waitLock(30000);

    const existing = findOrderBySubmissionId_(sheets.orders, submissionId);
    if (existing && existing.status === "RECEIVED") {
      const duplicatePayload = statusPayloadFromOrder_(existing);
      setStatus_(submissionId, duplicatePayload);
      lock.releaseLock();
      lock = null;
      return textResponse_("duplicate");
    }

    // Read the live Sheet1 catalogue while holding the lock. This revalidates
    // price, active status, and maximum wholesale cases at submit time.
    const catalog = getProductCatalog_(spreadsheet);
    const pricedItems = priceItemsFromCatalog_(requestedItems, catalog);
    const totals = calculateTotals_(pricedItems, taxRuleForCustomer_(customer));
    const now = new Date();

    if (existing) {
      orderId = existing.orderId;
      clearOrderItems_(sheets.orderItems, orderId);
      writeOrderRow_(sheets.orders, existing.row, orderId, now, customer, totals, "WRITING", "PENDING", "", submissionId);
    } else {
      orderId = createOrderId_(sheets.orders, now);
      const row = Math.max(sheets.orders.getLastRow() + 1, 2);
      writeOrderRow_(sheets.orders, row, orderId, now, customer, totals, "WRITING", "PENDING", "", submissionId);
    }

    writeOrderItems_(sheets.orderItems, orderId, pricedItems);
    SpreadsheetApp.flush();
    verifyPersistedOrder_(sheets.orders, sheets.orderItems, orderId, submissionId, pricedItems.length);

    const saved = findOrderBySubmissionId_(sheets.orders, submissionId);
    if (!saved) throw new Error("The saved order could not be verified.");
    sheets.orders.getRange(saved.row, 15).setValue("RECEIVED");
    SpreadsheetApp.flush();

    // This status is intentionally set before email work. The frontend can
    // close immediately once persistence is confirmed instead of waiting for MailApp.
    setStatus_(submissionId, statusPayload_("processing", "saved", orderId, totals, [], "sending"));
    logEvent_(sheets.logs, submissionId, orderId, "ORDER_SAVED", "SUCCESS", "");

    lock.releaseLock();
    lock = null;

    const notification = sendNotifications_(now, orderId, customer, pricedItems, totals, settings);
    sheets.orders.getRange(saved.row, 16, 1, 2).setValues([[
      notification.status,
      notification.warnings.join(", ")
    ]]);
    SpreadsheetApp.flush();

    logEvent_(sheets.logs, submissionId, orderId, "NOTIFICATIONS", notification.status, notification.warnings.join(", "));
    setStatus_(submissionId, statusPayload_(
      "success", "complete", orderId, totals, notification.warnings, notification.status.toLowerCase()
    ));
    return textResponse_("success");

  } catch (error) {
    const message = error && error.message ? String(error.message) : "The order could not be processed.";
    console.error("doPost error:", error);

    try {
      const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
      const logs = spreadsheet.getSheetByName(CONFIG.LOGS_SHEET_NAME);
      if (logs) logEvent_(logs, submissionId, orderId, "ORDER_SUBMISSION", "ERROR", message);
      const orders = spreadsheet.getSheetByName(CONFIG.ORDERS_SHEET_NAME);
      if (orders && submissionId) {
        const existing = findOrderBySubmissionId_(orders, submissionId);
        if (existing && existing.status !== "RECEIVED") orders.getRange(existing.row, 15).setValue("ERROR");
      }
    } catch (loggingError) {
      console.error("Failure logging also failed:", loggingError);
    }

    if (submissionId) setStatus_(submissionId, { status: "error", message: message });
    return textResponse_("error");
  } finally {
    if (lock) {
      try { lock.releaseLock(); } catch (releaseError) { console.error(releaseError); }
    }
  }
}

function setupSystem() {
  const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheets = ensureSystemSheets_(spreadsheet);
  ensureProductMetadata_(sheets.products);
  seedSettings_(sheets.settings);
  formatSystemSheets_(sheets);
  CacheService.getScriptCache().remove(productCacheKey_());
  Logger.log("Designated Drinks Wholesale v" + CONFIG.VERSION + " is ready.");
}

function ensureSystemSheets_(spreadsheet) {
  const products = spreadsheet.getSheetByName(CONFIG.PRODUCTS_SHEET_NAME);
  if (!products) throw new Error('The product sheet "' + CONFIG.PRODUCTS_SHEET_NAME + '" was not found.');
  return {
    products: products,
    orders: getOrCreateSheet_(spreadsheet, CONFIG.ORDERS_SHEET_NAME, ORDER_HEADERS),
    orderItems: getOrCreateSheet_(spreadsheet, CONFIG.ORDER_ITEMS_SHEET_NAME, ITEM_HEADERS),
    settings: getOrCreateSheet_(spreadsheet, CONFIG.SETTINGS_SHEET_NAME, SETTINGS_HEADERS),
    logs: getOrCreateSheet_(spreadsheet, CONFIG.LOGS_SHEET_NAME, LOG_HEADERS)
  };
}

function getOrCreateSheet_(spreadsheet, name, headers) {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) sheet = spreadsheet.insertSheet(name);
  ensureHeaders_(sheet, headers);
  return sheet;
}

function ensureHeaders_(sheet, headers) {
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
}

function ensureProductMetadata_(sheet) {
  const headers = ["SKU", "Brand", "Category", "Style", "Case Format", "Sort Order"];
  sheet.getRange(1, 8, 1, headers.length).setValues([headers]);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const rows = sheet.getRange(2, 1, lastRow - 1, 13).getValues();
  const values = rows.map(function (row, index) {
    const title = cleanText_(row[0], 300);
    const packSize = cleanText_(row[1], 100);
    const parts = splitProductTitle_(title);
    const category = cleanText_(row[9], 80) || inferCategory_(title);
    return [
      cleanText_(row[7], 80) || "DDW-" + String(index + 2).padStart(4, "0"),
      cleanText_(row[8], 160) || parts.brand,
      category,
      cleanText_(row[10], 100) || inferStyle_(title, category),
      cleanText_(row[11], 100) || (packSize ? "24 × " + packSize : "Case"),
      Number(row[12]) || index + 2
    ];
  });
  sheet.getRange(2, 8, values.length, 6).setValues(values);
}

function seedSettings_(sheet) {
  if (sheet.getLastRow() > 1) return;
  sheet.getRange(2, 1, 5, 3).setValues([
    ["internal_notification_email", CONFIG.SALES_EMAIL, "Primary wholesale notification recipient"],
    ["backup_notification_email", CONFIG.BACKUP_EMAIL, "Backup wholesale notification recipient"],
    ["support_email", CONFIG.SUPPORT_EMAIL, "Customer-facing support email"],
    ["ordering_enabled", "true", "Set to false to pause new orders"],
    ["shipping_message", "Availability and freight are confirmed before invoicing.", "Confirmation note"]
  ]);
}

function getSettings_(sheet) {
  const settings = {
    internal_notification_email: CONFIG.SALES_EMAIL,
    backup_notification_email: CONFIG.BACKUP_EMAIL,
    support_email: CONFIG.SUPPORT_EMAIL,
    ordering_enabled: "true",
    shipping_message: "Availability and freight are confirmed before invoicing."
  };
  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(function (row) {
      const key = cleanText_(row[0], 100);
      if (key) settings[key] = row[1];
    });
  }
  return settings;
}

function formatSystemSheets_(sheets) {
  [sheets.orders, sheets.orderItems, sheets.settings, sheets.logs].forEach(function (sheet) {
    const lastColumn = sheet.getLastColumn();
    sheet.getRange(1, 1, 1, lastColumn)
      .setBackground("#071c33")
      .setFontColor("#ffffff")
      .setFontWeight("bold");
  });
  sheets.orders.getRange("L:N").setNumberFormat("$0.00");
  sheets.orders.getRange("U:U").setNumberFormat("0.00%");
  sheets.orderItems.getRange("G:H").setNumberFormat("$0.00");
}

function parseCustomer_(parameters) {
  const fulfilment = cleanText_(parameters.fulfilment || parameters.deliveryMethod, 30) || "Delivery";
  const deliveryAddress = cleanText_(parameters.deliveryAddress, 500);
  let province = normalizeProvince_(parameters.province || parameters.deliveryProvince || parameters.provinceCode);
  if (fulfilment === "Pickup") province = "ON";
  else if (!province) province = provinceFromAddress_(deliveryAddress);

  const customer = {
    contact: cleanText_(parameters.fullName || parameters.contactName, 120),
    company: cleanText_(parameters.companyName, 160),
    email: cleanText_(parameters.email, 200).toLowerCase(),
    phone: cleanText_(parameters.phone, 40),
    fulfilment: fulfilment,
    deliveryAddress: deliveryAddress,
    province: province,
    poNumber: cleanText_(parameters.poNumber, 80),
    notes: cleanText_(parameters.notes, 500)
  };

  if (!customer.company) throw new Error("Company name is required.");
  if (!customer.contact) throw new Error("Contact name is required.");
  if (!isValidEmail_(customer.email)) throw new Error("A valid email address is required.");
  if (customer.phone.replace(/\D/g, "").length < 7) throw new Error("A valid phone number is required.");
  if (customer.fulfilment !== "Delivery" && customer.fulfilment !== "Pickup") throw new Error("Choose delivery or pickup.");
  if (customer.fulfilment === "Delivery" && !customer.deliveryAddress) throw new Error("A delivery address is required.");
  if (!TAX_RULES[customer.province]) throw new Error("Select a valid Canadian province or territory.");
  return customer;
}

function normalizeProvince_(value) {
  let text = cleanText_(value, 80).toUpperCase();
  if (TAX_RULES[text]) return text;
  try { text = text.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (error) {}
  text = text.replace(/[^A-Z]/g, "");
  const aliases = {
    ALBERTA: "AB", BRITISHCOLUMBIA: "BC", MANITOBA: "MB", NEWBRUNSWICK: "NB",
    NEWFOUNDLANDANDLABRADOR: "NL", NEWFOUNDLANDLABRADOR: "NL", NOVASCOTIA: "NS",
    NORTHWESTTERRITORIES: "NT", NUNAVUT: "NU", ONTARIO: "ON", PRINCEEDWARDISLAND: "PE",
    QUEBEC: "QC", SASKATCHEWAN: "SK", YUKON: "YT"
  };
  return aliases[text] || "";
}

function provinceFromAddress_(address) {
  const text = String(address || "").toUpperCase();
  const codes = Object.keys(TAX_RULES);
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    if (new RegExp("(?:^|[,\\s])" + code + "(?:\\s+[A-Z]\\d[A-Z]|[,\\s]|$)").test(text)) return code;
  }
  return "";
}

function taxRuleForCustomer_(customer) {
  const code = customer.fulfilment === "Pickup" ? "ON" : customer.province;
  const rule = TAX_RULES[code];
  if (!rule) throw new Error("Sales tax could not be determined for the delivery province.");
  return { code: code, province: rule.province, label: rule.label, rate: rule.rate };
}

function parseItems_(parameters) {
  if (parameters.items) {
    try {
      const parsed = JSON.parse(parameters.items);
      if (Array.isArray(parsed)) {
        return parsed.map(function (item) {
          return {
            sku: cleanText_(item.sku, 80),
            catalogTitle: cleanText_(item.catalogTitle, 300),
            cases: cleanQuantity_(item.cases)
          };
        }).filter(validRequestedItem_);
      }
    } catch (error) {
      throw new Error("The order items were not formatted correctly.");
    }
  }

  const itemMap = {};
  Object.keys(parameters).forEach(function (key) {
    const match = key.match(/^item_(\d+)_(sku|catalogTitle|cases)$/);
    if (!match) return;
    const index = Number(match[1]);
    const field = match[2];
    if (!itemMap[index]) itemMap[index] = { sku: "", catalogTitle: "", cases: 0 };
    itemMap[index][field] = field === "cases"
      ? cleanQuantity_(parameters[key])
      : cleanText_(parameters[key], field === "sku" ? 80 : 300);
  });

  return Object.keys(itemMap)
    .map(Number)
    .sort(function (a, b) { return a - b; })
    .map(function (index) { return itemMap[index]; })
    .filter(validRequestedItem_);
}

function validRequestedItem_(item) {
  return Boolean((item.sku || item.catalogTitle) && item.cases > 0);
}

function getProductCatalog_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(CONFIG.PRODUCTS_SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error("The product catalogue is empty.");

  const width = Math.max(sheet.getLastColumn(), 19);
  const rows = sheet.getRange(2, 1, lastRow - 1, width).getValues();
  const bySku = {};
  const byTitle = {};
  const publicProducts = [];

  rows.forEach(function (row, index) {
    const sheetRow = index + 2;
    const catalogTitle = cleanText_(row[0], 300);
    const status = cleanText_(row[6], 30).toLowerCase();
    if (!catalogTitle || !["yes", "active", "true"].includes(status)) return;

    const casePrice = roundMoney_(Number(row[5]));
    if (!Number.isFinite(casePrice) || casePrice <= 0) return;
    const maxCasesRaw = Math.floor(Number(row[15]) || 0);
    const maxCases = maxCasesRaw > 0 ? Math.min(maxCasesRaw, CONFIG.MAX_QUANTITY_PER_ITEM) : CONFIG.MAX_QUANTITY_PER_ITEM;
    const parts = splitProductTitle_(catalogTitle);
    const category = cleanText_(row[9], 80) || inferCategory_(catalogTitle);

    const product = {
      sku: cleanText_(row[7], 80) || "DDW-" + String(sheetRow).padStart(4, "0"),
      productId: cleanText_(row[18], 120),
      catalogTitle: catalogTitle,
      brand: cleanText_(row[8], 160) || parts.brand,
      name: parts.name,
      category: category,
      style: cleanText_(row[10], 100) || inferStyle_(catalogTitle, category),
      packageSize: cleanText_(row[1], 100),
      caseFormat: cleanText_(row[11], 100) || "24 × " + cleanText_(row[1], 100),
      casePrice: casePrice,
      imageUrl: cleanText_(row[4], 1000),
      active: true,
      sortOrder: Number(row[12]) || sheetRow,
      maxCases: maxCases
    };
    bySku[product.sku] = product;
    byTitle[product.catalogTitle] = product;
    publicProducts.push(product);
  });

  return { bySku: bySku, byTitle: byTitle, publicProducts: publicProducts };
}

function productCacheKey_() {
  return "ddw-products-v" + CONFIG.VERSION;
}

function getPublicProducts_() {
  const cache = CacheService.getScriptCache();
  const key = productCacheKey_();
  const cached = cache.get(key);
  if (cached) return JSON.parse(cached);

  const products = getProductCatalog_(SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)).publicProducts.sort(function (a, b) {
    return a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name);
  });
  cache.put(key, JSON.stringify(products), CONFIG.PRODUCT_CACHE_SECONDS);
  return products;
}

function priceItemsFromCatalog_(requestedItems, catalog) {
  const seen = {};
  return requestedItems.map(function (item) {
    const product = (item.sku && catalog.bySku[item.sku]) ||
      (item.catalogTitle && catalog.byTitle[item.catalogTitle]);
    if (!product) throw new Error("A selected product is unavailable or its price could not be confirmed.");
    if (seen[product.sku]) throw new Error("The order contains a duplicated product.");
    if (item.cases > product.maxCases) {
      throw new Error(
        "Only " + product.maxCases + " case" + (product.maxCases === 1 ? "" : "s") +
        " of " + product.name + " are currently available."
      );
    }
    seen[product.sku] = true;
    return {
      sku: product.sku,
      catalogTitle: product.catalogTitle,
      displayTitle: product.brand + " – " + product.name,
      brand: product.brand,
      name: product.name,
      caseFormat: product.caseFormat,
      imageUrl: product.imageUrl,
      cases: item.cases,
      unitPrice: product.casePrice,
      lineTotal: roundMoney_(item.cases * product.casePrice)
    };
  });
}

function calculateTotals_(items, taxRule) {
  const subtotal = roundMoney_(items.reduce(function (sum, item) { return sum + item.lineTotal; }, 0));
  const totalCases = items.reduce(function (sum, item) { return sum + item.cases; }, 0);
  const tax = roundMoney_(subtotal * taxRule.rate);
  return {
    totalCases: totalCases,
    subtotal: subtotal,
    tax: tax,
    hst: tax,
    total: roundMoney_(subtotal + tax),
    province: taxRule.code,
    provinceName: taxRule.province,
    taxLabel: taxRule.label,
    taxRate: taxRule.rate
  };
}

function writeOrderRow_(sheet, row, orderId, now, customer, totals, orderStatus, notificationStatus, warnings, submissionId) {
  const values = [
    orderId, now, safeSheetCell_(customer.company), safeSheetCell_(customer.contact),
    safeSheetCell_(customer.email), safeSheetCell_(customer.phone), customer.fulfilment,
    safeSheetCell_(customer.deliveryAddress), safeSheetCell_(customer.poNumber), safeSheetCell_(customer.notes),
    totals.totalCases, totals.subtotal, totals.tax, totals.total, orderStatus, notificationStatus,
    warnings, submissionId, totals.province, totals.taxLabel, totals.taxRate
  ];
  sheet.getRange(row, 1, 1, values.length).setValues([values]);
  sheet.getRange(row, 12, 1, 3).setNumberFormat("$0.00");
  sheet.getRange(row, 21).setNumberFormat("0.00%");
}

function writeOrderItems_(sheet, orderId, items) {
  const startRow = Math.max(sheet.getLastRow() + 1, 2);
  const values = items.map(function (item) {
    return [
      orderId, item.sku, safeSheetCell_(item.displayTitle), safeSheetCell_(item.brand),
      item.cases, safeSheetCell_(item.caseFormat), item.unitPrice, item.lineTotal
    ];
  });
  sheet.getRange(startRow, 1, values.length, ITEM_HEADERS.length).setValues(values);
  sheet.getRange(startRow, 7, values.length, 2).setNumberFormat("$0.00");
}

function clearOrderItems_(sheet, orderId) {
  if (sheet.getLastRow() < 2) return;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (String(values[i][0]) === orderId) sheet.deleteRow(i + 2);
  }
}

function verifyPersistedOrder_(orders, orderItems, orderId, submissionId, expectedItems) {
  const order = findOrderBySubmissionId_(orders, submissionId);
  if (!order || order.orderId !== orderId) throw new Error("The order row was not saved correctly.");
  let count = 0;
  if (orderItems.getLastRow() >= 2) {
    orderItems.getRange(2, 1, orderItems.getLastRow() - 1, 1).getValues().forEach(function (row) {
      if (String(row[0]) === orderId) count += 1;
    });
  }
  if (count !== expectedItems) throw new Error("Not every order item was saved correctly.");
}

function findOrderBySubmissionId_(sheet, submissionId) {
  if (!submissionId || sheet.getLastRow() < 2) return null;
  const columns = Math.max(ORDER_HEADERS.length, 18);
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, columns).getValues();
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const row = values[i];
    if (String(row[17]) !== submissionId) continue;
    return {
      row: i + 2,
      orderId: String(row[0]),
      totalCases: Number(row[10]) || 0,
      subtotal: Number(row[11]) || 0,
      tax: Number(row[12]) || 0,
      hst: Number(row[12]) || 0,
      total: Number(row[13]) || 0,
      status: String(row[14]),
      notificationStatus: String(row[15]),
      warnings: String(row[16] || ""),
      province: String(row[18] || ""),
      taxLabel: String(row[19] || ""),
      taxRate: Number(row[20]) || 0
    };
  }
  return null;
}

function createOrderId_(sheet, date) {
  const datePart = Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyyMMdd");
  const prefix = "DDW-" + datePart + "-";
  let highest = 0;
  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().forEach(function (row) {
      const value = String(row[0] || "");
      if (value.indexOf(prefix) === 0) highest = Math.max(highest, Number(value.slice(prefix.length)) || 0);
    });
  }
  return prefix + String(highest + 1).padStart(3, "0");
}

function statusPayload_(status, stage, orderId, totals, warnings, emailStatus) {
  return {
    status: status,
    stage: stage,
    orderId: orderId,
    totalCases: totals.totalCases,
    subtotal: totals.subtotal,
    tax: totals.tax,
    hst: totals.tax,
    total: totals.total,
    province: totals.province,
    provinceName: totals.provinceName,
    taxLabel: totals.taxLabel,
    taxRate: totals.taxRate,
    warnings: warnings || [],
    emailStatus: emailStatus || ""
  };
}

function statusPayloadFromOrder_(order) {
  return {
    status: "success",
    stage: "complete",
    orderId: order.orderId,
    totalCases: order.totalCases,
    subtotal: order.subtotal,
    tax: order.tax,
    hst: order.tax,
    total: order.total,
    province: order.province,
    taxLabel: order.taxLabel,
    taxRate: order.taxRate,
    warnings: order.warnings ? order.warnings.split(", ").filter(Boolean) : [],
    emailStatus: (order.notificationStatus || "").toLowerCase()
  };
}

function setStatus_(submissionId, payload) {
  const stored = Object.assign({}, payload, { updatedAt: Date.now() });
  const key = "wholesale-status:" + submissionId;
  const value = JSON.stringify(stored);
  PropertiesService.getScriptProperties().setProperty(key, value);
  CacheService.getScriptCache().put(key, value, CONFIG.STATUS_TTL_SECONDS);
}

function getStatus_(submissionId) {
  const key = "wholesale-status:" + submissionId;
  const cache = CacheService.getScriptCache();
  const raw = cache.get(key) || PropertiesService.getScriptProperties().getProperty(key);
  if (raw) {
    try { return JSON.parse(raw); } catch (error) { console.error(error); }
  }

  try {
    const orders = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.ORDERS_SHEET_NAME);
    if (orders) {
      const order = findOrderBySubmissionId_(orders, submissionId);
      if (order && order.status === "RECEIVED") return statusPayloadFromOrder_(order);
      if (order) return { status: "processing", stage: "saved", orderId: order.orderId };
    }
  } catch (error) {
    console.error("Durable status lookup failed:", error);
  }
  return { status: "pending", message: "The order has not been confirmed yet." };
}

function cleanupOldStatuses_() {
  const properties = PropertiesService.getScriptProperties();
  const all = properties.getProperties();
  const cutoff = Date.now() - CONFIG.STATUS_RETENTION_MS;
  const remove = [];
  Object.keys(all).forEach(function (key) {
    if (key.indexOf("wholesale-status:") !== 0) return;
    try {
      const payload = JSON.parse(all[key]);
      if (!payload.updatedAt || Number(payload.updatedAt) < cutoff) remove.push(key);
    } catch (error) {
      remove.push(key);
    }
  });
  if (remove.length) properties.deleteProperties(remove);
}

function taxSummaryLabel_(totals) {
  return totals.taxLabel + " (" + Math.round(totals.taxRate * 100) + "%)" +
    (totals.provinceName ? " – " + totals.provinceName : "");
}

function sendNotifications_(now, orderId, customer, items, totals, settings) {
  const warnings = [];
  let internalSent = false;
  const internalSubject = "New wholesale order · " + safeSubject_(customer.company) + " · " + orderId;
  const internalText = buildSalesEmailText_(now, orderId, customer, items, totals);
  const internalHtml = buildSalesEmailHtml_(now, orderId, customer, items, totals);

  try {
    MailApp.sendEmail({
      to: settings.internal_notification_email,
      replyTo: customer.email,
      subject: internalSubject,
      body: internalText,
      htmlBody: internalHtml,
      name: "Designated Drinks Wholesale"
    });
    internalSent = true;
  } catch (error) {
    console.error("Primary internal email failed:", error);
    warnings.push("internal-primary-email");
  }

  if (settings.backup_notification_email && settings.backup_notification_email !== settings.internal_notification_email) {
    try {
      MailApp.sendEmail({
        to: settings.backup_notification_email,
        replyTo: customer.email,
        subject: "Backup · " + internalSubject,
        body: internalText,
        htmlBody: internalHtml,
        name: "Designated Drinks Wholesale"
      });
      internalSent = true;
    } catch (error) {
      console.error("Backup internal email failed:", error);
      warnings.push("internal-backup-email");
    }
  }
  if (!internalSent) warnings.push("internal-email");

  try {
    MailApp.sendEmail({
      to: customer.email,
      replyTo: settings.support_email,
      subject: "Wholesale order received · " + orderId,
      body: buildCustomerEmailText_(orderId, customer, items, totals, settings),
      htmlBody: buildCustomerEmailHtml_(orderId, customer, items, totals, settings),
      name: "Designated Drinks"
    });
  } catch (error) {
    console.error("Customer confirmation failed:", error);
    warnings.push("customer-email");
  }

  return {
    status: warnings.length ? (internalSent ? "PARTIAL" : "FAILED") : "SENT",
    warnings: warnings
  };
}

function buildSalesEmailText_(now, orderId, customer, items, totals) {
  const details = [
    "New wholesale order: " + orderId,
    customer.company + " · " + customer.contact + " · " + customer.email + " · " + customer.phone,
    customer.fulfilment + (customer.deliveryAddress ? " · " + customer.deliveryAddress.replace(/\n/g, ", ") : ""),
    customer.poNumber ? "PO: " + customer.poNumber : "",
    customer.notes ? "Notes: " + customer.notes : "",
    "",
    buildSummary_(items),
    "",
    "Cases: " + totals.totalCases + " · Subtotal: " + formatMoney_(totals.subtotal),
    taxSummaryLabel_(totals) + ": " + formatMoney_(totals.tax),
    "Estimated total: " + formatMoney_(totals.total),
    "Received: " + now
  ];
  return details.filter(Boolean).join("\n");
}

function buildCustomerEmailText_(orderId, customer, items, totals, settings) {
  return [
    "Designated Drinks Wholesale",
    "",
    "Hi " + customer.contact + ",",
    "We received " + customer.company + "'s wholesale order (" + orderId + ").",
    "",
    buildSummary_(items),
    "",
    "Cases: " + totals.totalCases,
    "Subtotal: " + formatMoney_(totals.subtotal),
    taxSummaryLabel_(totals) + ": " + formatMoney_(totals.tax),
    "Estimated total: " + formatMoney_(totals.total),
    "",
    settings.shipping_message,
    "We'll confirm final availability, timing and freight before invoicing.",
    "",
    "Questions? " + settings.support_email
  ].join("\n");
}

function buildSummary_(items) {
  return items.map(function (item) {
    return item.displayTitle + " · " + item.cases + " case" + (item.cases === 1 ? "" : "s") +
      " · " + formatMoney_(item.lineTotal);
  }).join("\n");
}

function buildSalesEmailHtml_(now, orderId, customer, items, totals) {
  const metaRows = [
    buildEmailMetaRow_("Contact", customer.contact),
    buildEmailMetaRow_("Email", customer.email),
    buildEmailMetaRow_("Phone", customer.phone),
    buildEmailMetaRow_("Fulfilment", customer.fulfilment),
    customer.deliveryAddress ? buildEmailMetaRow_("Delivery address", htmlMultiline_(customer.deliveryAddress), true) : "",
    customer.poNumber ? buildEmailMetaRow_("PO number", customer.poNumber) : "",
    customer.notes ? buildEmailMetaRow_("Notes", htmlMultiline_(customer.notes), true) : ""
  ].join("");

  const content = [
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 22px;border-collapse:collapse">',
      '<tr><td style="padding:18px 20px;background:#f4f7fa;border:1px solid #dce5ec;border-radius:14px">',
        '<div style="font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#597086;margin-bottom:6px">Customer</div>',
        '<div style="font-size:22px;line-height:1.25;font-weight:800;color:#071c33;margin-bottom:14px">' + htmlEscape_(customer.company) + '</div>',
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">' + metaRows + '</table>',
      '</td></tr>',
    '</table>',
    buildEmailProductsHtml_(items),
    buildEmailTotalsHtml_(totals),
    '<div style="margin-top:22px;padding:16px 18px;background:#eaf5ff;border-radius:12px;color:#24435f;font-size:13px;line-height:1.55">',
      '<strong>Received:</strong> ' + htmlEscape_(formatEmailDate_(now)) + '<br>',
      'Reply directly to this email to respond to ' + htmlEscape_(customer.contact) + '.',
    '</div>'
  ].join("");

  return buildEmailShell_(
    "NEW WHOLESALE ORDER",
    "Order " + orderId,
    "A new wholesale order has been recorded and verified.",
    content,
    "Internal Designated Drinks notification"
  );
}

function buildCustomerEmailHtml_(orderId, customer, items, totals, settings) {
  const fulfilmentTitle = customer.fulfilment === "Pickup" ? "Pickup" : "Delivery";
  const fulfilmentCopy = customer.fulfilment === "Pickup"
    ? "We'll confirm when your order is ready for pickup."
    : "We'll confirm delivery timing and freight before invoicing.";

  const content = [
    '<div style="margin:0 0 22px;font-size:15px;line-height:1.65;color:#42586b">',
      'Hi ' + htmlEscape_(customer.contact) + ',<br><br>',
      'We received the wholesale order for <strong style="color:#071c33">' + htmlEscape_(customer.company) + '</strong>. ',
      'Here’s a clean summary of what was submitted.',
    '</div>',
    buildEmailProductsHtml_(items),
    buildEmailTotalsHtml_(totals),
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:22px;border-collapse:separate;border-spacing:0">',
      '<tr><td style="padding:18px 20px;background:#f4f7fa;border:1px solid #dce5ec;border-radius:14px">',
        '<div style="font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#597086;margin-bottom:7px">' + htmlEscape_(fulfilmentTitle) + '</div>',
        customer.deliveryAddress ? '<div style="font-size:14px;line-height:1.55;color:#071c33;margin-bottom:8px">' + htmlMultiline_(customer.deliveryAddress) + '</div>' : '',
        '<div style="font-size:13px;line-height:1.55;color:#597086">' + htmlEscape_(fulfilmentCopy) + '</div>',
      '</td></tr>',
    '</table>',
    '<div style="margin-top:18px;padding:16px 18px;background:#eaf5ff;border-radius:12px;color:#24435f;font-size:13px;line-height:1.55">',
      htmlEscape_(settings.shipping_message) + '<br>',
      'This confirms your order request; it is not the final invoice.',
    '</div>'
  ].join("");

  return buildEmailShell_(
    "ORDER RECEIVED",
    "Thanks, " + customer.contact + ".",
    "Order " + orderId,
    content,
    'Questions? <a href="mailto:' + htmlEscape_(settings.support_email) + '" style="color:#1684d9;text-decoration:none;font-weight:700">' + htmlEscape_(settings.support_email) + '</a>'
  );
}

function buildEmailProductsHtml_(items) {
  const rows = items.map(function (item, index) {
    const border = index === items.length - 1 ? "" : "border-bottom:1px solid #e4ebf0;";
    const image = item.imageUrl
      ? '<img src="' + htmlEscape_(item.imageUrl) + '" width="64" alt="' + htmlEscape_(item.brand + " " + item.name) + '" style="display:block;width:64px;max-width:64px;height:auto;max-height:92px;margin:0 auto">'
      : '<div style="width:64px;height:72px;line-height:72px;text-align:center;border-radius:8px;background:#eef3f6;color:#7b8d9d;font-size:11px;font-weight:800">DRINK</div>';

    return [
      '<tr>',
        '<td width="82" valign="middle" style="padding:14px 10px 14px 0;' + border + '">' + image + '</td>',
        '<td valign="middle" style="padding:14px 10px;' + border + '">',
          '<div style="font-size:11px;font-weight:800;letter-spacing:.055em;text-transform:uppercase;color:#1684d9;margin-bottom:4px">' + htmlEscape_(item.brand) + '</div>',
          '<div style="font-size:15px;line-height:1.35;font-weight:800;color:#071c33">' + htmlEscape_(item.name) + '</div>',
          '<div style="font-size:12px;line-height:1.45;color:#708293;margin-top:5px">' + htmlEscape_(item.caseFormat) + ' · ' + item.cases + ' case' + (item.cases === 1 ? '' : 's') + '</div>',
        '</td>',
        '<td width="94" valign="middle" align="right" style="padding:14px 0 14px 10px;' + border + '">',
          '<div style="font-size:15px;font-weight:800;color:#071c33">' + formatMoney_(item.lineTotal) + '</div>',
          '<div style="font-size:11px;color:#8292a0;margin-top:3px">' + formatMoney_(item.unitPrice) + ' / case</div>',
        '</td>',
      '</tr>'
    ].join("");
  }).join("");

  return [
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#ffffff;border:1px solid #dce5ec;border-radius:14px">',
      '<tr><td colspan="3" style="padding:15px 16px 6px;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#597086">Order items</td></tr>',
      rows,
    '</table>'
  ].join("");
}

function buildEmailTotalsHtml_(totals) {
  return [
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:16px;border-collapse:separate;border-spacing:0;background:#071c33;border-radius:14px;color:#ffffff">',
      '<tr>',
        '<td style="padding:18px 20px;font-size:13px;line-height:1.75;color:#c9d7e3">',
          'Total cases<br>Subtotal<br>' + htmlEscape_(totals.taxLabel) + ' (' + Math.round(totals.taxRate * 100) + '%)',
        '</td>',
        '<td align="right" style="padding:18px 20px;font-size:13px;line-height:1.75;color:#ffffff">',
          '<strong>' + totals.totalCases + '</strong><br>' + formatMoney_(totals.subtotal) + '<br>' + formatMoney_(totals.tax),
        '</td>',
      '</tr>',
      '<tr><td colspan="2" style="border-top:1px solid #29435d;padding:15px 20px 18px">',
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>',
          '<td style="font-size:14px;font-weight:700;color:#d9e5ee">Estimated total</td>',
          '<td align="right" style="font-size:22px;font-weight:800;color:#ffffff">' + formatMoney_(totals.total) + '</td>',
        '</tr></table>',
      '</td></tr>',
    '</table>'
  ].join("");
}

function buildEmailShell_(eyebrow, title, subtitle, content, footer) {
  return [
    '<!doctype html><html><body style="margin:0;padding:0;background:#f2f5f7;font-family:Arial,Helvetica,sans-serif;color:#071c33">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#f2f5f7;margin:0;padding:0">',
      '<tr><td align="center" style="padding:28px 12px">',
        '<table role="presentation" width="620" cellspacing="0" cellpadding="0" style="width:100%;max-width:620px;border-collapse:separate;border-spacing:0">',
          '<tr><td style="padding:18px 22px;background:#071c33;border-radius:16px 16px 0 0">',
            '<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>',
              '<td width="54"><img src="' + htmlEscape_(CONFIG.BRAND_LOGO_URL) + '" width="44" height="44" alt="Designated Drinks" style="display:block;width:44px;height:44px;border-radius:10px"></td>',
              '<td style="font-size:15px;font-weight:800;letter-spacing:.02em;color:#ffffff">DESIGNATED DRINKS<br><span style="font-size:11px;font-weight:600;letter-spacing:.08em;color:#9eb5c8">WHOLESALE</span></td>',
            '</tr></table>',
          '</td></tr>',
          '<tr><td style="padding:28px 26px 30px;background:#ffffff;border-radius:0 0 16px 16px">',
            '<div style="font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#1684d9;margin-bottom:8px">' + htmlEscape_(eyebrow) + '</div>',
            '<div style="font-size:28px;line-height:1.18;font-weight:800;color:#071c33;margin-bottom:7px">' + htmlEscape_(title) + '</div>',
            '<div style="font-size:13px;line-height:1.5;color:#708293;margin-bottom:24px">' + htmlEscape_(subtitle) + '</div>',
            content,
          '</td></tr>',
          '<tr><td align="center" style="padding:18px 18px 0;font-size:11px;line-height:1.55;color:#8292a0">',
            footer + '<br><span style="color:#a0acb7">Designated Drinks · Ontario, Canada</span>',
          '</td></tr>',
        '</table>',
      '</td></tr>',
    '</table>',
    '</body></html>'
  ].join("");
}

function buildEmailMetaRow_(label, value, valueIsHtml) {
  const rendered = valueIsHtml ? String(value || "") : htmlEscape_(value);
  return [
    '<tr>',
      '<td width="128" valign="top" style="padding:4px 10px 4px 0;font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#7d8e9d">' + htmlEscape_(label) + '</td>',
      '<td valign="top" style="padding:4px 0;font-size:13px;line-height:1.45;color:#223b52">' + rendered + '</td>',
    '</tr>'
  ].join("");
}

function htmlEscape_(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlMultiline_(value) {
  return htmlEscape_(value).replace(/\r?\n/g, "<br>");
}

function formatEmailDate_(value) {
  try {
    return Utilities.formatDate(new Date(value), Session.getScriptTimeZone(), "MMM d, yyyy · h:mm a");
  } catch (error) {
    return String(value || "");
  }
}

function testEmailTemplates() {
  const catalog = getProductCatalog_(SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID));
  if (!catalog.publicProducts.length) throw new Error("No products available for email template test.");
  const product = catalog.publicProducts[0];
  const items = [{
    sku: product.sku,
    displayTitle: product.brand + " – " + product.name,
    brand: product.brand,
    name: product.name,
    caseFormat: product.caseFormat,
    imageUrl: product.imageUrl,
    cases: 2,
    unitPrice: product.casePrice,
    lineTotal: roundMoney_(product.casePrice * 2)
  }];
  const customer = {
    contact: "Taylor",
    company: "Example Retailer",
    email: "buyer@example.ca",
    phone: "519-555-0100",
    fulfilment: "Delivery",
    deliveryAddress: "123 Main Street\nLondon, ON N6P 1A1",
    poNumber: "PO-1001",
    notes: "Please call before delivery."
  };
  const totals = calculateTotals_(items, { code: "ON", province: "Ontario", label: "HST", rate: 0.13 });
  const settings = { shipping_message: "Availability and freight are confirmed before invoicing.", support_email: CONFIG.SUPPORT_EMAIL };
  const internal = buildSalesEmailHtml_(new Date(), "DDW-PREVIEW", customer, items, totals);
  const external = buildCustomerEmailHtml_("DDW-PREVIEW", customer, items, totals, settings);
  if (internal.indexOf("<img") === -1 || external.indexOf("<img") === -1) throw new Error("Email product images are missing.");
  if (internal.indexOf(product.name) === -1 || external.indexOf(product.name) === -1) throw new Error("Email product text is missing.");
  if (internal.indexOf("<script") !== -1 || external.indexOf("<script") !== -1) throw new Error("Unsafe email HTML detected.");
  Logger.log("Professional wholesale email templates passed. Product image: " + Boolean(product.imageUrl));
}

function sendWholesaleEmailPreview() {
  const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const catalog = getProductCatalog_(spreadsheet);
  const products = catalog.publicProducts.slice(0, Math.min(3, catalog.publicProducts.length));
  if (!products.length) throw new Error("No products available for email preview.");
  const items = products.map(function (product, index) {
    return {
      sku: product.sku,
      displayTitle: product.brand + " – " + product.name,
      brand: product.brand,
      name: product.name,
      caseFormat: product.caseFormat,
      imageUrl: product.imageUrl,
      cases: index === 0 ? 2 : 1,
      unitPrice: product.casePrice,
      lineTotal: roundMoney_(product.casePrice * (index === 0 ? 2 : 1))
    };
  });
  const customer = {
    contact: "Mike",
    company: "Designated Drinks Preview",
    email: CONFIG.SALES_EMAIL,
    phone: "519-555-0100",
    fulfilment: "Delivery",
    deliveryAddress: "123 Main Street\nLondon, ON N6P 1A1",
    poNumber: "PREVIEW-001",
    notes: "Email design preview — no order was placed."
  };
  const totals = calculateTotals_(items, { code: "ON", province: "Ontario", label: "HST", rate: 0.13 });
  const settings = { shipping_message: "Availability and freight are confirmed before invoicing.", support_email: CONFIG.SUPPORT_EMAIL };
  MailApp.sendEmail({
    to: CONFIG.SALES_EMAIL,
    subject: "Preview · Customer wholesale order email",
    body: buildCustomerEmailText_("DDW-PREVIEW", customer, items, totals, settings),
    htmlBody: buildCustomerEmailHtml_("DDW-PREVIEW", customer, items, totals, settings),
    name: "Designated Drinks"
  });
  MailApp.sendEmail({
    to: CONFIG.SALES_EMAIL,
    subject: "Preview · Internal wholesale order email",
    body: buildSalesEmailText_(new Date(), "DDW-PREVIEW", customer, items, totals),
    htmlBody: buildSalesEmailHtml_(new Date(), "DDW-PREVIEW", customer, items, totals),
    name: "Designated Drinks Wholesale"
  });
  Logger.log("Sent customer and internal email previews to " + CONFIG.SALES_EMAIL);
}

function logEvent_(sheet, submissionId, orderId, action, result, error) {
  sheet.appendRow([
    new Date(), safeSheetCell_(submissionId), safeSheetCell_(orderId),
    safeSheetCell_(action), safeSheetCell_(result), safeSheetCell_(error)
  ]);
}

function splitProductTitle_(title) {
  const raw = cleanText_(title, 300);
  const marker = raw.match(/^(.*?)\s*\(Non-Alcoholic\)\s*(.*)$/i);
  return marker
    ? { brand: marker[1].trim(), name: marker[2].trim() || marker[1].trim() }
    : { brand: "Designated Drinks", name: raw };
}

function inferCategory_(title) {
  const value = String(title || "").toLowerCase();
  if (/\bcider\b|cidery|apple sparkle/.test(value)) return "Cider";
  if (/hop\s?water|hopped water|sparkling hop/.test(value)) return "Hop Water";
  if (/wine|rosé|rose\b|prosecco|chardonnay|cabernet|pinot|riesling|sauvignon/.test(value)) return "Wine";
  if (/cocktail|mocktail|margarita|mojito|negroni|spritz|sangria|gin|tonic|cosmo|paloma|martini|mule\b|collins|mimosa|\brum\b|vodka|tequila|amaro/.test(value)) return "Cocktails";
  return "Beer";
}

function inferStyle_(title, category) {
  const value = String(title || "").toLowerCase();
  const rules = [
    ["IPA", /\bipa\b|india pale ale/], ["Pale Ale", /pale ale/], ["Lager", /lager/],
    ["Pilsner", /pilsner/], ["Stout", /stout/], ["Porter", /porter/],
    ["Sour", /sour|gose/], ["Wheat", /wheat|witbier/], ["Blonde Ale", /blonde/],
    ["Amber Ale", /amber/]
  ];
  for (let i = 0; i < rules.length; i += 1) if (rules[i][1].test(value)) return rules[i][0];
  return category;
}

function outputResponse_(payload, callback) {
  return callback
    ? ContentService.createTextOutput(callback + "(" + safeJson_(payload) + ");").setMimeType(ContentService.MimeType.JAVASCRIPT)
    : ContentService.createTextOutput(safeJson_(payload)).setMimeType(ContentService.MimeType.JSON);
}

function textResponse_(value) {
  return ContentService.createTextOutput(String(value)).setMimeType(ContentService.MimeType.TEXT);
}

function cleanText_(value, maxLength) {
  return String(value == null ? "" : value).replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function cleanQuantity_(value) {
  const quantity = parseInt(value, 10);
  if (!Number.isFinite(quantity) || quantity < 1) return 0;
  return Math.min(quantity, CONFIG.MAX_QUANTITY_PER_ITEM);
}

function cleanCallback_(value) {
  const callback = String(value || "").trim();
  return /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callback) ? callback : "";
}

function isValidEmail_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function safeSheetCell_(value) {
  const text = String(value == null ? "" : value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function safeSubject_(value) {
  return String(value == null ? "" : value).replace(/[\r\n]+/g, " ").trim().slice(0, 100);
}

function safeJson_(payload) {
  return JSON.stringify(payload).replace(/</g, "\\u003c");
}

function roundMoney_(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function formatMoney_(value) {
  return "$" + roundMoney_(value).toFixed(2);
}

function testTaxRules() {
  const expected = { ON: 0.13, NS: 0.14, NB: 0.15, NL: 0.15, PE: 0.15, BC: 0.05, QC: 0.05, AB: 0.05 };
  Object.keys(expected).forEach(function (code) {
    if (!TAX_RULES[code] || TAX_RULES[code].rate !== expected[code]) throw new Error("Tax rule failed for " + code);
  });
  if (provinceFromAddress_("123 Main St\nLondon, ON N6P 1A1") !== "ON") throw new Error("Province parsing failed.");
  Logger.log("Tax rules passed.");
}

function testInventoryGuard() {
  const product = { sku: "TEST", catalogTitle: "Test", brand: "Test", name: "Test", caseFormat: "24 × 355mL Can", casePrice: 60, maxCases: 2 };
  const catalog = { bySku: { TEST: product }, byTitle: { Test: product } };
  const ok = priceItemsFromCatalog_([{ sku: "TEST", catalogTitle: "Test", cases: 2 }], catalog);
  if (ok.length !== 1 || ok[0].cases !== 2) throw new Error("Inventory guard valid-order test failed.");
  let rejected = false;
  try { priceItemsFromCatalog_([{ sku: "TEST", catalogTitle: "Test", cases: 3 }], catalog); }
  catch (error) { rejected = /Only 2 cases/.test(error.message); }
  if (!rejected) throw new Error("Inventory guard failed to reject an oversized order.");
  Logger.log("Inventory guard passed.");
}

function testSetup() {
  const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheets = ensureSystemSheets_(spreadsheet);
  const products = getProductCatalog_(spreadsheet).publicProducts;
  if (!products.length) throw new Error("No active products were found.");
  if (sheets.orders.getLastColumn() < ORDER_HEADERS.length) throw new Error("Orders headers are incomplete.");
  Logger.log("Setup valid. Active products: " + products.length);
}

function testStatusStorage() {
  const id = "TEST-" + Date.now();
  setStatus_(id, { status: "success", orderId: "TEST", total: 113 });
  const result = getStatus_(id);
  if (!result || result.total !== 113) throw new Error("Status storage failed.");
  const key = "wholesale-status:" + id;
  PropertiesService.getScriptProperties().deleteProperty(key);
  CacheService.getScriptCache().remove(key);
  Logger.log("Status storage passed.");
}
