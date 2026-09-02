(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DesignatedWholesale = api;
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", api.init, { once: true });
    else api.init();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CONFIG = Object.freeze({
    sheetId: "17bcjrwi7Ah8_SXaPc9VrCIi2fdYnnNofmUoGy4LKBQ8",
    sheetGid: "0",
    endpoint: "https://script.google.com/macros/s/AKfycbwkRvqX5Sv0wO941mfCdizoDTyh43c82-8fN5mwkRFyzMJjMR6jmiMxIdt5H0Lv6N52ag/exec",
    maxQuantity: 999,
    cartKey: "ddw-wholesale-cart-v3",
    draftKey: "ddw-wholesale-checkout-draft-v3",
    catalogueCacheKey: "ddw-wholesale-catalogue-v3",
    catalogueCacheMs: 5 * 60 * 1000,
    requestTimeoutMs: 10000,
    statusRequestTimeoutMs: 2500,
    orderConfirmTimeoutMs: 22000,
    statusPollMs: 450
  });

  const TAX_RULES = Object.freeze({
    AB: { name: "Alberta", label: "GST", rate: 0.05 },
    BC: { name: "British Columbia", label: "GST", rate: 0.05 },
    MB: { name: "Manitoba", label: "GST", rate: 0.05 },
    NB: { name: "New Brunswick", label: "HST", rate: 0.15 },
    NL: { name: "Newfoundland and Labrador", label: "HST", rate: 0.15 },
    NS: { name: "Nova Scotia", label: "HST", rate: 0.14 },
    NT: { name: "Northwest Territories", label: "GST", rate: 0.05 },
    NU: { name: "Nunavut", label: "GST", rate: 0.05 },
    ON: { name: "Ontario", label: "HST", rate: 0.13 },
    PE: { name: "Prince Edward Island", label: "HST", rate: 0.15 },
    QC: { name: "Quebec", label: "GST", rate: 0.05 },
    SK: { name: "Saskatchewan", label: "GST", rate: 0.05 },
    YT: { name: "Yukon", label: "GST", rate: 0.05 }
  });

  const CATEGORY_ORDER = ["Beer", "Cider", "Cocktails", "Hop Water", "Wine", "Other"];
  const SORT_LABELS = Object.freeze({
    "brewery-az": "Brewery A–Z",
    "product-az": "Product A–Z",
    "price-low": "Price low to high",
    "price-high": "Price high to low"
  });

  const state = {
    products: [],
    productMap: new Map(),
    cardMap: new Map(),
    cart: new Map(),
    search: "",
    category: "All",
    brewery: "All",
    sort: "brewery-az",
    submissionId: "",
    submitting: false,
    jsonpCounter: 0,
    initialized: false,
    searchFrame: 0
  };

  const elements = {};

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    const source = String(text || "");

    for (let i = 0; i < source.length; i += 1) {
      const character = source[i];
      const next = source[i + 1];

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

  function cleanNumber(value) {
    const number = Number(String(value == null ? "" : value).replace(/[$,]/g, "").trim());
    return Number.isFinite(number) ? number : 0;
  }

  function inferCategory(title) {
    const value = String(title || "").toLowerCase();
    if (/\bcider\b|cidery|apple sparkle|pear sparkle/.test(value)) return "Cider";
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
      ["Wheat", /wheat|witbier|\bwit\b/],
      ["Blonde Ale", /blonde/],
      ["Amber Ale", /amber/],
      ["Radler", /radler/],
      ["Cider", /cider/],
      ["Hop Water", /hop water|hopped water/]
    ];
    for (let i = 0; i < rules.length; i += 1) {
      if (rules[i][1].test(value)) return rules[i][0];
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

  function normalizeMaxCases(value) {
    const cases = Math.floor(cleanNumber(value));
    return cases > 0 ? Math.min(cases, CONFIG.maxQuantity) : CONFIG.maxQuantity;
  }

  function normalizeProductRow(row, sheetRow) {
    const values = Array.isArray(row) ? row : [];
    const catalogTitle = String(values[0] || "").trim();
    const status = String(values[6] || "").trim().toLowerCase();
    const parts = splitProductTitle(catalogTitle);
    const brand = String(values[8] || parts.brand).trim();
    const category = String(values[9] || inferCategory(catalogTitle)).trim() || "Other";
    const style = String(values[10] || inferStyle(catalogTitle, category)).trim() || category;
    const packageSize = String(values[1] || "").trim();
    const caseFormat = String(values[11] || (packageSize ? "24 × " + packageSize : "Case")).trim();

    return {
      sku: String(values[7] || ("DDW-" + String(sheetRow).padStart(4, "0"))).trim(),
      productId: String(values[18] || "").trim(),
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
      sortOrder: cleanNumber(values[12]) || sheetRow,
      maxCases: normalizeMaxCases(values[15])
    };
  }

  function productsFromCsv(text) {
    return parseCsv(text)
      .slice(1)
      .map(function (row, index) { return normalizeProductRow(row, index + 2); })
      .filter(function (product) {
        return product.active && product.catalogTitle && product.casePrice > 0 && product.maxCases > 0;
      });
  }

  function normalizeApiProduct(product, index) {
    const source = product || {};
    const title = source.catalogTitle || source.title || source.product || source.name || "";
    const parts = splitProductTitle(title);
    const category = source.category || inferCategory(title);
    return {
      sku: String(source.sku || ("DDW-API-" + String(index + 1).padStart(4, "0"))),
      productId: String(source.productId || source.shopifyProductId || ""),
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
      sortOrder: cleanNumber(source.sortOrder) || index + 1,
      maxCases: normalizeMaxCases(source.maxCases || source.casesAvailable || source.wholesaleCasesAvailable)
    };
  }

  function filterProducts(products, search, category, brewery) {
    const needle = String(search || "").trim().toLowerCase();
    const selectedCategory = category || "All";
    const selectedBrewery = brewery || "All";
    return (products || []).filter(function (product) {
      if (selectedCategory !== "All" && product.category !== selectedCategory) return false;
      if (selectedBrewery !== "All" && product.brand !== selectedBrewery) return false;
      if (!needle) return true;
      return [
        product.brand,
        product.name,
        product.catalogTitle,
        product.category,
        product.style,
        product.caseFormat
      ].join(" ").toLowerCase().includes(needle);
    });
  }

  function sortProducts(products, sort) {
    const list = (products || []).slice();
    const mode = sort || "brewery-az";
    list.sort(function (a, b) {
      if (mode === "product-az") {
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
          a.brand.localeCompare(b.brand, undefined, { sensitivity: "base" });
      }
      if (mode === "price-low") return a.casePrice - b.casePrice || a.name.localeCompare(b.name);
      if (mode === "price-high") return b.casePrice - a.casePrice || a.name.localeCompare(b.name);
      return a.brand.localeCompare(b.brand, undefined, { sensitivity: "base" }) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    return list;
  }

  function clampQuantity(value, maxQuantity) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return 0;
    const max = Number.isFinite(Number(maxQuantity)) && Number(maxQuantity) > 0
      ? Math.min(Math.floor(Number(maxQuantity)), CONFIG.maxQuantity)
      : CONFIG.maxQuantity;
    return Math.min(parsed, max);
  }

  function calculateCart(cart, productMap, taxRate) {
    let cases = 0;
    let subtotal = 0;
    const items = [];
    (cart || new Map()).forEach(function (quantity, sku) {
      const product = productMap.get(sku);
      if (!product || quantity <= 0) return;
      const safeQuantity = clampQuantity(quantity, product.maxCases);
      if (!safeQuantity) return;
      const lineTotal = roundMoney(product.casePrice * safeQuantity);
      items.push({ product: product, quantity: safeQuantity, lineTotal: lineTotal });
      cases += safeQuantity;
      subtotal += lineTotal;
    });
    subtotal = roundMoney(subtotal);
    const rate = Number.isFinite(Number(taxRate)) ? Math.max(0, Number(taxRate)) : 0;
    const tax = roundMoney(subtotal * rate);
    return {
      items: items,
      cases: cases,
      subtotal: subtotal,
      tax: tax,
      total: roundMoney(subtotal + tax)
    };
  }

  function normalizePostal(value) {
    const compact = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    return compact.length > 3 ? compact.slice(0, 3) + " " + compact.slice(3) : compact;
  }

  function isValidPostal(value) {
    return /^[A-Z]\d[A-Z] \d[A-Z]\d$/.test(normalizePostal(value));
  }

  function getTaxRule(province, fulfilment) {
    const code = String(fulfilment || "Delivery") === "Pickup" ? "ON" : String(province || "").toUpperCase();
    return TAX_RULES[code] ? Object.assign({ code: code }, TAX_RULES[code]) : null;
  }

  function validateCheckout(data) {
    const source = data || {};
    const errors = {};
    if (!String(source.companyName || "").trim()) errors.companyName = "Enter the company name.";
    if (!String(source.fullName || "").trim()) errors.fullName = "Enter the contact name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(source.email || "").trim())) errors.email = "Enter a valid email address.";
    if (String(source.phone || "").replace(/\D/g, "").length < 7) errors.phone = "Enter a valid phone number.";

    if (source.fulfilment === "Delivery") {
      if (!String(source.addressLine1 || "").trim()) errors.addressLine1 = "Enter the street address.";
      if (!String(source.city || "").trim()) errors.city = "Enter the city.";
      if (!TAX_RULES[String(source.province || "").toUpperCase()]) errors.province = "Select the province.";
      if (!isValidPostal(source.postalCode)) errors.postalCode = "Enter a Canadian postal code.";
    }
    return errors;
  }

  function shouldBodyBeLocked(checkoutOpen, successOpen) {
    return Boolean(checkoutOpen || successOpen);
  }

  function domId(value) {
    return String(value || "").replace(/[^A-Za-z0-9_-]/g, "-");
  }

  function pluralCases(count) {
    return count + " case" + (count === 1 ? "" : "s");
  }

  function createSubmissionId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return "ddw-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function wait(milliseconds) {
    return new Promise(function (resolve) { window.setTimeout(resolve, milliseconds); });
  }

  function cacheElements() {
    [
      "catalogue", "catalogue-status", "product-grid", "empty-state", "empty-state-title", "empty-state-copy",
      "clear-filters", "search-input", "category-filters", "brewery-filter", "sort-products", "catalogue-clear-all",
      "catalogue-results-count", "catalogue-results-detail", "summary-empty", "summary-content", "summary-items",
      "summary-cases", "summary-subtotal", "summary-count-badge", "review-order", "review-order-label",
      "mobile-order-bar", "mobile-cases", "mobile-subtotal", "checkout-dialog", "close-checkout", "review-items",
      "review-case-count", "review-subtotal", "review-tax-label", "review-tax", "review-total", "tax-destination",
      "checkout-form", "address-field", "delivery-address", "checkout-tax-context", "checkout-tax-rate",
      "form-alert", "place-order", "place-order-label", "success-dialog", "success-order-id", "success-cases",
      "success-total", "success-email", "success-email-message", "place-another-order", "live-status"
    ].forEach(function (id) {
      elements[id] = document.getElementById(id);
    });
  }

  function announce(message) {
    if (!elements["live-status"]) return;
    elements["live-status"].textContent = "";
    window.setTimeout(function () { elements["live-status"].textContent = message || ""; }, 10);
  }

  function syncBodyDialogState() {
    if (!document.body) return;
    const locked = shouldBodyBeLocked(
      Boolean(elements["checkout-dialog"] && elements["checkout-dialog"].open),
      Boolean(elements["success-dialog"] && elements["success-dialog"].open)
    );
    document.body.classList.toggle("dialog-open", locked);
  }

  function jsonp(url, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      const callback = "ddwJsonp" + Date.now() + String(++state.jsonpCounter);
      const script = document.createElement("script");
      const query = new URLSearchParams(Object.assign({}, params, { callback: callback }));
      let finished = false;
      const timer = window.setTimeout(function () {
        cleanup();
        reject(new Error("The request timed out."));
      }, timeoutMs || CONFIG.requestTimeoutMs);

      function cleanup() {
        if (finished) return;
        finished = true;
        window.clearTimeout(timer);
        try { delete window[callback]; } catch (error) { window[callback] = undefined; }
        script.remove();
      }

      window[callback] = function (payload) {
        if (finished) return;
        cleanup();
        resolve(payload);
      };
      script.onerror = function () {
        if (finished) return;
        cleanup();
        reject(new Error("The request could not be completed."));
      };
      script.async = true;
      script.src = url + (url.includes("?") ? "&" : "?") + query.toString();
      document.head.appendChild(script);
    });
  }

  function loadProductsFromCsv() {
    const csvUrl = "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(CONFIG.sheetId) +
      "/export?format=csv&gid=" + encodeURIComponent(CONFIG.sheetGid) + "&_=" + Date.now();
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? window.setTimeout(function () { controller.abort(); }, CONFIG.requestTimeoutMs) : null;
    return fetch(csvUrl, {
      cache: "no-store",
      signal: controller ? controller.signal : undefined,
      credentials: "omit"
    }).then(function (response) {
      if (timer) window.clearTimeout(timer);
      if (!response.ok) throw new Error("Catalogue response: " + response.status);
      return response.text();
    }).then(function (text) {
      const products = productsFromCsv(text);
      if (!products.length) throw new Error("The catalogue has no active products.");
      return products;
    }).catch(function (error) {
      if (timer) window.clearTimeout(timer);
      throw error;
    });
  }

  function loadProductsFromApi() {
    return jsonp(CONFIG.endpoint, { action: "products", _: Date.now() }, CONFIG.requestTimeoutMs)
      .then(function (payload) {
        if (!payload || !Array.isArray(payload.products) || !payload.products.length) {
          throw new Error("The endpoint did not return a catalogue.");
        }
        const products = payload.products
          .map(normalizeApiProduct)
          .filter(function (product) { return product.active && product.casePrice > 0 && product.maxCases > 0; });
        if (!products.length) throw new Error("The catalogue has no active products.");
        return products;
      });
  }

  function loadProducts() {
    return loadProductsFromCsv().catch(function (csvError) {
      console.warn("Catalogue CSV load failed; falling back to API.", csvError);
      return loadProductsFromApi();
    });
  }

  function catalogueSignature(products) {
    return (products || []).map(function (product) {
      return [product.sku, product.casePrice, product.maxCases, product.catalogTitle, product.imageUrl].join("|");
    }).sort().join("\n");
  }

  function loadCatalogueCache() {
    try {
      const payload = JSON.parse(sessionStorage.getItem(CONFIG.catalogueCacheKey) || "null");
      if (!payload || !Array.isArray(payload.products) || !payload.products.length) return null;
      if (Date.now() - Number(payload.savedAt || 0) > CONFIG.catalogueCacheMs) return null;
      return payload.products;
    } catch (error) {
      return null;
    }
  }

  function saveCatalogueCache(products) {
    try {
      sessionStorage.setItem(CONFIG.catalogueCacheKey, JSON.stringify({ savedAt: Date.now(), products: products }));
    } catch (error) {}
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

  function persistCart() {
    const value = {};
    state.cart.forEach(function (quantity, sku) { value[sku] = quantity; });
    try { localStorage.setItem(CONFIG.cartKey, JSON.stringify(value)); } catch (error) {}
  }

  function reconcileCart() {
    Array.from(state.cart.keys()).forEach(function (sku) {
      const product = state.productMap.get(sku);
      if (!product) {
        state.cart.delete(sku);
        return;
      }
      const quantity = clampQuantity(state.cart.get(sku), product.maxCases);
      if (quantity) state.cart.set(sku, quantity);
      else state.cart.delete(sku);
    });
    persistCart();
  }

  function renderFilterOptions() {
    const categories = Array.from(new Set(state.products.map(function (product) { return product.category; })))
      .sort(function (a, b) {
        const ai = CATEGORY_ORDER.indexOf(a);
        const bi = CATEGORY_ORDER.indexOf(b);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.localeCompare(b);
      });
    if (state.category !== "All" && !categories.includes(state.category)) state.category = "All";

    const categoryFragment = document.createDocumentFragment();
    ["All"].concat(categories).forEach(function (category) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "filter-chip";
      button.dataset.category = category;
      button.setAttribute("aria-pressed", String(state.category === category));
      button.textContent = category;
      categoryFragment.appendChild(button);
    });
    elements["category-filters"].replaceChildren(categoryFragment);

    const breweries = Array.from(new Set(state.products.map(function (product) { return product.brand; }).filter(Boolean)))
      .sort(function (a, b) { return a.localeCompare(b, undefined, { sensitivity: "base" }); });
    if (state.brewery !== "All" && !breweries.includes(state.brewery)) state.brewery = "All";
    const breweryFragment = document.createDocumentFragment();
    const all = document.createElement("option");
    all.value = "All";
    all.textContent = "All breweries";
    breweryFragment.appendChild(all);
    breweries.forEach(function (brewery) {
      const option = document.createElement("option");
      option.value = brewery;
      option.textContent = brewery;
      breweryFragment.appendChild(option);
    });
    elements["brewery-filter"].replaceChildren(breweryFragment);
    elements["brewery-filter"].value = state.brewery;
    elements["sort-products"].value = state.sort;
  }

  function createTag(text, extraClass) {
    const tag = document.createElement("span");
    tag.className = "product-tag" + (extraClass ? " " + extraClass : "");
    tag.textContent = text;
    return tag;
  }

  function createQuantityControl(product, quantity, context) {
    const control = document.createElement("div");
    control.className = context === "review" ? "review-quantity" : "quantity-control";
    control.dataset.sku = product.sku;
    control.dataset.context = context || "catalogue";

    const decrease = document.createElement("button");
    decrease.type = "button";
    decrease.dataset.action = "decrease";
    decrease.setAttribute("aria-label", "Decrease cases of " + product.brand + " " + product.name);
    decrease.textContent = "−";
    decrease.disabled = quantity <= 0;

    let valueNode;
    if (context === "review") {
      valueNode = document.createElement("output");
      valueNode.dataset.quantityOutput = product.sku;
      valueNode.textContent = String(quantity);
    } else {
      valueNode = document.createElement("input");
      valueNode.id = "qty-" + domId(product.sku);
      valueNode.type = "number";
      valueNode.inputMode = "numeric";
      valueNode.min = "0";
      valueNode.max = String(product.maxCases || CONFIG.maxQuantity);
      valueNode.value = String(quantity);
      valueNode.dataset.quantity = product.sku;
      valueNode.setAttribute("aria-label", "Cases of " + product.brand + " " + product.name);
    }

    const increase = document.createElement("button");
    increase.type = "button";
    increase.dataset.action = "increase";
    increase.setAttribute("aria-label", "Increase cases of " + product.brand + " " + product.name);
    increase.textContent = "+";
    increase.disabled = quantity >= product.maxCases;

    control.append(decrease, valueNode, increase);
    return control;
  }

  function createProductCard(product) {
    const quantity = state.cart.get(product.sku) || 0;
    const card = document.createElement("article");
    card.className = "product-card" + (quantity ? " is-selected" : "");
    card.dataset.productSku = product.sku;

    const imageWrap = document.createElement("div");
    imageWrap.className = "product-image-wrap";
    if (product.imageUrl) {
      const image = document.createElement("img");
      image.className = "product-image";
      image.src = product.imageUrl;
      image.alt = product.brand + " " + product.name;
      image.loading = "lazy";
      image.decoding = "async";
      try { image.fetchPriority = "low"; } catch (error) {}
      image.addEventListener("error", function () {
        image.hidden = true;
        imageWrap.classList.add("is-missing");
      }, { once: true });
      imageWrap.appendChild(image);
    } else {
      imageWrap.classList.add("is-missing");
    }

    const body = document.createElement("div");
    body.className = "product-body";
    const tags = document.createElement("div");
    tags.className = "product-tags";
    tags.appendChild(createTag(product.category));
    if (product.style && product.style.toLowerCase() !== product.category.toLowerCase()) tags.appendChild(createTag(product.style, "is-style"));

    const brand = document.createElement("p");
    brand.className = "product-brand";
    brand.textContent = product.brand;
    const name = document.createElement("h2");
    name.className = "product-name";
    name.textContent = product.name;
    name.title = product.name;
    const meta = document.createElement("p");
    meta.className = "product-meta";
    meta.textContent = product.caseFormat;

    const priceRow = document.createElement("div");
    priceRow.className = "product-price-row";
    const price = document.createElement("div");
    price.className = "product-price";
    const amount = document.createElement("strong");
    amount.textContent = formatMoney(product.casePrice);
    const unit = document.createElement("span");
    unit.textContent = "per case";
    price.append(amount, unit);
    priceRow.append(price, createQuantityControl(product, quantity, "catalogue"));

    body.append(tags, brand, name, meta, priceRow);
    card.append(imageWrap, body);
    return card;
  }

  function buildProductCards() {
    state.cardMap.clear();
    const fragment = document.createDocumentFragment();
    state.products.forEach(function (product) {
      const card = createProductCard(product);
      state.cardMap.set(product.sku, card);
      fragment.appendChild(card);
    });
    elements["product-grid"].replaceChildren(fragment);
  }

  function applyCatalogueFilters() {
    const visible = sortProducts(filterProducts(state.products, state.search, state.category, state.brewery), state.sort);
    const visibleSkus = new Set(visible.map(function (product) { return product.sku; }));
    const ordered = sortProducts(state.products, state.sort);

    ordered.forEach(function (product) {
      const card = state.cardMap.get(product.sku);
      if (!card) return;
      card.hidden = !visibleSkus.has(product.sku);
      elements["product-grid"].appendChild(card);
    });

    const hasProducts = visible.length > 0;
    elements["product-grid"].hidden = !hasProducts;
    elements["empty-state"].hidden = hasProducts;
    if (!hasProducts) {
      const filtered = Boolean(state.search || state.category !== "All" || state.brewery !== "All");
      if (elements["empty-state-title"]) elements["empty-state-title"].textContent = filtered ? "No products match" : "No products available";
      if (elements["empty-state-copy"]) elements["empty-state-copy"].textContent = filtered
        ? "Clear a filter or try a different search."
        : "There are no wholesale cases available right now.";
    }

    if (elements["catalogue-results-count"]) {
      elements["catalogue-results-count"].textContent = visible.length === state.products.length
        ? "Showing " + visible.length + " products"
        : "Showing " + visible.length + " of " + state.products.length + " products";
    }
    if (elements["catalogue-results-detail"]) {
      elements["catalogue-results-detail"].textContent =
        (state.brewery === "All" ? "All breweries" : state.brewery) + " · " + (SORT_LABELS[state.sort] || SORT_LABELS["brewery-az"]);
    }
  }

  function updateCardQuantity(sku) {
    const product = state.productMap.get(sku);
    const card = state.cardMap.get(sku);
    if (!product || !card) return;
    const quantity = state.cart.get(sku) || 0;
    card.classList.toggle("is-selected", quantity > 0);
    const input = card.querySelector("[data-quantity]");
    if (input) input.value = String(quantity);
    const decrease = card.querySelector('[data-action="decrease"]');
    const increase = card.querySelector('[data-action="increase"]');
    if (decrease) decrease.disabled = quantity <= 0;
    if (increase) increase.disabled = quantity >= product.maxCases;
  }

  function updateAllCardQuantities() {
    state.products.forEach(function (product) { updateCardQuantity(product.sku); });
  }

  function setQuantity(sku, value) {
    const product = state.productMap.get(sku);
    if (!product) return;
    const requested = parseInt(value, 10);
    const quantity = clampQuantity(value, product.maxCases);
    if (quantity) state.cart.set(sku, quantity);
    else state.cart.delete(sku);
    persistCart();
    updateCardQuantity(sku);
    renderOrderSummary();

    if (Number.isFinite(requested) && requested > product.maxCases) {
      announce("Only " + pluralCases(product.maxCases) + " are currently available for " + product.name + ".");
    }

    if (elements["checkout-dialog"] && elements["checkout-dialog"].open) renderReview();
  }

  function createSummaryItem(item) {
    const row = document.createElement("div");
    row.className = "summary-item";
    row.dataset.summarySku = item.product.sku;

    const info = document.createElement("div");
    info.className = "summary-item-info";
    const name = document.createElement("strong");
    name.textContent = item.product.name;
    name.title = item.product.name;
    const meta = document.createElement("span");
    meta.textContent = pluralCases(item.quantity);
    info.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "summary-item-actions";
    const controls = document.createElement("div");
    controls.className = "summary-quantity";
    const minus = document.createElement("button");
    minus.type = "button";
    minus.dataset.action = "decrease";
    minus.setAttribute("aria-label", "Decrease " + item.product.name);
    minus.textContent = "−";
    const count = document.createElement("span");
    count.textContent = String(item.quantity);
    const plus = document.createElement("button");
    plus.type = "button";
    plus.dataset.action = "increase";
    plus.setAttribute("aria-label", "Increase " + item.product.name);
    plus.textContent = "+";
    plus.disabled = item.quantity >= item.product.maxCases;
    controls.append(minus, count, plus);
    const total = document.createElement("strong");
    total.textContent = formatMoney(item.lineTotal);
    actions.append(controls, total);
    row.append(info, actions);
    return row;
  }

  function renderOrderSummary() {
    const totals = calculateCart(state.cart, state.productMap, 0);
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
    if (elements["review-order-label"]) {
      elements["review-order-label"].textContent = hasItems ? "Review order · " + pluralCases(totals.cases) : "Review order";
    }

    const fragment = document.createDocumentFragment();
    totals.items.forEach(function (item) { fragment.appendChild(createSummaryItem(item)); });
    elements["summary-items"].replaceChildren(fragment);
  }

  function buildDeliveryAddress(data) {
    if (data.fulfilment !== "Delivery") return "";
    const lines = [String(data.addressLine1 || "").trim()];
    if (String(data.addressLine2 || "").trim()) lines.push(String(data.addressLine2).trim());
    const cityLine = String(data.city || "").trim() +
      (data.city && data.province ? ", " : "") + String(data.province || "").trim() +
      (data.postalCode ? " " + normalizePostal(data.postalCode) : "");
    if (cityLine.trim()) lines.push(cityLine.trim());
    return lines.filter(Boolean).join("\n");
  }

  function getFormData() {
    const formData = new FormData(elements["checkout-form"]);
    const fulfilment = String(formData.get("fulfilment") || "Delivery");
    const data = {
      companyName: String(formData.get("companyName") || "").trim(),
      fullName: String(formData.get("fullName") || "").trim(),
      email: String(formData.get("email") || "").trim(),
      phone: String(formData.get("phone") || "").trim(),
      fulfilment: fulfilment,
      addressLine1: String(formData.get("addressLine1") || "").trim(),
      addressLine2: String(formData.get("addressLine2") || "").trim(),
      city: String(formData.get("city") || "").trim(),
      province: fulfilment === "Pickup" ? "ON" : String(formData.get("province") || "").trim().toUpperCase(),
      postalCode: normalizePostal(String(formData.get("postalCode") || "")),
      poNumber: String(formData.get("poNumber") || "").trim(),
      notes: String(formData.get("notes") || "").trim(),
      website: String(formData.get("website") || "").trim()
    };
    data.deliveryAddress = buildDeliveryAddress(data);
    return data;
  }

  function persistDraft(dataOverride) {
    const data = dataOverride || getFormData();
    const draft = Object.assign({}, data);
    delete draft.website;
    delete draft.deliveryAddress;
    try { localStorage.setItem(CONFIG.draftKey, JSON.stringify(draft)); } catch (error) {}
  }

  function restoreDraft() {
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(CONFIG.draftKey) || "null"); } catch (error) { draft = null; }
    if (!draft) return;
    ["companyName", "fullName", "email", "phone", "addressLine1", "addressLine2", "city", "province", "postalCode", "poNumber", "notes"].forEach(function (name) {
      const field = elements["checkout-form"].elements[name];
      if (field && !field.value && draft[name]) field.value = draft[name];
    });
    if (draft.fulfilment) {
      const radio = elements["checkout-form"].querySelector('[name="fulfilment"][value="' + draft.fulfilment + '"]');
      if (radio) radio.checked = true;
    }
  }

  function saveRepeatCustomerProfile(data) {
    const profile = Object.assign({}, data, { poNumber: "", notes: "" });
    delete profile.website;
    delete profile.deliveryAddress;
    try { localStorage.setItem(CONFIG.draftKey, JSON.stringify(profile)); } catch (error) {}
  }

  function clearFieldError(input) {
    const field = input && input.closest(".field");
    if (!field) return;
    field.classList.remove("has-error");
    input.removeAttribute("aria-invalid");
    if (typeof input.setCustomValidity === "function") input.setCustomValidity("");
    const error = field.querySelector(".field-error");
    if (error) error.textContent = "";
  }

  function clearAllFieldErrors() {
    elements["checkout-form"].querySelectorAll(".field.has-error").forEach(function (field) {
      const input = field.querySelector("input, textarea, select");
      if (input) clearFieldError(input);
    });
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
      if (typeof input.setCustomValidity === "function") input.setCustomValidity(errors[name]);
      const error = field.querySelector(".field-error");
      if (error) error.textContent = errors[name];
      if (!first) first = input;
    });
    if (first) first.focus({ preventScroll: false });
  }

  function setFormAlert(message, kind) {
    elements["form-alert"].textContent = message || "";
    elements["form-alert"].hidden = !message;
    elements["form-alert"].dataset.kind = kind || "error";
  }

  function currentTaxRule() {
    const data = getFormData();
    return getTaxRule(data.province, data.fulfilment);
  }

  function syncDeliveryField() {
    if (!elements["delivery-address"]) return;
    elements["delivery-address"].value = buildDeliveryAddress(getFormData());
  }

  function toggleFulfilment() {
    const data = getFormData();
    const delivery = data.fulfilment === "Delivery";
    elements["address-field"].hidden = !delivery;
    ["addressLine1", "city", "province", "postalCode"].forEach(function (name) {
      const field = elements["checkout-form"].elements[name];
      if (field) field.required = delivery;
    });
    if (!delivery) {
      elements["checkout-form"].querySelectorAll("#address-field .field.has-error input, #address-field .field.has-error select").forEach(clearFieldError);
    }
    syncDeliveryField();
    if (elements["checkout-dialog"].open) renderReview();
  }

  function updateTaxUi(rule, totals) {
    if (elements["checkout-tax-context"]) {
      elements["checkout-tax-context"].textContent = rule
        ? rule.label + " based on " + rule.name
        : "Select a province to calculate GST/HST";
    }
    if (elements["checkout-tax-rate"]) elements["checkout-tax-rate"].textContent = rule ? Math.round(rule.rate * 100) + "%" : "—";
    if (elements["review-tax-label"]) elements["review-tax-label"].textContent = rule ? rule.label + " (" + Math.round(rule.rate * 100) + "%)" : "Tax";
    if (elements["tax-destination"]) {
      elements["tax-destination"].textContent = rule
        ? (getFormData().fulfilment === "Pickup" ? "Ontario pickup" : rule.name + " delivery")
        : "Select delivery province";
    }
    elements["review-tax"].textContent = rule ? formatMoney(totals.tax) : "—";
    elements["review-total"].textContent = formatMoney(rule ? totals.total : totals.subtotal);
    if (elements["place-order-label"]) {
      elements["place-order-label"].textContent = rule ? "Place order · " + formatMoney(totals.total) : "Place wholesale order";
    }
  }

  function createReviewItem(item) {
    const row = document.createElement("article");
    row.className = "review-item";
    row.dataset.reviewSku = item.product.sku;
    const image = document.createElement("img");
    image.src = item.product.imageUrl;
    image.alt = "";
    image.loading = "lazy";
    const info = document.createElement("div");
    info.className = "review-item-info";
    const name = document.createElement("strong");
    name.textContent = item.product.brand + " · " + item.product.name;
    name.title = item.product.brand + " · " + item.product.name;
    const format = document.createElement("span");
    format.textContent = item.product.caseFormat;
    info.append(name, format, createQuantityControl(item.product, item.quantity, "review"));
    const line = document.createElement("div");
    line.className = "review-item-total";
    const total = document.createElement("strong");
    total.textContent = formatMoney(item.lineTotal);
    const perCase = document.createElement("span");
    perCase.textContent = formatMoney(item.product.casePrice) + " / case";
    line.append(total, perCase);
    row.append(image, info, line);
    return row;
  }

  function renderReview() {
    const untaxed = calculateCart(state.cart, state.productMap, 0);
    if (!untaxed.items.length) {
      closeCheckout({ force: true, focusCatalogue: true });
      announce("Your order is empty. Add a case to continue.");
      return;
    }
    const rule = currentTaxRule();
    const totals = calculateCart(state.cart, state.productMap, rule ? rule.rate : 0);
    elements["review-case-count"].textContent = pluralCases(totals.cases);
    elements["review-subtotal"].textContent = formatMoney(totals.subtotal);
    updateTaxUi(rule, totals);
    const fragment = document.createDocumentFragment();
    totals.items.forEach(function (item) { fragment.appendChild(createReviewItem(item)); });
    elements["review-items"].replaceChildren(fragment);
  }

  function focusFirstCheckoutField() {
    window.setTimeout(function () {
      if (!elements["checkout-dialog"].open) return;
      const candidate = elements["checkout-form"].querySelector("input[required]:invalid, select[required]:invalid, textarea[required]:invalid");
      if (candidate) candidate.focus();
    }, 40);
  }

  function openCheckout() {
    if (!calculateCart(state.cart, state.productMap, 0).items.length) return;
    restoreDraft();
    toggleFulfilment();
    syncDeliveryField();
    renderReview();
    if (!elements["checkout-dialog"].open) elements["checkout-dialog"].showModal();
    syncBodyDialogState();
    focusFirstCheckoutField();
  }

  function closeCheckout(options) {
    const opts = options || {};
    if (state.submitting && !opts.force) return;
    if (elements["checkout-dialog"] && elements["checkout-dialog"].open) elements["checkout-dialog"].close();
    syncBodyDialogState();
    if (opts.focusCatalogue) {
      const target = elements["search-input"] || elements["catalogue"];
      if (target && typeof target.focus === "function") target.focus({ preventScroll: true });
    }
  }

  function setSubmitting(value, label) {
    state.submitting = value;
    elements["place-order"].disabled = value;
    elements["close-checkout"].disabled = value;
    elements["place-order"].classList.toggle("is-loading", value);
    if (elements["place-order-label"]) elements["place-order-label"].textContent = label || (value ? "Recording order…" : "Place wholesale order");
  }

  function buildOrderBody(data, totals) {
    const body = new URLSearchParams();
    body.set("submissionId", state.submissionId);
    ["companyName", "fullName", "email", "phone", "fulfilment", "deliveryAddress", "province", "poNumber", "notes", "website"].forEach(function (key) {
      body.set(key, String(data[key] == null ? "" : data[key]));
    });
    body.set("deliveryMethod", data.fulfilment);
    body.set("items", JSON.stringify(totals.items.map(function (item) {
      return { sku: item.product.sku, catalogTitle: item.product.catalogTitle, cases: item.quantity };
    })));
    totals.items.forEach(function (item, index) {
      body.set("item_" + index + "_sku", item.product.sku);
      body.set("item_" + index + "_catalogTitle", item.product.catalogTitle);
      body.set("item_" + index + "_cases", String(item.quantity));
    });
    return body;
  }

  function submitOrderFallback(body) {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = CONFIG.endpoint;
    form.target = "order-submit-frame";
    form.hidden = true;
    body.forEach(function (value, key) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = key;
      input.value = value;
      form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
    window.setTimeout(function () { form.remove(); }, 1500);
  }

  function postOrder(body) {
    if (typeof fetch !== "function") {
      submitOrderFallback(body);
      return Promise.resolve();
    }
    return fetch(CONFIG.endpoint, {
      method: "POST",
      mode: "no-cors",
      body: body,
      keepalive: true,
      cache: "no-store",
      credentials: "omit"
    }).catch(function (error) {
      console.warn("Wholesale POST fetch failed; using form fallback.", error);
      submitOrderFallback(body);
    });
  }

  async function pollOrderStatus(getPostError) {
    const startedAt = Date.now();
    let lastError = null;
    await wait(140);
    while (Date.now() - startedAt < CONFIG.orderConfirmTimeoutMs) {
      const postError = typeof getPostError === "function" ? getPostError() : null;
      if (postError) throw postError;
      try {
        const status = await jsonp(CONFIG.endpoint, {
          action: "status",
          submissionId: state.submissionId,
          _: Date.now()
        }, CONFIG.statusRequestTimeoutMs);
        if (status && status.status === "error") throw new Error(status.message || "The order could not be processed.");
        if (status && status.status === "success") return status;
        if (status && status.stage === "saved" && status.orderId) return status;
        lastError = null;
      } catch (error) {
        lastError = error;
        if (error && /could not be processed|missing|required|unavailable|valid|only \d+ case/i.test(error.message || "")) throw error;
      }
      await wait(CONFIG.statusPollMs);
    }
    throw lastError || new Error("We couldn't confirm the order yet. Your cart is still saved; try the button again safely.");
  }

  function resetTransientCheckout() {
    elements["checkout-form"].reset();
    setFormAlert("");
    state.submissionId = "";
    state.submitting = false;
  }

  function completeOrder(status, data, estimatedTotals) {
    const total = Number.isFinite(Number(status && status.total)) ? Number(status.total) : estimatedTotals.total;
    const cases = Number.isFinite(Number(status && status.totalCases)) ? Number(status.totalCases) : estimatedTotals.cases;
    const orderId = status && status.orderId ? status.orderId : "Confirmed";
    elements["success-order-id"].textContent = orderId;
    elements["success-cases"].textContent = pluralCases(cases);
    elements["success-total"].textContent = formatMoney(total) + " estimated total";
    elements["success-email"].textContent = data.email;
    if (elements["success-email-message"]) {
      const confirmed = status && status.status === "success" && status.emailStatus && status.emailStatus !== "sending";
      elements["success-email-message"].firstChild.nodeValue = confirmed ? "Confirmation sent to " : "Confirmation email is being sent to ";
    }

    state.cart.clear();
    persistCart();
    updateAllCardQuantities();
    renderOrderSummary();
    saveRepeatCustomerProfile(data);
    closeCheckout({ force: true });
    resetTransientCheckout();
    if (!elements["success-dialog"].open) elements["success-dialog"].showModal();
    syncBodyDialogState();
    setSubmitting(false, "Place wholesale order");
  }

  async function submitCheckout(event) {
    event.preventDefault();
    if (state.submitting) return;
    setFormAlert("");
    clearAllFieldErrors();
    syncDeliveryField();
    const data = getFormData();
    const errors = validateCheckout(data);
    if (Object.keys(errors).length) {
      showValidationErrors(errors);
      setFormAlert("Complete the highlighted fields to continue.");
      return;
    }

    const rule = getTaxRule(data.province, data.fulfilment);
    if (!rule) {
      setFormAlert("Select a valid delivery province.");
      return;
    }
    const totals = calculateCart(state.cart, state.productMap, rule.rate);
    if (!totals.items.length) {
      setFormAlert("Add at least one case before placing the order.");
      return;
    }

    persistDraft(data);
    if (!state.submissionId) state.submissionId = createSubmissionId();
    setSubmitting(true, "Recording order…");
    let postError = null;
    const body = buildOrderBody(data, totals);
    postOrder(body).catch(function (error) { postError = error; });

    try {
      const status = await pollOrderStatus(function () { return postError; });
      completeOrder(status, data, totals);
    } catch (error) {
      console.error("Order submission failed:", error);
      setFormAlert(error && error.message ? error.message : "We couldn't confirm the order. Your cart is still saved; please try again.");
      setSubmitting(false, "Try again safely");
    }
  }

  function resetFilters() {
    state.search = "";
    state.category = "All";
    state.brewery = "All";
    state.sort = "brewery-az";
    elements["search-input"].value = "";
    elements["brewery-filter"].value = "All";
    elements["sort-products"].value = "brewery-az";
    renderFilterOptions();
    applyCatalogueFilters();
    elements["search-input"].focus();
  }

  function handleQuantityButton(button, context) {
    if (!button) return;
    let sku = "";
    if (context === "summary") {
      const row = button.closest("[data-summary-sku]");
      sku = row && row.dataset.summarySku;
    } else if (context === "review") {
      const row = button.closest("[data-review-sku]");
      sku = row && row.dataset.reviewSku;
    } else {
      const control = button.closest("[data-sku]");
      sku = control && control.dataset.sku;
    }
    if (!sku) return;
    const current = state.cart.get(sku) || 0;
    setQuantity(sku, button.dataset.action === "increase" ? current + 1 : current - 1);
  }

  function bindEvents() {
    elements["search-input"].addEventListener("input", function (event) {
      state.search = event.target.value;
      if (state.searchFrame) window.cancelAnimationFrame(state.searchFrame);
      state.searchFrame = window.requestAnimationFrame(function () {
        state.searchFrame = 0;
        applyCatalogueFilters();
      });
    });

    elements["category-filters"].addEventListener("click", function (event) {
      const button = event.target.closest("[data-category]");
      if (!button) return;
      state.category = button.dataset.category;
      renderFilterOptions();
      applyCatalogueFilters();
    });
    elements["brewery-filter"].addEventListener("change", function (event) {
      state.brewery = event.target.value || "All";
      applyCatalogueFilters();
    });
    elements["sort-products"].addEventListener("change", function (event) {
      state.sort = event.target.value || "brewery-az";
      applyCatalogueFilters();
    });
    elements["catalogue-clear-all"].addEventListener("click", resetFilters);
    elements["clear-filters"].addEventListener("click", resetFilters);

    elements["product-grid"].addEventListener("click", function (event) {
      handleQuantityButton(event.target.closest("[data-action]"), "catalogue");
    });
    elements["product-grid"].addEventListener("change", function (event) {
      if (!event.target.matches("[data-quantity]")) return;
      setQuantity(event.target.dataset.quantity, event.target.value);
    });
    elements["summary-items"].addEventListener("click", function (event) {
      handleQuantityButton(event.target.closest("[data-action]"), "summary");
    });
    elements["review-items"].addEventListener("click", function (event) {
      handleQuantityButton(event.target.closest("[data-action]"), "review");
    });

    elements["review-order"].addEventListener("click", openCheckout);
    elements["mobile-order-bar"].addEventListener("click", openCheckout);
    elements["close-checkout"].addEventListener("click", function () { closeCheckout(); });

    elements["checkout-dialog"].addEventListener("cancel", function (event) {
      if (state.submitting) event.preventDefault();
    });
    elements["checkout-dialog"].addEventListener("close", syncBodyDialogState);
    elements["success-dialog"].addEventListener("close", syncBodyDialogState);
    elements["success-dialog"].addEventListener("cancel", function () {
      window.setTimeout(syncBodyDialogState, 0);
    });

    elements["checkout-form"].addEventListener("change", function (event) {
      if (event.target.name === "fulfilment") toggleFulfilment();
      if (event.target.matches("input, textarea, select")) clearFieldError(event.target);
      if (event.target.name === "province" || event.target.name === "fulfilment") renderReview();
      syncDeliveryField();
      persistDraft();
    });
    elements["checkout-form"].addEventListener("input", function (event) {
      if (event.target.name === "postalCode") event.target.value = normalizePostal(event.target.value);
      if (event.target.matches("input, textarea, select")) clearFieldError(event.target);
      syncDeliveryField();
    });
    elements["checkout-form"].addEventListener("submit", submitCheckout);

    elements["place-another-order"].addEventListener("click", function () {
      if (elements["success-dialog"].open) elements["success-dialog"].close();
      syncBodyDialogState();
      window.scrollTo({ top: 0, behavior: "smooth" });
      elements["search-input"].focus({ preventScroll: true });
    });

    window.addEventListener("pageshow", syncBodyDialogState);
  }

  function hideCatalogueLoader() {
    elements["catalogue-status"].hidden = true;
    elements["catalogue"].setAttribute("aria-busy", "false");
  }

  function showCatalogueError() {
    elements["catalogue-status"].hidden = false;
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

  function setProducts(products) {
    state.products = (products || []).slice();
    state.productMap = new Map(state.products.map(function (product) { return [product.sku, product]; }));
    reconcileCart();
    renderFilterOptions();
    buildProductCards();
    applyCatalogueFilters();
    renderOrderSummary();
    hideCatalogueLoader();
  }

  async function init() {
    if (state.initialized) return;
    state.initialized = true;
    cacheElements();
    if (!elements["product-grid"] || !elements["checkout-form"]) return;
    loadStoredCart();
    bindEvents();
    restoreDraft();
    toggleFulfilment();
    syncBodyDialogState();

    const cached = loadCatalogueCache();
    if (cached && cached.length) setProducts(cached);

    try {
      const fresh = await loadProducts();
      saveCatalogueCache(fresh);
      if (!cached || catalogueSignature(cached) !== catalogueSignature(fresh)) setProducts(fresh);
      else hideCatalogueLoader();
    } catch (error) {
      console.error("Catalogue load failed:", error);
      if (!cached || !cached.length) showCatalogueError();
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
    normalizeApiProduct: normalizeApiProduct,
    calculateCart: calculateCart,
    filterProducts: filterProducts,
    sortProducts: sortProducts,
    validateCheckout: validateCheckout,
    clampQuantity: clampQuantity,
    normalizePostal: normalizePostal,
    isValidPostal: isValidPostal,
    getTaxRule: getTaxRule,
    shouldBodyBeLocked: shouldBodyBeLocked
  };
});
