(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;

  const ADDRESS_KEY = "ddw-wholesale-address-v4";
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

  const PROVINCES = Object.keys(TAX_RULES)
    .map(function (code) { return [code, TAX_RULES[code].name]; })
    .sort(function (a, b) { return a[1].localeCompare(b[1]); });

  function roundMoney(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }

  function parseMoney(text) {
    const value = Number(String(text || "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(value) ? value : 0;
  }

  function formatMoney(value) {
    return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(roundMoney(value));
  }

  function provinceOptions() {
    return ['<option value="">Select province</option>'].concat(PROVINCES.map(function (entry) {
      return '<option value="' + entry[0] + '">' + entry[1] + '</option>';
    })).join("");
  }

  function injectStyles() {
    if (document.getElementById("checkout-flow-v2-styles")) return;
    const style = document.createElement("style");
    style.id = "checkout-flow-v2-styles";
    style.textContent = [
      ".checkout-form{display:grid;gap:16px}",
      ".checkout-fast-intro{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}",
      ".checkout-fast-intro h3{margin:0;font-size:1.2rem}",
      ".checkout-fast-intro p{margin:4px 0 0;color:var(--muted);font-size:.82rem}",
      ".checkout-required-note{flex:0 0 auto;color:var(--muted);font-size:.72rem;font-weight:700}",
      ".checkout-contact-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}",
      ".checkout-contact-grid .company-field{grid-column:1/-1}",
      ".checkout-form .field{display:grid;gap:5px;min-width:0}",
      ".checkout-form .field>span{font-size:.76rem;font-weight:800;color:var(--navy-900)}",
      ".checkout-form .field em{font-style:normal;color:var(--muted);font-weight:500}",
      ".checkout-form input,.checkout-form textarea,.checkout-form select{width:100%;min-height:46px;padding:10px 12px;border:1px solid var(--line-strong);border-radius:11px;background:#fff;color:var(--ink);outline:0}",
      ".checkout-form input:focus,.checkout-form textarea:focus,.checkout-form select:focus{border-color:var(--blue-500);box-shadow:0 0 0 3px rgba(22,132,217,.12)}",
      ".checkout-form .field.has-error input,.checkout-form .field.has-error textarea,.checkout-form .field.has-error select{border-color:var(--danger)}",
      ".checkout-form .field-error{min-height:0;color:var(--danger);font-size:.7rem}",
      ".fulfilment-choice{margin:0;padding:0;border:0;display:grid;grid-template-columns:1fr 1fr;gap:9px}",
      ".fulfilment-choice legend{grid-column:1/-1;margin:0 0 1px;font-size:.76rem;font-weight:800;color:var(--navy-900)}",
      ".fulfilment-choice label{position:relative;display:block;cursor:pointer}",
      ".fulfilment-choice input{position:absolute!important;opacity:0!important;pointer-events:none;width:1px!important;height:1px!important}",
      ".fulfilment-choice label>span{min-height:68px;padding:12px 14px;display:grid;align-content:center;border:1px solid var(--line-strong);border-radius:12px;background:#fff;transition:.15s ease}",
      ".fulfilment-choice strong{font-size:.9rem}",
      ".fulfilment-choice small{margin-top:2px;color:var(--muted);font-size:.72rem}",
      ".fulfilment-choice input:checked+span{border-color:var(--blue-500);box-shadow:0 0 0 2px rgba(22,132,217,.11);background:#f7fbff}",
      ".delivery-card{padding:14px;border:1px solid var(--line);border-radius:14px;background:#f8fafc}",
      ".delivery-card-header{margin-bottom:10px}",
      ".delivery-card-header strong{font-size:.9rem}",
      ".delivery-card-header span{display:block;margin-top:2px;color:var(--muted);font-size:.72rem}",
      ".address-grid{display:grid;grid-template-columns:.7fr 1.3fr;gap:9px}",
      ".address-grid .street-field{grid-column:1/-1}",
      ".address-grid .unit-field{grid-column:1/2}",
      ".tax-preview{margin-top:10px;padding:9px 11px;display:flex;justify-content:space-between;gap:10px;align-items:center;border-radius:10px;background:#eaf4fc;color:#36536f;font-size:.74rem}",
      ".tax-preview strong{color:var(--navy-900)}",
      ".optional-order-details{border:1px solid var(--line);border-radius:12px;background:#fff}",
      ".optional-order-details summary{padding:11px 13px;cursor:pointer;color:var(--navy-900);font-size:.78rem;font-weight:800;list-style:none}",
      ".optional-order-details summary::-webkit-details-marker{display:none}",
      ".optional-order-details summary:after{content:'+';float:right;font-size:1rem}",
      ".optional-order-details[open] summary:after{content:'−'}",
      ".optional-order-fields{padding:0 13px 13px;display:grid;grid-template-columns:.8fr 1.2fr;gap:9px}",
      ".review-totals #tax-destination{display:block;margin-top:2px;color:var(--muted);font-size:.66rem;font-weight:500}",
      ".checkout-form .place-order{margin-top:0;min-height:52px}",
      "#delivery-address[hidden],#delivery-province[hidden],#delivery-tax-label[hidden],#delivery-tax-rate[hidden]{display:none!important}",
      "@media(max-width:760px){.checkout-contact-grid,.address-grid,.optional-order-fields,.fulfilment-choice{grid-template-columns:1fr}.checkout-contact-grid .company-field,.address-grid .street-field,.address-grid .unit-field,.fulfilment-choice legend{grid-column:auto}.delivery-card{padding:12px}.checkout-fast-intro{display:block}.checkout-required-note{display:none}}"
    ].join("\n");
    document.head.appendChild(style);
  }

  function installMarkup() {
    const form = document.getElementById("checkout-form");
    if (!form || form.dataset.fastCheckoutV2 === "true") return;
    form.dataset.fastCheckoutV2 = "true";
    injectStyles();

    form.innerHTML = [
      '<div class="checkout-fast-intro"><div><h3>Checkout details</h3><p>Just the information needed to confirm your order.</p></div><span class="checkout-required-note">Required unless marked optional</span></div>',
      '<div class="checkout-contact-grid">',
        '<label class="field company-field"><span>Company</span><input id="company-name" name="companyName" type="text" autocomplete="organization" maxlength="160" required><small class="field-error"></small></label>',
        '<label class="field"><span>Contact</span><input id="contact-name" name="fullName" type="text" autocomplete="name" maxlength="120" required><small class="field-error"></small></label>',
        '<label class="field"><span>Email</span><input id="email" name="email" type="email" autocomplete="email" maxlength="200" required><small class="field-error"></small></label>',
        '<label class="field"><span>Phone</span><input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="40" required><small class="field-error"></small></label>',
      '</div>',
      '<fieldset class="fulfilment-choice"><legend>Receive order</legend>',
        '<label><input type="radio" name="fulfilment" value="Delivery" checked><span><strong>Delivery</strong><small>Ship to your business.</small></span></label>',
        '<label><input type="radio" name="fulfilment" value="Pickup"><span><strong>Pickup</strong><small>Pick up in Ontario.</small></span></label>',
      '</fieldset>',
      '<section id="address-field" class="delivery-card">',
        '<div class="delivery-card-header"><strong>Delivery address</strong><span>Province automatically sets the GST/HST estimate.</span></div>',
        '<div class="address-grid">',
          '<label class="field street-field"><span>Street address</span><input id="address-line1" type="text" autocomplete="address-line1" maxlength="160" required><small class="field-error"></small></label>',
          '<label class="field unit-field"><span>Unit <em>Optional</em></span><input id="address-line2" type="text" autocomplete="address-line2" maxlength="80"><small class="field-error"></small></label>',
          '<label class="field"><span>City</span><input id="address-city" type="text" autocomplete="address-level2" maxlength="100" required><small class="field-error"></small></label>',
          '<label class="field"><span>Province</span><select id="address-province" autocomplete="address-level1" required>' + provinceOptions() + '</select><small class="field-error"></small></label>',
          '<label class="field"><span>Postal code</span><input id="address-postal" type="text" inputmode="text" autocomplete="postal-code" maxlength="7" placeholder="A1A 1A1" required><small class="field-error"></small></label>',
        '</div>',
        '<div class="tax-preview"><span id="checkout-tax-context">Select a province to calculate GST/HST</span><strong id="checkout-tax-rate">—</strong></div>',
        '<textarea id="delivery-address" name="deliveryAddress" maxlength="500" hidden></textarea>',
        '<input id="delivery-province" name="province" type="hidden">',
        '<input id="delivery-tax-label" name="taxLabel" type="hidden">',
        '<input id="delivery-tax-rate" name="taxRate" type="hidden">',
      '</section>',
      '<details class="optional-order-details"><summary>PO number or order notes (optional)</summary><div class="optional-order-fields">',
        '<label class="field"><span>PO number</span><input name="poNumber" type="text" maxlength="80"></label>',
        '<label class="field"><span>Order notes</span><input name="notes" type="text" maxlength="500"></label>',
      '</div></details>',
      '<label class="honeypot" aria-hidden="true">Website<input name="website" type="text" tabindex="-1" autocomplete="off"></label>',
      '<div id="form-alert" class="form-alert" role="alert" hidden></div>',
      '<button id="place-order" class="primary-button place-order" type="submit"><span>Place wholesale order</span><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m13 5-1.4 1.4 4.6 4.6H4v2h12.2l-4.6 4.6L13 19l7-7-7-7Z"/></svg></button>',
      '<p class="form-footnote">Order request only. Final freight is confirmed before invoicing.</p>'
    ].join("");

    const taxAmount = document.getElementById("review-tax");
    const taxRow = taxAmount && taxAmount.closest("div");
    const label = taxRow && taxRow.querySelector("dt");
    if (label) {
      label.id = "review-tax-label";
      label.innerHTML = 'Tax<small id="tax-destination">Select delivery province</small>';
    }
  }

  function currentFulfilment() {
    const checked = document.querySelector('#checkout-form [name="fulfilment"]:checked');
    return checked ? checked.value : "Delivery";
  }

  function currentProvince() {
    if (currentFulfilment() === "Pickup") return "ON";
    const select = document.getElementById("address-province");
    return select ? select.value : "";
  }

  function currentTaxRule() {
    return TAX_RULES[currentProvince()] || null;
  }

  function normalizePostal(value) {
    const compact = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    return compact.length > 3 ? compact.slice(0, 3) + " " + compact.slice(3) : compact;
  }

  function buildDeliveryAddress() {
    if (currentFulfilment() !== "Delivery") return "";
    const street = String((document.getElementById("address-line1") || {}).value || "").trim();
    const unit = String((document.getElementById("address-line2") || {}).value || "").trim();
    const city = String((document.getElementById("address-city") || {}).value || "").trim();
    const province = currentProvince();
    const postal = normalizePostal(String((document.getElementById("address-postal") || {}).value || ""));
    const lines = [street];
    if (unit) lines.push(unit);
    if (city || province || postal) lines.push(city + (city && province ? ", " : "") + province + (postal ? " " + postal : ""));
    return lines.filter(Boolean).join("\n");
  }

  function syncHiddenFields() {
    const province = currentProvince();
    const rule = TAX_RULES[province] || null;
    const address = document.getElementById("delivery-address");
    const provinceInput = document.getElementById("delivery-province");
    const taxLabel = document.getElementById("delivery-tax-label");
    const taxRate = document.getElementById("delivery-tax-rate");
    if (address) address.value = buildDeliveryAddress();
    if (provinceInput) provinceInput.value = province;
    if (taxLabel) taxLabel.value = rule ? rule.label : "";
    if (taxRate) taxRate.value = rule ? String(rule.rate) : "";
  }

  function getEstimate() {
    const rule = currentTaxRule();
    const subtotal = parseMoney((document.getElementById("review-subtotal") || {}).textContent);
    const tax = rule ? roundMoney(subtotal * rule.rate) : 0;
    return {
      province: currentProvince(),
      provinceName: rule ? rule.name : "",
      taxLabel: rule ? rule.label : "",
      taxRate: rule ? rule.rate : 0,
      subtotal: subtotal,
      tax: tax,
      total: roundMoney(subtotal + tax)
    };
  }

  function refreshTax() {
    syncHiddenFields();
    const estimate = getEstimate();
    const rule = currentTaxRule();
    const context = document.getElementById("checkout-tax-context");
    const rate = document.getElementById("checkout-tax-rate");
    const label = document.getElementById("review-tax-label");
    const destination = document.getElementById("tax-destination");
    const taxNode = document.getElementById("review-tax");
    const totalNode = document.getElementById("review-total");

    if (context) context.textContent = rule ? rule.label + " based on " + rule.name : "Select a province to calculate GST/HST";
    if (rate) rate.textContent = rule ? Math.round(rule.rate * 100) + "%" : "—";
    if (label) {
      const text = rule ? rule.label + " (" + Math.round(rule.rate * 100) + "%)" : "Tax";
      if (label.childNodes.length) label.childNodes[0].nodeValue = text;
      else label.insertBefore(document.createTextNode(text), label.firstChild);
    }
    if (destination) destination.textContent = rule
      ? (currentFulfilment() === "Pickup" ? "Ontario pickup" : rule.name + " delivery")
      : "Select delivery province";
    if (taxNode && rule) {
      const next = formatMoney(estimate.tax);
      if (taxNode.textContent !== next) taxNode.textContent = next;
    }
    if (totalNode && rule) {
      const nextTotal = formatMoney(estimate.total);
      if (totalNode.textContent !== nextTotal) totalNode.textContent = nextTotal;
    }
  }

  function saveAddressDraft() {
    try {
      const ids = ["address-line1", "address-line2", "address-city", "address-province", "address-postal"];
      const data = {};
      ids.forEach(function (id) {
        const element = document.getElementById(id);
        data[id] = element ? element.value : "";
      });
      localStorage.setItem(ADDRESS_KEY, JSON.stringify(data));
    } catch (error) {}
  }

  function restoreAddressDraft() {
    try {
      const data = JSON.parse(localStorage.getItem(ADDRESS_KEY) || "null");
      if (!data) return;
      Object.keys(data).forEach(function (id) {
        const element = document.getElementById(id);
        if (element && !element.value) element.value = data[id] || "";
      });
    } catch (error) {}
  }

  function setFieldValidity(element, message) {
    if (!element) return false;
    element.setCustomValidity(message || "");
    const field = element.closest(".field");
    if (field) field.classList.toggle("has-error", Boolean(message));
    const error = field && field.querySelector(".field-error");
    if (error) error.textContent = message || "";
    return !message;
  }

  function validateAddress() {
    if (currentFulfilment() !== "Delivery") {
      syncHiddenFields();
      return true;
    }

    const street = document.getElementById("address-line1");
    const city = document.getElementById("address-city");
    const province = document.getElementById("address-province");
    const postal = document.getElementById("address-postal");
    const postalValue = normalizePostal(postal && postal.value);
    if (postal) postal.value = postalValue;

    const results = [
      setFieldValidity(street, street && street.value.trim() ? "" : "Enter the street address."),
      setFieldValidity(city, city && city.value.trim() ? "" : "Enter the city."),
      setFieldValidity(province, province && TAX_RULES[province.value] ? "" : "Select the province."),
      setFieldValidity(postal, /^[A-Z]\d[A-Z] \d[A-Z]\d$/.test(postalValue) ? "" : "Enter a Canadian postal code.")
    ];

    syncHiddenFields();
    const valid = results.every(Boolean);
    if (!valid) {
      const first = document.querySelector("#address-field .field.has-error input, #address-field .field.has-error select");
      if (first) first.focus();
    }
    return valid;
  }

  function clearOwnError(target) {
    if (!target) return;
    target.setCustomValidity("");
    const field = target.closest(".field");
    if (field) field.classList.remove("has-error");
    const error = field && field.querySelector(".field-error");
    if (error) error.textContent = "";
  }

  function bind() {
    const form = document.getElementById("checkout-form");
    if (!form) return;
    restoreAddressDraft();
    syncHiddenFields();
    refreshTax();

    form.addEventListener("submit", function (event) {
      syncHiddenFields();
      if (!validateAddress()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const alert = document.getElementById("form-alert");
        if (alert) {
          alert.textContent = "Complete the delivery address to continue.";
          alert.hidden = false;
        }
      }
    }, true);

    form.addEventListener("change", function (event) {
      if (event.target.matches("#address-field input, #address-field select")) {
        clearOwnError(event.target);
        saveAddressDraft();
      }
      if (event.target.id === "address-province" || event.target.name === "fulfilment") {
        window.requestAnimationFrame(refreshTax);
      } else {
        syncHiddenFields();
      }
    });

    form.addEventListener("input", function (event) {
      if (event.target.id === "address-postal") event.target.value = normalizePostal(event.target.value);
      if (event.target.matches("#address-field input")) {
        clearOwnError(event.target);
        saveAddressDraft();
        syncHiddenFields();
      }
    });

    const subtotalNode = document.getElementById("review-subtotal");
    if (subtotalNode) {
      const observer = new MutationObserver(function () {
        window.requestAnimationFrame(refreshTax);
      });
      observer.observe(subtotalNode, { childList: true, characterData: true, subtree: true });
    }

    ["review-order", "mobile-order-bar"].forEach(function (id) {
      const button = document.getElementById(id);
      if (button) button.addEventListener("click", function () { window.setTimeout(refreshTax, 0); });
    });
  }

  window.DDWCheckoutTax = {
    rules: TAX_RULES,
    getEstimate: getEstimate,
    refresh: refreshTax,
    sync: syncHiddenFields
  };

  installMarkup();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();
