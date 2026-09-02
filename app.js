(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DesignatedWholesale = api;
  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", api.init);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CONFIG = Object.freeze({
    sheetId: "17bcjrwi7Ah8_SXaPc9VrCIi2fdYnnNofmUoGy4LKBQ8",
    sheetGid: "0",
    endpoint: "https://script.google.com/macros/s/AKfycbwhZRZht3Sw35KJqXpwwXR-uFvC15kyyNK0TUsE-y-FARXhlPSdl1UehiEdsHKvGHP57Q/exec",
    taxRate: 0.13,
    maxQuantity: 999,
    cartKey: "ddw-wholesale-cart-v2",
    draftKey: "ddw-wholesale-checkout-draft-v2",
    requestTimeoutMs: 18000,
    orderTimeoutMs: 60000
  });

  const CATEGORY_ORDER = ["Beer", "Cider", "Cocktails", "Hop Water", "Wine", "Other"];
  const state = {
    products: [],
    productMap: new Map(),
    cart: new Map(),
    search: "",
    category: "All",
    submissionId: "",
    submitting: false,
    jsonpCounter: 0
  };

  const elements = {};

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;

    for (let i = 0; i < String(text || "").length; i += 1) {
      const character = text[i];
      const next = text[i + 1];

      if (quoted) {
        if (character === '"' && next === '"') {
          field += '"';
          i += 1;
        } else if (character === '"') {
          quoted = false;
        } else {
          field += character;
        }
      } else if (character === '"') {
        quoted = true;
      } else if (character === ",") {
        row.push(field);
        field = "";
      } else if (character === "\n") {
        row.push(field.replace(/\r$/, ""));
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += character;
      }
    }

    if (field.length || row.length) {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
    }

    return rows;
  }

  function roundMoney(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }

  function formatMoney(value) {
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: "CAD"
    }).format(roundMoney(value));
  }

  function inferCategory(title) {
    const value = String(title || "").toLowerCase();
    if (/\bcider\b|cidery|apple sparkle/.test(value)) return "Cider";
    if (/hop\s?water|hopped water|sparkling hop/.test(value)) return "Hop Water";
    if (/wine|rosé|rose\b|prosecco|chardonnay|cabernet|pinot|riesling|sauvignon/.test(value)) return "Wine";
    if (/cocktail|mocktail|margarita|mojito|negroni|spritz|sangria|gin|tonic|cosmo|caesar|paloma|martini|mule\b|collins|mimosa|\brum\b|vodka|tequila|bee's knees|amaro|mixer/.test(value)) return "Cocktails";
    if (/brewery|brewing|beer|lager|ale\b|ipa\b|pilsner|stout|porter|sour|gose|\bwit\b|witbier|kolsch|kölsch|radler|shandy|wheat|irish red/.test(value)) return "Beer";
    return "Other";
  }

  function inferStyle(title, category) {
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
      ["Amber Ale", /amber/],
      ["Cider", /cider/],
      ["Hop Water", /hop water|hopped water/]
    ];
    for (const rule of rules) {
      if (rule[1].test(value)) return rule[0];
    }
    return category;
  }

  function splitProductTitle(catalogTitle) {
    const raw = String(catalogTitle || "").trim();
    const marker = raw.match(/^(.*?)\s*\(Non-Alcoholic\)\s*(.*)$/i);
    if (marker) {
      return {
        brand: marker[1].trim() || "Designated Drinks",
        name: marker[2].trim() || marker[1].trim()
      };
    }

    const dash = raw.match(/^([^–—|-]{2,50})\s+[–—|-]\s+(.+)$/);
    if (dash) return { brand: dash[1].trim(), name: dash[2].trim() };

    return { brand: "Designated Drinks", name: raw };
  }

  function cleanNumber(value) {
    const number = Number(String(value == null ? "" : value).replace(/[$,]/g, "").trim());
    return Number.isFinite(number) ? number : 0;
  }

  function normalizeProductRow(row, sheetRow) {
    const values = Array.isArray(row) ? row : [];
    const catalogTitle = String(values[0] || "").trim();
    const status = String(values[6] || "").trim().toLowerCase();
    const parts = splitProductTitle(catalogTitle);
    const brand = String(values[8] || parts.brand).trim();
    const baseCategory = inferCategory(catalogTitle);
    const category = String(values[9] || baseCategory).trim() || "Other";
    const style = String(values[10] || inferStyle(catalogTitle, category)).trim() || category;
    const packageSize = String(values[1] || "").trim();
    const caseFormat = String(values[11] || (packageSize ? "24 × " + packageSize : "Case")).trim();

    return {
      sku: String(values[7] || ("DDW-" + String(sheetRow).padStart(4, "0"))).trim(),
      catalogTitle: catalogTitle,
      brand: brand,
      name: parts.name,
      category: category,
      style: style,
      packageSize: packageSize,
      caseFormat: caseFormat,
      casePrice: roundMoney(cleanNumber(values[5])),
      imageUrl: String(values[4] || "").trim(),
      active: status === "yes" || status === "active" || status === "true",
      sortOrder: cleanNumber(values[12]) || sheetRow
    };
  }

  function productsFromCsv(text) {
    return parseCsv(text)
      .slice(1)
      .map(function (row, index) { return normalizeProductRow(row, index + 2); })
      .filter(function (product) {
        return product.active && product.catalogTitle && product.casePrice > 0;
      })
      .sort(compareProducts);
  }

  function normalizeApiProduct(product, index) {
    const source = product || {};
    const title = source.catalogTitle || source.title || source.product || source.name || "";
    const parts = splitProductTitle(title);
    const category = source.category || inferCategory(title);
    return {
      sku: String(source.sku || ("DDW-API-" + String(index + 1).padStart(4, "0"))),
      catalogTitle: String(title),
      brand: String(source.brand || parts.brand),
      name: String(source.name || parts.name),
      category: String(category),
      style: String(source.style || inferStyle(title, category)),
      packageSize: String(source.packageSize || source.packSize || ""),
      caseFormat: String(source.caseFormat || (source.packageSize ? "24 × " + source.packageSize : "Case")),
      casePrice: roundMoney(cleanNumber(source.casePrice || source.price)),
      imageUrl: String(source.imageUrl || source.image || ""),
      active: source.active !== false,
      sortOrder: cleanNumber(source.sortOrder) || index + 1
    };
  }

  function compareProducts(a, b) {
    return (a.sortOrder - b.sortOrder) ||
      a.brand.localeCompare(b.brand) ||
      a.name.localeCompare(b.name);
  }

  function calculateCart(cart, productMap, taxRate) {
    let cases = 0;
    let subtotal = 0;
    const items = [];

    cart.forEach(function (quantity, sku) {
      const product = productMap.get(sku);
      if (!product || quantity <= 0) return;
      const lineTotal = roundMoney(product.casePrice * quantity);
      items.push({ product: product, quantity: quantity, lineTotal: lineTotal });
      cases += quantity;
      subtotal += lineTotal;
    });

    subtotal = roundMoney(subtotal);
    const tax = roundMoney(subtotal * taxRate);
    return {
      items: items,
      cases: cases,
      subtotal: subtotal,
      tax: tax,
      total: roundMoney(subtotal + tax)
    };
  }

  function filterProducts(products, search, category) {
    const needle = String(search || "").trim().toLowerCase();
    return products.filter(function (product) {
      const categoryMatches = !category || category === "All" || product.category === category;
      if (!categoryMatches) return false;
      if (!needle) return true;
      const haystack = [
        product.brand,
        product.name,
        product.catalogTitle,
        product.category,
        product.style,
        product.caseFormat
      ].join(" ").toLowerCase();
      return haystack.includes(needle);
    });
  }

  function validateCheckout(data) {
    const errors = {};
    if (!String(data.companyName || "").trim()) errors.companyName = "Enter the company name.";
    if (!String(data.fullName || "").trim()) errors.fullName = "Enter the contact name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.email || "").trim())) {
      errors.email = "Enter a valid email address.";
    }
    const phoneDigits = String(data.phone || "").replace(/\D/g, "");
    if (phoneDigits.length < 7) errors.phone = "Enter a valid phone number.";
    if (data.fulfilment === "Delivery" && !String(data.deliveryAddress || "").trim()) {
      errors.deliveryAddress = "Enter the delivery address.";
    }
    return errors;
  }

  function createSubmissionId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return "ddw-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function domId(value) {
    return String(value || "").replace(/[^A-Za-z0-9_-]/g, "-");
  }

  function pluralCases(count) {
    return count + " case" + (count === 1 ? "" : "s");
  }

  function cacheElements() {
    [
      "catalogue", "catalogue-status", "product-grid", "empty-state", "clear-filters",
      "search-input", "category-filters", "summary-empty", "summary-content",
      "summary-items", "summary-cases", "summary-subtotal", "summary-count-badge",
      "review-order", "mobile-order-bar", "mobile-cases", "mobile-subtotal",
      "checkout-dialog", "close-checkout", "review-items", "review-case-count",
      "review-subtotal", "review-tax", "review-total", "checkout-form", "address-field",
      "delivery-address", "form-alert", "place-order", "success-dialog",
      "success-order-id", "success-cases", "success-total", "success-email",
      "place-another-order"
    ].forEach(function (id) {
      elements[id] = document.getElementById(id);
    });
  }

  function jsonp(url, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      const callback = "ddwJsonp" + Date.now() + String(++state.jsonpCounter);
      const script = document.createElement("script");
      const query = new URLSearchParams(Object.assign({}, params, { callback: callback }));
      const timer = window.setTimeout(function () {
        cleanup();
        reject(new Error("The request timed out."));
      }, timeoutMs || CONFIG.requestTimeoutMs);

      function cleanup() {
        window.clearTimeout(timer);
        delete window[callback];
        script.remove();
      }

      window[callback] = function (payload) {
        cleanup();
        resolve(payload);
      };

      script.onerror = function () {
        cleanup();
        reject(new Error("The request could not be completed."));
      };
      script.src = url + (url.includes("?") ? "&" : "?") + query.toString();
      document.head.appendChild(script);
    });
  }

  async function loadProducts() {
    let apiError = null;
    try {
      const payload = await jsonp(CONFIG.endpoint, { action: "products" }, 12000);
      if (payload && Array.isArray(payload.products) && payload.products.length) {
        return payload.products
          .map(normalizeApiProduct)
          .filter(function (product) { return product.active && product.casePrice > 0; })
          .sort(compareProducts);
      }
      throw new Error("The endpoint did not return a catalogue.");
    } catch (error) {
      apiError = error;
    }

    try {
      const csvUrl = "https://docs.google.com/spreadsheets/d/" +
        encodeURIComponent(CONFIG.sheetId) +
        "/export?format=csv&gid=" +
        encodeURIComponent(CONFIG.sheetGid);
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = controller ? window.setTimeout(function () { controller.abort(); }, CONFIG.requestTimeoutMs) : null;
      const response = await fetch(csvUrl, {
        cache: "no-store",
        signal: controller ? controller.signal : undefined
      });
      if (timer) window.clearTimeout(timer);
      if (!response.ok) throw new Error("Catalogue response: " + response.status);
      const products = productsFromCsv(await response.text());
      if (!products.length) throw new Error("The catalogue has no active products.");
      return products;
    } catch (csvError) {
      console.error("Catalogue endpoint failed:", apiError);
      console.error("Catalogue CSV fallback failed:", csvError);
      throw new Error("We couldn't load the wholesale catalogue.");
    }
  }

  function loadStoredCart() {
    try {
      const stored = JSON.parse(localStorage.getItem(CONFIG.cartKey) || "{}");
      Object.keys(stored).forEach(function (sku) {
        const quantity = clampQuantity(stored[sku]);
        if (quantity > 0) state.cart.set(sku, quantity);
      });
    } catch (error) {
      localStorage.removeItem(CONFIG.cartKey);
    }
  }

  function reconcileCart() {
    Array.from(state.cart.keys()).forEach(function (sku) {
      if (!state.productMap.has(sku)) state.cart.delete(sku);
    });
    persistCart();
  }

  function persistCart() {
    const value = {};
    state.cart.forEach(function (quantity, sku) { value[sku] = quantity; });
    localStorage.setItem(CONFIG.cartKey, JSON.stringify(value));
  }

  function clampQuantity(value) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return 0;
    return Math.min(parsed, CONFIG.maxQuantity);
  }

  function renderFilters() {
    const categories = Array.from(new Set(state.products.map(function (product) {
      return product.category;
    }))).sort(function (a, b) {
      const aIndex = CATEGORY_ORDER.indexOf(a);
      const bIndex = CATEGORY_ORDER.indexOf(b);
      return (aIndex === -1 ? 99 : aIndex) - (bIndex === -1 ? 99 : bIndex) || a.localeCompare(b);
    });

    elements["category-filters"].replaceChildren();
    ["All"].concat(categories).forEach(function (category) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "filter-chip";
      button.dataset.category = category;
      button.setAttribute("aria-pressed", String(state.category === category));
      button.textContent = category;
      elements["category-filters"].appendChild(button);
    });
  }

  function createQuantityControl(product, quantity) {
    const control = document.createElement("div");
    control.className = "quantity-control";
    control.dataset.sku = product.sku;

    const decrease = document.createElement("button");
    decrease.type = "button";
    decrease.dataset.action = "decrease";
    decrease.setAttribute("aria-label", "Decrease cases of " + product.brand + " " + product.name);
    decrease.textContent = "−";
    decrease.disabled = quantity <= 0;

    const input = document.createElement("input");
    input.id = "qty-" + domId(product.sku);
    input.type = "number";
    input.inputMode = "numeric";
    input.min = "0";
    input.max = String(CONFIG.maxQuantity);
    input.value = String(quantity);
    input.dataset.quantity = product.sku;
    input.setAttribute("aria-label", "Cases of " + product.brand + " " + product.name);

    const increase = document.createElement("button");
    increase.type = "button";
    increase.dataset.action = "increase";
    increase.setAttribute("aria-label", "Increase cases of " + product.brand + " " + product.name);
    increase.textContent = "+";

    control.append(decrease, input, increase);
    return control;
  }

  function createProductCard(product) {
    const quantity = state.cart.get(product.sku) || 0;
    const card = document.createElement("article");
    card.className = "product-card" + (quantity ? " is-selected" : "");
    card.dataset.productSku = product.sku;

    const imageWrap = document.createElement("div");
    imageWrap.className = "product-image-wrap";
    const category = document.createElement("span");
    category.className = "category-pill";
    category.textContent = product.category;
    const image = document.createElement("img");
    image.className = "product-image";
    image.src = product.imageUrl;
    image.alt = product.brand + " " + product.name;
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", function () {
      image.classList.add("is-missing");
      image.alt = "";
    }, { once: true });
    imageWrap.append(category, image);

    const body = document.createElement("div");
    body.className = "product-body";
    const brand = document.createElement("p");
    brand.className = "product-brand";
    brand.textContent = product.brand;
    const name = document.createElement("h2");
    name.className = "product-name";
    name.textContent = product.name;
    const meta = document.createElement("p");
    meta.className = "product-meta";
    meta.textContent = product.style + " · " + product.caseFormat;

    const priceRow = document.createElement("div");
    priceRow.className = "product-price-row";
    const price = document.createElement("div");
    price.className = "product-price";
    const amount = document.createElement("strong");
    amount.textContent = formatMoney(product.casePrice);
    const unit = document.createElement("span");
    unit.textContent = "per case";
    price.append(amount, unit);
    priceRow.append(price, createQuantityControl(product, quantity));
    body.append(brand, name, meta, priceRow);
    card.append(imageWrap, body);
    return card;
  }

  function renderProducts() {
    const visible = filterProducts(state.products, state.search, state.category);
    const fragment = document.createDocumentFragment();
    visible.forEach(function (product) { fragment.appendChild(createProductCard(product)); });
    elements["product-grid"].replaceChildren(fragment);
    elements["product-grid"].hidden = visible.length === 0;
    elements["empty-state"].hidden = visible.length !== 0;
  }

  function updateVisibleQuantity(sku) {
    const quantity = state.cart.get(sku) || 0;
    const input = document.getElementById("qty-" + domId(sku));
    if (input) {
      input.value = String(quantity);
      const control = input.closest(".quantity-control");
      const decrease = control && control.querySelector('[data-action="decrease"]');
      if (decrease) decrease.disabled = quantity <= 0;
      const card = input.closest(".product-card");
      if (card) card.classList.toggle("is-selected", quantity > 0);
    }
  }

  function setQuantity(sku, value) {
    if (!state.productMap.has(sku)) return;
    const quantity = clampQuantity(value);
    if (quantity) state.cart.set(sku, quantity);
    else state.cart.delete(sku);
    persistCart();
    updateVisibleQuantity(sku);
    renderOrderSummary();
    if (elements["checkout-dialog"].open) renderReview();
  }

  function renderOrderSummary() {
    const totals = calculateCart(state.cart, state.productMap, CONFIG.taxRate);
    const hasItems = totals.items.length > 0;
    elements["summary-empty"].hidden = hasItems;
    elements["summary-content"].hidden = !hasItems;
    elements["review-order"].disabled = !hasItems;
    elements["summary-count-badge"].textContent = String(totals.cases);
    elements["summary-cases"].textContent = String(totals.cases);
    elements["summary-subtotal"].textContent = formatMoney(totals.subtotal);
    elements["mobile-cases"].textContent = pluralCases(totals.cases);
    elements["mobile-subtotal"].textContent = formatMoney(totals.subtotal);
    elements["mobile-order-bar"].hidden = !hasItems;

    const fragment = document.createDocumentFragment();
    totals.items.forEach(function (item) {
      const row = document.createElement("div");
      row.className = "summary-item";
      const detail = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = item.product.name;
      const meta = document.createElement("span");
      meta.textContent = pluralCases(item.quantity);
      detail.append(name, meta);
      const total = document.createElement("strong");
      total.textContent = formatMoney(item.lineTotal);
      row.append(detail, total);
      fragment.appendChild(row);
    });
    elements["summary-items"].replaceChildren(fragment);
  }

  function renderReview() {
    const totals = calculateCart(state.cart, state.productMap, CONFIG.taxRate);
    if (!totals.items.length) {
      if (elements["checkout-dialog"].open) elements["checkout-dialog"].close();
      return;
    }

    elements["review-case-count"].textContent = pluralCases(totals.cases);
    elements["review-subtotal"].textContent = formatMoney(totals.subtotal);
    elements["review-tax"].textContent = formatMoney(totals.tax);
    elements["review-total"].textContent = formatMoney(totals.total);
    const fragment = document.createDocumentFragment();

    totals.items.forEach(function (item) {
      const row = document.createElement("article");
      row.className = "review-item";
      const image = document.createElement("img");
      image.src = item.product.imageUrl;
      image.alt = "";
      image.loading = "lazy";
      const info = document.createElement("div");
      info.className = "review-item-info";
      const name = document.createElement("strong");
      name.textContent = item.product.brand + " · " + item.product.name;
      const format = document.createElement("span");
      format.textContent = item.product.caseFormat;
      const quantity = document.createElement("div");
      quantity.className = "review-quantity";
      quantity.dataset.reviewSku = item.product.sku;
      const decrease = document.createElement("button");
      decrease.type = "button";
      decrease.dataset.action = "decrease";
      decrease.setAttribute("aria-label", "Decrease cases of " + item.product.name);
      decrease.textContent = "−";
      const output = document.createElement("output");
      output.textContent = String(item.quantity);
      const increase = document.createElement("button");
      increase.type = "button";
      increase.dataset.action = "increase";
      increase.setAttribute("aria-label", "Increase cases of " + item.product.name);
      increase.textContent = "+";
      quantity.append(decrease, output, increase);
      info.append(name, format, quantity);
      const line = document.createElement("div");
      line.className = "review-item-total";
      const lineTotal = document.createElement("strong");
      lineTotal.textContent = formatMoney(item.lineTotal);
      const perCase = document.createElement("span");
      perCase.textContent = formatMoney(item.product.casePrice) + " / case";
      line.append(lineTotal, perCase);
      row.append(image, info, line);
      fragment.appendChild(row);
    });
    elements["review-items"].replaceChildren(fragment);
  }

  function openCheckout() {
    if (!calculateCart(state.cart, state.productMap, CONFIG.taxRate).items.length) return;
    renderReview();
    restoreDraft();
    elements["checkout-dialog"].showModal();
    document.body.classList.add("dialog-open");
  }

  function closeCheckout() {
    if (state.submitting) return;
    elements["checkout-dialog"].close();
    document.body.classList.remove("dialog-open");
  }

  function toggleAddressField() {
    const fulfilment = elements["checkout-form"].elements.fulfilment.value;
    const delivery = fulfilment === "Delivery";
    elements["address-field"].hidden = !delivery;
    elements["delivery-address"].required = delivery;
    if (!delivery) clearFieldError(elements["delivery-address"]);
  }

  function getFormData() {
    const formData = new FormData(elements["checkout-form"]);
    return {
      companyName: String(formData.get("companyName") || "").trim(),
      fullName: String(formData.get("fullName") || "").trim(),
      email: String(formData.get("email") || "").trim(),
      phone: String(formData.get("phone") || "").trim(),
      fulfilment: String(formData.get("fulfilment") || "Delivery"),
      deliveryAddress: String(formData.get("deliveryAddress") || "").trim(),
      poNumber: String(formData.get("poNumber") || "").trim(),
      notes: String(formData.get("notes") || "").trim(),
      website: String(formData.get("website") || "").trim()
    };
  }

  function persistDraft() {
    const data = getFormData();
    delete data.website;
    localStorage.setItem(CONFIG.draftKey, JSON.stringify(data));
  }

  function restoreDraft() {
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(CONFIG.draftKey) || "null"); } catch (error) { draft = null; }
    if (!draft) return;
    ["companyName", "fullName", "email", "phone", "deliveryAddress", "poNumber", "notes"].forEach(function (name) {
      if (elements["checkout-form"].elements[name] && !elements["checkout-form"].elements[name].value) {
        elements["checkout-form"].elements[name].value = draft[name] || "";
      }
    });
    if (draft.fulfilment && elements["checkout-form"].elements.fulfilment) {
      const radio = elements["checkout-form"].querySelector('[name="fulfilment"][value="' + draft.fulfilment + '"]');
      if (radio) radio.checked = true;
    }
    toggleAddressField();
  }

  function clearFieldError(input) {
    const field = input && input.closest(".field");
    if (!field) return;
    field.classList.remove("has-error");
    input.removeAttribute("aria-invalid");
    const error = field.querySelector(".field-error");
    if (error) error.textContent = "";
  }

  function showValidationErrors(errors) {
    let first = null;
    Object.keys(errors).forEach(function (name) {
      const input = elements["checkout-form"].elements[name];
      if (!input) return;
      const field = input.closest(".field");
      if (!field) return;
      field.classList.add("has-error");
      input.setAttribute("aria-invalid", "true");
      const error = field.querySelector(".field-error");
      if (error) error.textContent = errors[name];
      if (!first) first = input;
    });
    if (first) first.focus();
  }

  function setFormAlert(message) {
    elements["form-alert"].textContent = message || "";
    elements["form-alert"].hidden = !message;
  }

  function setSubmitting(value, label) {
    state.submitting = value;
    elements["place-order"].disabled = value;
    elements["close-checkout"].disabled = value;
    elements["place-order"].classList.toggle("is-loading", value);
    elements["place-order"].querySelector("span").textContent = label || (value ? "Placing order…" : "Place wholesale order");
  }

  function postOrder(data, totals) {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = CONFIG.endpoint;
    form.target = "order-submit-frame";
    form.hidden = true;

    function add(name, value) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = String(value == null ? "" : value);
      form.appendChild(input);
    }

    add("submissionId", state.submissionId);
    Object.keys(data).forEach(function (key) { add(key, data[key]); });
    add("deliveryMethod", data.fulfilment);
    add("items", JSON.stringify(totals.items.map(function (item) {
      return { sku: item.product.sku, catalogTitle: item.product.catalogTitle, cases: item.quantity };
    })));

    totals.items.forEach(function (item, index) {
      add("item_" + index + "_sku", item.product.sku);
      add("item_" + index + "_catalogTitle", item.product.catalogTitle);
      add("item_" + index + "_cases", item.quantity);
    });

    document.body.appendChild(form);
    form.submit();
    window.setTimeout(function () { form.remove(); }, 1000);
  }

  function wait(milliseconds) {
    return new Promise(function (resolve) { window.setTimeout(resolve, milliseconds); });
  }

  async function pollOrderStatus() {
    const startedAt = Date.now();
    let lastError = null;
    while (Date.now() - startedAt < CONFIG.orderTimeoutMs) {
      try {
        const status = await jsonp(CONFIG.endpoint, {
          action: "status",
          submissionId: state.submissionId
        }, 12000);
        if (status && status.status === "success") return status;
        if (status && status.status === "error") {
          throw new Error(status.message || "The order could not be processed.");
        }
        lastError = null;
      } catch (error) {
        lastError = error;
        if (error && /could not be processed|missing|required|unavailable|valid/i.test(error.message || "")) {
          throw error;
        }
      }
      await wait(1400);
    }
    throw lastError || new Error("We couldn't confirm the order yet. Your cart is safe; try again with the same button.");
  }

  async function submitCheckout(event) {
    event.preventDefault();
    if (state.submitting) return;
    setFormAlert("");
    elements["checkout-form"].querySelectorAll(".field.has-error").forEach(function (field) {
      const input = field.querySelector("input, textarea");
      if (input) clearFieldError(input);
    });

    const data = getFormData();
    const errors = validateCheckout(data);
    if (Object.keys(errors).length) {
      showValidationErrors(errors);
      setFormAlert("Please fix the highlighted fields.");
      return;
    }

    const totals = calculateCart(state.cart, state.productMap, CONFIG.taxRate);
    if (!totals.items.length) {
      setFormAlert("Add at least one case before placing the order.");
      return;
    }

    persistDraft();
    if (!state.submissionId) state.submissionId = createSubmissionId();
    setSubmitting(true, "Placing order…");

    try {
      postOrder(data, totals);
      const status = await pollOrderStatus();
      completeOrder(status, data, totals);
    } catch (error) {
      console.error("Order submission failed:", error);
      setFormAlert(error && error.message
        ? error.message
        : "We couldn't confirm the order. Your cart is still saved; please try again.");
      setSubmitting(false, "Try again safely");
    }
  }

  function completeOrder(status, data, totals) {
    const orderId = status.orderId || "Confirmed";
    elements["success-order-id"].textContent = orderId;
    elements["success-cases"].textContent = pluralCases(totals.cases);
    elements["success-total"].textContent = formatMoney(status.total || totals.total) + " estimated total";
    elements["success-email"].textContent = data.email;

    state.cart.clear();
    persistCart();
    localStorage.removeItem(CONFIG.draftKey);
    elements["checkout-form"].reset();
    state.submissionId = "";
    state.submitting = false;
    renderProducts();
    renderOrderSummary();
    elements["checkout-dialog"].close();
    elements["success-dialog"].showModal();
    document.body.classList.add("dialog-open");
    setSubmitting(false, "Place wholesale order");
  }

  function bindEvents() {
    elements["search-input"].addEventListener("input", function (event) {
      state.search = event.target.value;
      renderProducts();
    });

    elements["category-filters"].addEventListener("click", function (event) {
      const button = event.target.closest("[data-category]");
      if (!button) return;
      state.category = button.dataset.category;
      renderFilters();
      renderProducts();
    });

    elements["clear-filters"].addEventListener("click", function () {
      state.search = "";
      state.category = "All";
      elements["search-input"].value = "";
      renderFilters();
      renderProducts();
      elements["search-input"].focus();
    });

    elements["product-grid"].addEventListener("click", function (event) {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      const control = button.closest(".quantity-control");
      if (!control) return;
      const sku = control.dataset.sku;
      const current = state.cart.get(sku) || 0;
      setQuantity(sku, button.dataset.action === "increase" ? current + 1 : current - 1);
    });

    elements["product-grid"].addEventListener("change", function (event) {
      if (!event.target.matches("[data-quantity]")) return;
      setQuantity(event.target.dataset.quantity, event.target.value);
    });

    elements["review-order"].addEventListener("click", openCheckout);
    elements["mobile-order-bar"].addEventListener("click", openCheckout);
    elements["close-checkout"].addEventListener("click", closeCheckout);
    elements["checkout-dialog"].addEventListener("cancel", function (event) {
      if (state.submitting) event.preventDefault();
      else document.body.classList.remove("dialog-open");
    });

    elements["review-items"].addEventListener("click", function (event) {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      const control = button.closest("[data-review-sku]");
      const sku = control && control.dataset.reviewSku;
      if (!sku) return;
      const current = state.cart.get(sku) || 0;
      setQuantity(sku, button.dataset.action === "increase" ? current + 1 : current - 1);
    });

    elements["checkout-form"].addEventListener("change", function (event) {
      if (event.target.name === "fulfilment") toggleAddressField();
      if (event.target.matches("input, textarea")) clearFieldError(event.target);
      persistDraft();
    });
    elements["checkout-form"].addEventListener("input", function (event) {
      if (event.target.matches("input, textarea")) clearFieldError(event.target);
    });
    elements["checkout-form"].addEventListener("submit", submitCheckout);

    elements["place-another-order"].addEventListener("click", function () {
      elements["success-dialog"].close();
      document.body.classList.remove("dialog-open");
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  async function init() {
    cacheElements();
    loadStoredCart();
    bindEvents();
    toggleAddressField();

    try {
      state.products = await loadProducts();
      state.productMap = new Map(state.products.map(function (product) {
        return [product.sku, product];
      }));
      reconcileCart();
      renderFilters();
      renderProducts();
      renderOrderSummary();
      elements["catalogue-status"].hidden = true;
      elements["catalogue"].setAttribute("aria-busy", "false");
    } catch (error) {
      elements["catalogue-status"].replaceChildren();
      const message = document.createElement("p");
      message.textContent = "We couldn't load the wholesale catalogue.";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "text-button";
      retry.textContent = "Try again";
      retry.addEventListener("click", function () { window.location.reload(); });
      elements["catalogue-status"].append(message, retry);
      elements["catalogue"].setAttribute("aria-busy", "false");
    }
  }

  return {
    init: init,
    parseCsv: parseCsv,
    roundMoney: roundMoney,
    inferCategory: inferCategory,
    inferStyle: inferStyle,
    splitProductTitle: splitProductTitle,
    normalizeProductRow: normalizeProductRow,
    productsFromCsv: productsFromCsv,
    calculateCart: calculateCart,
    filterProducts: filterProducts,
    validateCheckout: validateCheckout,
    clampQuantity: clampQuantity
  };
});
