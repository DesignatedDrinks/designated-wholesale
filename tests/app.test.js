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

test("normalizeProductRow maps the existing Sheet columns without re-entry", () => {
  const product = app.normalizeProductRow([
    "Bellwoods Brewery (Non-Alcoholic) Stay Classy IPA",
    "473mL Can",
    5,
    3.5,
    "https://example.com/beer.png",
    84,
    "yes"
  ], 12);

  assert.equal(product.sku, "DDW-0012");
  assert.equal(product.brand, "Bellwoods Brewery");
  assert.equal(product.name, "Stay Classy IPA");
  assert.equal(product.category, "Beer");
  assert.equal(product.style, "IPA");
  assert.equal(product.caseFormat, "24 × 473mL Can");
  assert.equal(product.casePrice, 84);
  assert.equal(product.active, true);
});

test("productsFromCsv excludes inactive products and sorts active products", () => {
  const csv = [
    " ,Pack Size,Retail Price,Wholesale Price,Image URL,24-Pack Price,Status",
    "Z Brand (Non-Alcoholic) Lager,355mL Can,4,2.8,z.png,67.2,yes",
    "A Brand (Non-Alcoholic) Cider,355mL Can,4,2.8,a.png,67.2,no",
    "B Brand (Non-Alcoholic) IPA,473mL Can,5,3.5,b.png,84,yes"
  ].join("\n");

  const products = app.productsFromCsv(csv);
  assert.equal(products.length, 2);
  assert.deepEqual(products.map((product) => product.name), ["Lager", "IPA"]);
});

test("calculateCart uses case prices, quantities and 13 percent HST", () => {
  const products = new Map([
    ["DDW-0002", { sku: "DDW-0002", casePrice: 79.92 }],
    ["DDW-0003", { sku: "DDW-0003", casePrice: 84 }]
  ]);
  const cart = new Map([["DDW-0002", 2], ["DDW-0003", 1]]);
  const totals = app.calculateCart(cart, products, 0.13);

  assert.equal(totals.cases, 3);
  assert.equal(totals.subtotal, 243.84);
  assert.equal(totals.tax, 31.7);
  assert.equal(totals.total, 275.54);
});

test("filterProducts searches brand, style and category", () => {
  const products = [
    { brand: "Bellwoods", name: "Stay Classy", catalogTitle: "Bellwoods Stay Classy IPA", category: "Beer", style: "IPA", caseFormat: "24 × 473mL" },
    { brand: "Sober Carpenter", name: "Apple Cider", catalogTitle: "Sober Carpenter Apple Cider", category: "Cider", style: "Cider", caseFormat: "24 × 473mL" }
  ];

  assert.deepEqual(app.filterProducts(products, "bell", "All"), [products[0]]);
  assert.deepEqual(app.filterProducts(products, "", "Cider"), [products[1]]);
  assert.deepEqual(app.filterProducts(products, "ipa", "Beer"), [products[0]]);
});

test("validateCheckout enforces only the short required checkout", () => {
  const valid = {
    companyName: "Royal City",
    fullName: "Taylor",
    email: "buyer@example.ca",
    phone: "519-555-0100",
    fulfilment: "Delivery",
    deliveryAddress: "123 Main Street"
  };
  assert.deepEqual(app.validateCheckout(valid), {});

  const pickup = { ...valid, fulfilment: "Pickup", deliveryAddress: "" };
  assert.deepEqual(app.validateCheckout(pickup), {});

  const errors = app.validateCheckout({
    companyName: "",
    fullName: "",
    email: "not-an-email",
    phone: "12",
    fulfilment: "Delivery",
    deliveryAddress: ""
  });
  assert.deepEqual(Object.keys(errors).sort(), [
    "companyName",
    "deliveryAddress",
    "email",
    "fullName",
    "phone"
  ]);
});

test("clampQuantity prevents negative and oversized case quantities", () => {
  assert.equal(app.clampQuantity("-5"), 0);
  assert.equal(app.clampQuantity("4"), 4);
  assert.equal(app.clampQuantity("10000"), 999);
  assert.equal(app.clampQuantity("nope"), 0);
});
