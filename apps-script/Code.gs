/**
 * Designated Drinks Wholesale — canonical Apps Script backend.
 *
 * Deploy as a Web app:
 *   Execute as: Me
 *   Who has access: Anyone
 *
 * Run setupSystem() once before deploying. The existing "Designated Wholesale"
 * spreadsheet remains the single source of truth for products and orders.
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
  HST_RATE: 0.13,
  MAX_ITEMS: 200,
  MAX_QUANTITY_PER_ITEM: 999,
  STATUS_TTL_SECONDS: 21600,
  STATUS_RETENTION_MS: 24 * 60 * 60 * 1000,
  PRODUCT_CACHE_SECONDS: 300,
  VERSION: "6.0"
});

const ORDER_HEADERS = Object.freeze([
  "Order ID",
  "Timestamp",
  "Company",
  "Contact",
  "Email",
  "Phone",
  "Fulfilment",
  "Delivery Address",
  "PO Number",
  "Notes",
  "Total Cases",
  "Subtotal",
  "HST",
  "Estimated Total",
  "Order Status",
  "Notification Status",
  "Notification Warnings",
  "Submission ID"
]);

const ITEM_HEADERS = Object.freeze([
  "Order ID",
  "SKU",
  "Product",
  "Brand",
  "Quantity",
  "Case Format",
  "Case Price",
  "Line Total"
]);

const LOG_HEADERS = Object.freeze([
  "Timestamp",
  "Submission ID",
  "Order ID",
  "Action",
  "Result",
  "Error"
]);

const SETTINGS_HEADERS = Object.freeze(["Key", "Value", "Description"]);


function doGet(e) {
  const parameters = e && e.parameter ? e.parameter : {};
  const action = cleanText_(parameters.action, 40).toLowerCase();
  const callback = cleanCallback_(parameters.callback);
  let payload;

  try {
    if (action === "products") {
      payload = {
        status: "success",
        version: CONFIG.VERSION,
        products: getPublicProducts_()
      };
    } else if (action === "status") {
      const submissionId = cleanText_(parameters.submissionId, 120);
      payload = submissionId
        ? getStatus_(submissionId)
        : { status: "error", message: "Missing submission ID." };
    } else {
      payload = {
        status: "ok",
        version: CONFIG.VERSION,
        message: "Wholesale order endpoint is live."
      };
    }
  } catch (error) {
    console.error("doGet error:", error);
    payload = {
      status: "error",
      message: "The wholesale service could not complete the request."
    };
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

    const completed = getStatus_(submissionId);
    if (completed && completed.status === "success") {
      return textResponse_("duplicate");
    }

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
      const existingPayload = statusPayloadFromOrder_(existing);
      setStatus_(submissionId, existingPayload);
      return textResponse_("duplicate");
    }

    const products = getProductCatalog_(spreadsheet);
    const pricedItems = priceItemsFromCatalog_(requestedItems, products);
    const totals = calculateTotals_(pricedItems, settings.hst_rate);
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

    const orderRow = findOrderBySubmissionId_(sheets.orders, submissionId);
    if (!orderRow) throw new Error("The saved order could not be verified.");
    sheets.orders.getRange(orderRow.row, 15).setValue("RECEIVED");
    SpreadsheetApp.flush();

    const savedPayload = {
      status: "processing",
      stage: "saved",
      orderId: orderId,
      totalCases: totals.totalCases,
      subtotal: totals.subtotal,
      hst: totals.hst,
      total: totals.total,
      warnings: [],
      emailStatus: "sending"
    };
    setStatus_(submissionId, savedPayload);
    logEvent_(sheets.logs, submissionId, orderId, "ORDER_SAVED", "SUCCESS", "");

    lock.releaseLock();
    lock = null;

    const notification = sendNotifications_(
      now,
      orderId,
      customer,
      pricedItems,
      totals,
      settings
    );

    sheets.orders.getRange(orderRow.row, 16, 1, 2).setValues([[
      notification.status,
      notification.warnings.join(", ")
    ]]);
    SpreadsheetApp.flush();

    logEvent_(
      sheets.logs,
      submissionId,
      orderId,
      "NOTIFICATIONS",
      notification.status,
      notification.warnings.join(", ")
    );

    const successPayload = {
      status: "success",
      stage: "complete",
      orderId: orderId,
      totalCases: totals.totalCases,
      subtotal: totals.subtotal,
      hst: totals.hst,
      total: totals.total,
      warnings: notification.warnings,
      emailStatus: notification.status.toLowerCase()
    };
    setStatus_(submissionId, successPayload);
    return textResponse_("success");

  } catch (error) {
    console.error("doPost error:", error);
    const message = error && error.message
      ? String(error.message)
      : "The order could not be processed.";

    try {
      const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
      const logs = spreadsheet.getSheetByName(CONFIG.LOGS_SHEET_NAME);
      if (logs) logEvent_(logs, submissionId, orderId, "ORDER_SUBMISSION", "ERROR", message);
      const orders = spreadsheet.getSheetByName(CONFIG.ORDERS_SHEET_NAME);
      if (orders && submissionId) {
        const existing = findOrderBySubmissionId_(orders, submissionId);
        if (existing && existing.status !== "RECEIVED") {
          orders.getRange(existing.row, 15).setValue("ERROR");
        }
      }
    } catch (loggingError) {
      console.error("Failure logging also failed:", loggingError);
    }

    if (submissionId) {
      setStatus_(submissionId, { status: "error", message: message });
    }
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
  CacheService.getScriptCache().remove("ddw-products-v" + CONFIG.VERSION);
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
  const range = sheet.getRange(1, 1, 1, headers.length);
  const existing = range.getValues()[0];
  const blank = existing.every(function (value) { return !String(value || "").trim(); });
  if (blank) {
    range.setValues([headers]);
  } else {
    headers.forEach(function (header, index) {
      if (!String(existing[index] || "").trim()) sheet.getRange(1, index + 1).setValue(header);
    });
  }
  sheet.setFrozenRows(1);
}


function ensureProductMetadata_(sheet) {
  const headers = ["SKU", "Brand", "Category", "Style", "Case Format", "Sort Order"];
  sheet.getRange(1, 8, 1, headers.length).setValues([headers]);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const source = sheet.getRange(2, 1, lastRow - 1, 13).getValues();
  const metadata = source.map(function (row, index) {
    const sheetRow = index + 2;
    const title = cleanText_(row[0], 300);
    const packSize = cleanText_(row[1], 100);
    const parts = splitProductTitle_(title);
    const category = cleanText_(row[9], 80) || inferCategory_(title);
    return [
      cleanText_(row[7], 80) || "DDW-" + String(sheetRow).padStart(4, "0"),
      cleanText_(row[8], 160) || parts.brand,
      category,
      cleanText_(row[10], 100) || inferStyle_(title, category),
      cleanText_(row[11], 100) || (packSize ? "24 × " + packSize : "Case"),
      Number(row[12]) || sheetRow
    ];
  });
  sheet.getRange(2, 8, metadata.length, metadata[0].length).setValues(metadata);
}


function seedSettings_(sheet) {
  if (sheet.getLastRow() > 1) return;
  sheet.getRange(2, 1, 6, 3).setValues([
    ["internal_notification_email", CONFIG.SALES_EMAIL, "Primary internal wholesale notification recipient"],
    ["backup_notification_email", CONFIG.BACKUP_EMAIL, "Independent backup notification recipient"],
    ["support_email", CONFIG.SUPPORT_EMAIL, "Customer-facing support email"],
    ["ordering_enabled", "true", "Set to false to pause new orders"],
    ["shipping_message", "Availability and delivery charges are confirmed before invoicing.", "Shown in confirmation emails"],
    ["hst_rate", CONFIG.HST_RATE, "Ontario HST rate used for estimated totals"]
  ]);
}


function formatSystemSheets_(sheets) {
  [sheets.orders, sheets.orderItems, sheets.settings, sheets.logs].forEach(function (sheet) {
    const lastColumn = sheet.getLastColumn();
    sheet.getRange(1, 1, 1, lastColumn)
      .setBackground("#071c33")
      .setFontColor("#ffffff")
      .setFontWeight("bold");
    sheet.autoResizeColumns(1, lastColumn);
  });

  sheets.orders.getRange("L:N").setNumberFormat("$0.00");
  sheets.orderItems.getRange("G:H").setNumberFormat("$0.00");
  sheets.settings.setColumnWidth(1, 220);
  sheets.settings.setColumnWidth(2, 260);
  sheets.settings.setColumnWidth(3, 360);
  sheets.logs.setColumnWidth(6, 360);
}


function getSettings_(sheet) {
  const settings = {
    internal_notification_email: CONFIG.SALES_EMAIL,
    backup_notification_email: CONFIG.BACKUP_EMAIL,
    support_email: CONFIG.SUPPORT_EMAIL,
    ordering_enabled: "true",
    shipping_message: "Availability and delivery charges are confirmed before invoicing.",
    hst_rate: CONFIG.HST_RATE
  };

  if (sheet.getLastRow() < 2) return settings;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(function (row) {
    const key = cleanText_(row[0], 100);
    if (key) settings[key] = row[1];
  });
  settings.hst_rate = Number(settings.hst_rate);
  if (!Number.isFinite(settings.hst_rate) || settings.hst_rate < 0) settings.hst_rate = CONFIG.HST_RATE;
  return settings;
}


function parseCustomer_(parameters) {
  const customer = {
    contact: cleanText_(parameters.fullName || parameters.contactName, 120),
    company: cleanText_(parameters.companyName, 160),
    email: cleanText_(parameters.email, 200).toLowerCase(),
    phone: cleanText_(parameters.phone, 40),
    fulfilment: cleanText_(parameters.fulfilment || parameters.deliveryMethod, 30) || "Delivery",
    deliveryAddress: cleanText_(parameters.deliveryAddress, 300),
    poNumber: cleanText_(parameters.poNumber, 80),
    notes: cleanText_(parameters.notes, 500)
  };

  if (!customer.company) throw new Error("Company name is required.");
  if (!customer.contact) throw new Error("Contact name is required.");
  if (!isValidEmail_(customer.email)) throw new Error("A valid email address is required.");
  if (customer.phone.replace(/\D/g, "").length < 7) throw new Error("A valid phone number is required.");
  if (customer.fulfilment !== "Delivery" && customer.fulfilment !== "Pickup") {
    throw new Error("Choose delivery or pickup.");
  }
  if (customer.fulfilment === "Delivery" && !customer.deliveryAddress) {
    throw new Error("A delivery address is required.");
  }
  return customer;
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
    if (field === "cases") itemMap[index].cases = cleanQuantity_(parameters[key]);
    else itemMap[index][field] = cleanText_(parameters[key], field === "sku" ? 80 : 300);
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
  const rows = sheet.getRange(2, 1, lastRow - 1, Math.max(sheet.getLastColumn(), 13)).getValues();
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
    const parts = splitProductTitle_(catalogTitle);
    const category = cleanText_(row[9], 80) || inferCategory_(catalogTitle);
    const product = {
      sku: cleanText_(row[7], 80) || "DDW-" + String(sheetRow).padStart(4, "0"),
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
      sortOrder: Number(row[12]) || sheetRow
    };
    bySku[product.sku] = product;
    byTitle[product.catalogTitle] = product;
    publicProducts.push(product);
  });

  return { bySku: bySku, byTitle: byTitle, publicProducts: publicProducts };
}


function getPublicProducts_() {
  const cache = CacheService.getScriptCache();
  const key = "ddw-products-v" + CONFIG.VERSION;
  const cached = cache.get(key);
  if (cached) return JSON.parse(cached);

  const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const products = getProductCatalog_(spreadsheet).publicProducts.sort(function (a, b) {
    return a.sortOrder - b.sortOrder ||
      a.brand.localeCompare(b.brand) ||
      a.name.localeCompare(b.name);
  });
  cache.put(key, JSON.stringify(products), CONFIG.PRODUCT_CACHE_SECONDS);
  return products;
}


function priceItemsFromCatalog_(requestedItems, catalog) {
  const seen = {};
  return requestedItems.map(function (item) {
    const product = (item.sku && catalog.bySku[item.sku]) ||
      (item.catalogTitle && catalog.byTitle[item.catalogTitle]);
    if (!product) {
      throw new Error("A selected product is unavailable or its price could not be confirmed.");
    }
    if (seen[product.sku]) throw new Error("The order contains a duplicated product.");
    seen[product.sku] = true;
    return {
      sku: product.sku,
      catalogTitle: product.catalogTitle,
      displayTitle: product.brand + " – " + product.name,
      brand: product.brand,
      name: product.name,
      caseFormat: product.caseFormat,
      cases: item.cases,
      unitPrice: product.casePrice,
      lineTotal: roundMoney_(item.cases * product.casePrice)
    };
  });
}


function calculateTotals_(items, hstRate) {
  const subtotal = roundMoney_(items.reduce(function (sum, item) {
    return sum + item.lineTotal;
  }, 0));
  const totalCases = items.reduce(function (sum, item) { return sum + item.cases; }, 0);
  const hst = roundMoney_(subtotal * hstRate);
  return {
    totalCases: totalCases,
    subtotal: subtotal,
    hst: hst,
    total: roundMoney_(subtotal + hst)
  };
}


function writeOrderRow_(sheet, row, orderId, now, customer, totals, orderStatus, notificationStatus, warnings, submissionId) {
  sheet.getRange(row, 1, 1, ORDER_HEADERS.length).setValues([[
    orderId,
    now,
    safeSheetCell_(customer.company),
    safeSheetCell_(customer.contact),
    safeSheetCell_(customer.email),
    safeSheetCell_(customer.phone),
    customer.fulfilment,
    safeSheetCell_(customer.deliveryAddress),
    safeSheetCell_(customer.poNumber),
    safeSheetCell_(customer.notes),
    totals.totalCases,
    totals.subtotal,
    totals.hst,
    totals.total,
    orderStatus,
    notificationStatus,
    warnings,
    submissionId
  ]]);
  sheet.getRange(row, 12, 1, 3).setNumberFormat("$0.00");
}


function writeOrderItems_(sheet, orderId, items) {
  const startRow = Math.max(sheet.getLastRow() + 1, 2);
  const values = items.map(function (item) {
    return [
      orderId,
      item.sku,
      safeSheetCell_(item.displayTitle),
      safeSheetCell_(item.brand),
      item.cases,
      safeSheetCell_(item.caseFormat),
      item.unitPrice,
      item.lineTotal
    ];
  });
  sheet.getRange(startRow, 1, values.length, ITEM_HEADERS.length).setValues(values);
  sheet.getRange(startRow, 7, values.length, 2).setNumberFormat("$0.00");
}


function clearOrderItems_(sheet, orderId) {
  if (sheet.getLastRow() < 2) return;
  const ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  for (let index = ids.length - 1; index >= 0; index -= 1) {
    if (String(ids[index][0]) === orderId) sheet.deleteRow(index + 2);
  }
}


function verifyPersistedOrder_(orders, orderItems, orderId, submissionId, expectedItems) {
  const order = findOrderBySubmissionId_(orders, submissionId);
  if (!order || order.orderId !== orderId) throw new Error("The order row was not saved correctly.");

  let itemCount = 0;
  if (orderItems.getLastRow() >= 2) {
    orderItems.getRange(2, 1, orderItems.getLastRow() - 1, 1).getValues().forEach(function (row) {
      if (String(row[0]) === orderId) itemCount += 1;
    });
  }
  if (itemCount !== expectedItems) throw new Error("Not every order item was saved correctly.");
}


function findOrderBySubmissionId_(sheet, submissionId) {
  if (!submissionId || sheet.getLastRow() < 2) return null;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, ORDER_HEADERS.length).getValues();
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const row = values[index];
    if (String(row[17]) === submissionId) {
      return {
        row: index + 2,
        orderId: String(row[0]),
        timestamp: row[1],
        totalCases: Number(row[10]) || 0,
        subtotal: Number(row[11]) || 0,
        hst: Number(row[12]) || 0,
        total: Number(row[13]) || 0,
        status: String(row[14]),
        notificationStatus: String(row[15]),
        warnings: String(row[16] || "")
      };
    }
  }
  return null;
}


function statusPayloadFromOrder_(order) {
  return {
    status: "success",
    stage: "complete",
    orderId: order.orderId,
    totalCases: order.totalCases,
    subtotal: order.subtotal,
    hst: order.hst,
    total: order.total,
    warnings: order.warnings ? order.warnings.split(", ").filter(Boolean) : [],
    emailStatus: order.notificationStatus.toLowerCase()
  };
}


function createOrderId_(ordersSheet, date) {
  const datePart = Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyyMMdd");
  const prefix = "DDW-" + datePart + "-";
  let highest = 0;
  if (ordersSheet.getLastRow() >= 2) {
    ordersSheet.getRange(2, 1, ordersSheet.getLastRow() - 1, 1).getValues().forEach(function (row) {
      const value = String(row[0] || "");
      if (value.indexOf(prefix) !== 0) return;
      highest = Math.max(highest, Number(value.slice(prefix.length)) || 0);
    });
  }
  return prefix + String(highest + 1).padStart(3, "0");
}


function sendNotifications_(now, orderId, customer, items, totals, settings) {
  const warnings = [];
  let internalSent = false;
  const salesEmail = {
    to: settings.internal_notification_email,
    replyTo: customer.email,
    subject: "NEW WHOLESALE ORDER — " + orderId + " — " + safeSubject_(customer.company),
    body: buildSalesEmailText_(now, orderId, customer, items, totals),
    htmlBody: buildEmailHtml_("New wholesale order", now, orderId, customer, items, totals, true, settings),
    name: "Designated Drinks Wholesale"
  };

  try {
    MailApp.sendEmail(salesEmail);
    internalSent = true;
  } catch (error) {
    console.error("Primary internal email failed:", error);
    warnings.push("internal-primary-email");
  }

  if (settings.backup_notification_email &&
      settings.backup_notification_email !== settings.internal_notification_email) {
    try {
      MailApp.sendEmail(Object.assign({}, salesEmail, {
        to: settings.backup_notification_email,
        subject: "BACKUP — " + salesEmail.subject
      }));
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
      subject: "Wholesale order received — " + orderId,
      body: buildCustomerEmailText_(orderId, customer, items, totals, settings),
      htmlBody: buildEmailHtml_("Wholesale order received", now, orderId, customer, items, totals, false, settings),
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
  return [
    "NEW WHOLESALE ORDER",
    "",
    "Order: " + orderId,
    "Received: " + now,
    "Company: " + customer.company,
    "Contact: " + customer.contact,
    "Email: " + customer.email,
    "Phone: " + customer.phone,
    "Fulfilment: " + customer.fulfilment,
    customer.deliveryAddress ? "Address: " + customer.deliveryAddress : "",
    customer.poNumber ? "PO: " + customer.poNumber : "",
    customer.notes ? "Notes: " + customer.notes : "",
    "",
    buildSummary_(items),
    "",
    "Total cases: " + totals.totalCases,
    "Subtotal: " + formatMoney_(totals.subtotal),
    "HST: " + formatMoney_(totals.hst),
    "Estimated total: " + formatMoney_(totals.total)
  ].filter(Boolean).join("\n");
}


function buildCustomerEmailText_(orderId, customer, items, totals, settings) {
  return [
    "DESIGNATED DRINKS",
    "Wholesale order received",
    "",
    "Hi " + customer.contact + ",",
    "",
    "We safely recorded the wholesale order for " + customer.company + ".",
    "Order: " + orderId,
    "",
    buildSummary_(items),
    "",
    "Total cases: " + totals.totalCases,
    "Subtotal: " + formatMoney_(totals.subtotal),
    "HST: " + formatMoney_(totals.hst),
    "Estimated total: " + formatMoney_(totals.total),
    "",
    settings.shipping_message,
    "This confirmation records your order request and is not a final invoice.",
    "",
    "Questions? Reply to this email or contact " + settings.support_email + "."
  ].join("\n");
}


function buildSummary_(items) {
  return items.map(function (item) {
    return item.displayTitle + " | " + item.cases + " case" + (item.cases === 1 ? "" : "s") +
      " | " + formatMoney_(item.unitPrice) + " | " + formatMoney_(item.lineTotal);
  }).join("\n");
}


function buildEmailHtml_(heading, now, orderId, customer, items, totals, internal, settings) {
  const rows = items.map(function (item) {
    return "<tr>" +
      "<td style='padding:12px 8px;border-bottom:1px solid #e4e9ee'>" + escapeHtml_(item.displayTitle) + "</td>" +
      "<td align='center' style='padding:12px 8px;border-bottom:1px solid #e4e9ee'>" + item.cases + "</td>" +
      "<td align='right' style='padding:12px 8px;border-bottom:1px solid #e4e9ee;white-space:nowrap'>" + formatMoney_(item.unitPrice) + "</td>" +
      "<td align='right' style='padding:12px 8px;border-bottom:1px solid #e4e9ee;font-weight:700;white-space:nowrap'>" + formatMoney_(item.lineTotal) + "</td>" +
    "</tr>";
  }).join("");

  const customerDetails = internal
    ? "<p style='margin:0 0 22px;color:#44515f;line-height:1.65'>" +
      "<strong>Company:</strong> " + escapeHtml_(customer.company) + "<br>" +
      "<strong>Contact:</strong> " + escapeHtml_(customer.contact) + "<br>" +
      "<strong>Email:</strong> " + escapeHtml_(customer.email) + "<br>" +
      "<strong>Phone:</strong> " + escapeHtml_(customer.phone) + "<br>" +
      "<strong>Fulfilment:</strong> " + escapeHtml_(customer.fulfilment) + "<br>" +
      (customer.deliveryAddress ? "<strong>Address:</strong> " + escapeHtml_(customer.deliveryAddress) + "<br>" : "") +
      (customer.poNumber ? "<strong>PO:</strong> " + escapeHtml_(customer.poNumber) + "<br>" : "") +
      (customer.notes ? "<strong>Notes:</strong> " + escapeHtml_(customer.notes) : "") +
      "</p>"
    : "<p style='margin:0 0 22px;color:#44515f;line-height:1.65'>Hi " +
      escapeHtml_(customer.contact) + ", we safely recorded the wholesale order for <strong>" +
      escapeHtml_(customer.company) + "</strong>.</p>";

  return "<!doctype html><html><body style='margin:0;background:#eef2f6'>" +
    "<table role='presentation' width='100%' cellpadding='0' cellspacing='0'><tr><td align='center' style='padding:26px 12px'>" +
    "<table role='presentation' width='640' cellpadding='0' cellspacing='0' style='width:100%;max-width:640px;background:#fff;border-radius:14px;overflow:hidden'>" +
    "<tr><td style='padding:24px 30px;background:#071c33;color:#fff;font-family:Arial,sans-serif'>" +
    "<div style='font-size:22px;font-weight:700'>DESIGNATED DRINKS</div><div style='font-size:13px;color:#c6d3df'>Wholesale</div></td></tr>" +
    "<tr><td style='padding:32px 30px;font-family:Arial,sans-serif;color:#10243a'>" +
    "<div style='font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#1684d9'>Order " + escapeHtml_(orderId) + "</div>" +
    "<h1 style='margin:8px 0 16px;font-size:28px;color:#071c33'>" + escapeHtml_(heading) + "</h1>" +
    customerDetails +
    "<table role='presentation' width='100%' cellpadding='0' cellspacing='0' style='border-collapse:collapse;font-size:14px'>" +
    "<tr><th align='left' style='padding:9px 8px;border-bottom:2px solid #071c33'>Product</th><th style='padding:9px 8px;border-bottom:2px solid #071c33'>Cases</th><th align='right' style='padding:9px 8px;border-bottom:2px solid #071c33'>Per case</th><th align='right' style='padding:9px 8px;border-bottom:2px solid #071c33'>Total</th></tr>" +
    rows + "</table>" +
    "<table role='presentation' width='100%' style='margin-top:16px;border-collapse:collapse'>" +
    totalEmailRow_("Total cases", String(totals.totalCases), false) +
    totalEmailRow_("Subtotal", formatMoney_(totals.subtotal), false) +
    totalEmailRow_("HST", formatMoney_(totals.hst), false) +
    totalEmailRow_("Estimated total", formatMoney_(totals.total), true) +
    "</table>" +
    "<div style='margin-top:24px;padding:16px;background:#f1f5f8;border-radius:10px;color:#44515f;font-size:14px;line-height:1.6'>" +
    escapeHtml_(internal
      ? "Confirm availability, payment and delivery details before invoicing."
      : settings.shipping_message + " This confirmation is not a final invoice.") +
    "</div>" +
    "</td></tr>" +
    "<tr><td style='padding:18px 30px;background:#f8fafc;border-top:1px solid #e4e9ee;text-align:center;font-family:Arial,sans-serif;font-size:12px;color:#6b7785'>" +
    "Designated Drinks · <a href='mailto:" + escapeHtml_(settings.support_email) + "' style='color:#071c33'>" + escapeHtml_(settings.support_email) + "</a>" +
    "</td></tr></table></td></tr></table></body></html>";
}


function totalEmailRow_(label, value, strong) {
  return "<tr><td align='right' style='padding:6px 10px;font-family:Arial,sans-serif;" +
    (strong ? "font-size:17px;font-weight:700;border-top:2px solid #071c33;" : "color:#647488;") +
    "'>" + escapeHtml_(label) + "</td><td align='right' style='width:130px;padding:6px 8px;font-family:Arial,sans-serif;font-weight:700;" +
    (strong ? "font-size:17px;border-top:2px solid #071c33;" : "") + "'>" + escapeHtml_(value) + "</td></tr>";
}


function logEvent_(sheet, submissionId, orderId, action, result, error) {
  sheet.appendRow([
    new Date(),
    safeSheetCell_(submissionId),
    safeSheetCell_(orderId),
    safeSheetCell_(action),
    safeSheetCell_(result),
    safeSheetCell_(error)
  ]);
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
  const cached = CacheService.getScriptCache().get(key);
  const stored = cached || PropertiesService.getScriptProperties().getProperty(key);
  if (stored) {
    try { return JSON.parse(stored); } catch (error) { console.error(error); }
  }

  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const orders = spreadsheet.getSheetByName(CONFIG.ORDERS_SHEET_NAME);
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
  const values = properties.getProperties();
  const cutoff = Date.now() - CONFIG.STATUS_RETENTION_MS;
  const remove = [];
  Object.keys(values).forEach(function (key) {
    if (key.indexOf("wholesale-status:") !== 0) return;
    try {
      const payload = JSON.parse(values[key]);
      if (!payload.updatedAt || Number(payload.updatedAt) < cutoff) remove.push(key);
    } catch (error) {
      remove.push(key);
    }
  });
  if (remove.length) properties.deleteProperties(remove);
}


function splitProductTitle_(catalogTitle) {
  const raw = cleanText_(catalogTitle, 300);
  const marker = raw.match(/^(.*?)\s*\(Non-Alcoholic\)\s*(.*)$/i);
  if (marker) return { brand: marker[1].trim(), name: marker[2].trim() || marker[1].trim() };
  return { brand: "Designated Drinks", name: raw };
}


function inferCategory_(title) {
  const value = String(title || "").toLowerCase();
  if (/\bcider\b|cidery|apple sparkle/.test(value)) return "Cider";
  if (/hop\s?water|hopped water|sparkling hop/.test(value)) return "Hop Water";
  if (/wine|rosé|rose\b|prosecco|chardonnay|cabernet|pinot|riesling|sauvignon/.test(value)) return "Wine";
  if (/cocktail|mocktail|margarita|mojito|negroni|spritz|sangria|gin|tonic|cosmo|caesar|paloma|martini|mule\b|collins|mimosa|\brum\b|vodka|tequila|bee's knees|amaro|mixer/.test(value)) return "Cocktails";
  if (/brewery|brewing|beer|lager|ale\b|ipa\b|pilsner|stout|porter|sour|gose|\bwit\b|witbier|kolsch|kölsch|radler|shandy|wheat|irish red/.test(value)) return "Beer";
  return "Other";
}


function inferStyle_(title, category) {
  const value = String(title || "").toLowerCase();
  const rules = [
    ["IPA", /\bipa\b|india pale ale/],
    ["Pale Ale", /pale ale/],
    ["Lager", /lager/],
    ["Pilsner", /pilsner/],
    ["Stout", /stout/],
    ["Porter", /porter/],
    ["Sour", /sour|gose/],
    ["Wheat", /wheat|witbier/],
    ["Blonde Ale", /blonde/],
    ["Amber Ale", /amber/]
  ];
  for (let index = 0; index < rules.length; index += 1) {
    if (rules[index][1].test(value)) return rules[index][0];
  }
  return category;
}


function outputResponse_(payload, callback) {
  if (callback) {
    return ContentService
      .createTextOutput(callback + "(" + safeJson_(payload) + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(safeJson_(payload)).setMimeType(ContentService.MimeType.JSON);
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


function escapeHtml_(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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


function testSetup() {
  const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheets = ensureSystemSheets_(spreadsheet);
  const products = getProductCatalog_(spreadsheet).publicProducts;
  if (!products.length) throw new Error("No active products were found.");
  if (sheets.orders.getLastColumn() < ORDER_HEADERS.length) throw new Error("Orders headers are incomplete.");
  if (sheets.orderItems.getLastColumn() < ITEM_HEADERS.length) throw new Error("Order Items headers are incomplete.");
  Logger.log("Setup valid. Active products: " + products.length + ". Email quota: " + MailApp.getRemainingDailyQuota());
}


function testStatusStorage() {
  const id = "TEST-" + Date.now();
  setStatus_(id, { status: "success", orderId: "TEST-ORDER", total: 113 });
  const result = getStatus_(id);
  if (!result || result.status !== "success" || result.total !== 113) {
    throw new Error("Status storage test failed.");
  }
  const key = "wholesale-status:" + id;
  PropertiesService.getScriptProperties().deleteProperty(key);
  CacheService.getScriptCache().remove(key);
  Logger.log("Status storage test passed.");
}
