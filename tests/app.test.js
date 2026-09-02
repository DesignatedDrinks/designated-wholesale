const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../app.js");

test("parseCsv handles commas, escaped quotes and line breaks inside quoted fields", () => {
  const csv = 'Product,Image,Status\n"Brand, Product","https://example.com/a.png","yes"\n"Quoted ""Name""","line 1\nline 2","no"';
  assert.deepEqual(app.parseCsv(csv), [
    ["Product", "Image", "Status"],
    ["Brand, Product", "https://example.com/a.png", "yes"],
    ['Quoted "Name"', "line 1\nline 2", "no"]
  ]);
});

test("normalizeProductRow maps Shopify-backed sheet fields including case availability", () => {
  const row = new Array(19).fill("");
  row[0] = "Bellwoods Brewery (Non-Alcoholic) Stay Classy IPA";
  row[1] = "473mL Can";
  row[2] = 5;
  row[3] = 3.5;
  row[4] = "https://example.com/beer.png";
  row[5] = 84;
  row[6] = "yes";
  row[7] = "DDW-0012";
  row[8] = "Bellwoods Brewery";
  row[9] = "Beer";
  row[10] = "IPA";
  row[11] = "24 × 473mL Can";
  row[12] = 12;
  row[15] = 7;
  row[18] = "gid://shopify/Product/123";

  const product = app.normalizeProductRow(row, 12);
  assert.equal(product.sku, "DDW-0012");
  assert.equal(product.brand, "Bellwoods Brewery");
  assert.equal(product.name, "Stay Classy IPA");
  assert.equal(product.casePrice, 84);
  assert.equal(product.maxCases, 7);
  assert.equal(product.productId, "gid://shopify/Product/123");
});

test("productsFromCsv excludes inactive products", () => {
  const header = new Array(19).fill("");
  header[0] = "Product";
  const active = new Array(19).fill("");
  active[0] = "B Brand (Non-Alcoholic) IPA";
  active[1] = "473mL Can";
  active[5] = "84";
  active[6] = "yes";
  active[15] = "3";
  const inactive = active.slice();
  inactive[0] = "A Brand (Non-Alcoholic) Cider";
  inactive[6] = "no";
  const csv = [header, inactive, active].map((row) => row.join(",")).join("\n");
  const products = app.productsFromCsv(csv);
  assert.equal(products.length, 1);
  assert.equal(products[0].name, "IPA");
  assert.equal(products[0].maxCases, 3);
});

test("calculateCart caps quantities at available wholesale cases", () => {
  const products = new Map([
    ["A", { sku: "A", casePrice: 79.92, maxCases: 2 }],
    ["B", { sku: "B", casePrice: 84, maxCases: 1 }]
  ]);
  const cart = new Map([["A", 9], ["B", 1]]);
  const totals = app.calculateCart(cart, products, 0.13);
  assert.equal(totals.cases, 3);
  assert.equal(totals.subtotal, 243.84);
  assert.equal(totals.tax, 31.7);
  assert.equal(totals.total, 275.54);
});

test("filterProducts searches across product data and filters brewery/category", () => {
  const products = [
    { brand: "Bellwoods", name: "Stay Classy", catalogTitle: "Bellwoods Stay Classy IPA", category: "Beer", style: "IPA", caseFormat: "24 × 473mL" },
    { brand: "Sober Carpenter", name: "Apple Cider", catalogTitle: "Sober Carpenter Apple Cider", category: "Cider", style: "Cider", caseFormat: "24 × 473mL" }
  ];
  assert.deepEqual(app.filterProducts(products, "bell", "All", "All"), [products[0]]);
  assert.deepEqual(app.filterProducts(products, "", "Cider", "All"), [products[1]]);
  assert.deepEqual(app.filterProducts(products, "", "All", "Bellwoods"), [products[0]]);
});

test("sortProducts provides stable human-friendly sort choices", () => {
  const products = [
    { brand: "Zed", name: "Alpha", casePrice: 50 },
    { brand: "Able", name: "Zulu", casePrice: 70 },
    { brand: "Able", name: "Beta", casePrice: 60 }
  ];
  assert.deepEqual(app.sortProducts(products, "brewery-az").map((p) => p.name), ["Beta", "Zulu", "Alpha"]);
  assert.deepEqual(app.sortProducts(products, "product-az").map((p) => p.name), ["Alpha", "Beta", "Zulu"]);
  assert.deepEqual(app.sortProducts(products, "price-high").map((p) => p.casePrice), [70, 60, 50]);
});

test("Canadian postal code normalization and province tax rules are deterministic", () => {
  assert.equal(app.normalizePostal("n6p1a7"), "N6P 1A7");
  assert.equal(app.isValidPostal("N6P 1A7"), true);
  assert.equal(app.isValidPostal("90210"), false);
  assert.deepEqual(app.getTaxRule("ON", "Delivery"), { code: "ON", name: "Ontario", label: "HST", rate: 0.13 });
  assert.equal(app.getTaxRule("NS", "Delivery").rate, 0.14);
  assert.equal(app.getTaxRule("BC", "Delivery").rate, 0.05);
  assert.equal(app.getTaxRule("BC", "Pickup").rate, 0.13);
});

test("validateCheckout enforces the short structured checkout and skips delivery address for pickup", () => {
  const valid = {
    companyName: "Royal City",
    fullName: "Taylor",
    email: "buyer@example.ca",
    phone: "519-555-0100",
    fulfilment: "Delivery",
    addressLine1: "123 Main Street",
    city: "Guelph",
    province: "ON",
    postalCode: "N1G 1A1"
  };
  assert.deepEqual(app.validateCheckout(valid), {});
  assert.deepEqual(app.validateCheckout({ ...valid, fulfilment: "Pickup", addressLine1: "", city: "", province: "", postalCode: "" }), {});

  const errors = app.validateCheckout({
    companyName: "",
    fullName: "",
    email: "bad",
    phone: "12",
    fulfilment: "Delivery",
    addressLine1: "",
    city: "",
    province: "XX",
    postalCode: "123"
  });
  assert.deepEqual(Object.keys(errors).sort(), ["addressLine1", "city", "companyName", "email", "fullName", "phone", "postalCode", "province"]);
});

test("clampQuantity prevents negative, oversized, and over-stock quantities", () => {
  assert.equal(app.clampQuantity("-5"), 0);
  assert.equal(app.clampQuantity("4", 3), 3);
  assert.equal(app.clampQuantity("10000"), 999);
  assert.equal(app.clampQuantity("nope"), 0);
});

test("dialog body lock is released whenever all dialogs are closed", () => {
  assert.equal(app.shouldBodyBeLocked(true, false), true);
  assert.equal(app.shouldBodyBeLocked(false, true), true);
  assert.equal(app.shouldBodyBeLocked(false, false), false);
});
