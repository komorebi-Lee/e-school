const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const miniappDirectory = path.join(__dirname, '..', 'miniprogram');

function readMiniappFile(relativePath) {
  return fs.readFileSync(path.join(miniappDirectory, relativePath), 'utf8');
}

function listMiniappFiles() {
  return fs.readdirSync(miniappDirectory, { recursive: true })
    .filter((item) => String(item).endsWith('.js'))
    .map((item) => path.join(miniappDirectory, String(item)));
}

test('miniapp keeps orders and service records in the server store', () => {
  const forbiddenStorageKeys = [
    'campusGoOrders',
    'campusCardApplication',
    'campusGoAfterSales'
  ];

  for (const file of listMiniappFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const key of forbiddenStorageKeys) {
      assert.equal(source.includes(key), false, `${path.relative(process.cwd(), file)} should not use local business key ${key}`);
    }
  }
});

test('miniapp local store only provides product fallback reads', () => {
  const source = readMiniappFile(path.join('services', 'store.js'));
  assert.ok(source.includes('module.exports = { getScooters, getScooter }'));
  assert.equal(source.includes('createOrder'), false);
  assert.equal(source.includes('saveAfterSales'), false);
  assert.equal(source.includes('saveCardApplication'), false);
});

test('miniapp order and after-sale pages use the API layer', () => {
  for (const relativePath of [
    path.join('pages', 'orders', 'orders.js'),
    path.join('pages', 'aftersales', 'aftersales.js'),
    path.join('pages', 'checkout', 'checkout.js')
  ]) {
    const source = readMiniappFile(relativePath);
    assert.ok(source.includes("require('../../services/api')"));
    assert.equal(source.includes("require('../../services/store')"), false);
  }
});

test('miniapp uses a shared payment action for mock and wechat jsapi payments', () => {
  const paymentService = readMiniappFile(path.join('services', 'payment.js'));
  assert.ok(paymentService.includes('wx.requestPayment'));
  assert.ok(paymentService.includes('/confirm'));
  assert.ok(paymentService.includes('payPaymentOrderById'));

  const paymentPages = [
    path.join('pages', 'checkout', 'checkout.js'),
    path.join('pages', 'card', 'card.js'),
    path.join('pages', 'plate', 'plate.js'),
    path.join('pages', 'recharge', 'detail.js'),
    path.join('pages', 'orders', 'orders.js')
  ];
  for (const relativePath of paymentPages) {
    const source = readMiniappFile(relativePath);
    assert.ok(source.includes('services/payment'), `${relativePath} should use the shared payment service`);
    assert.equal(source.includes("'/confirm'"), false, `${relativePath} should not confirm payment inline`);
  }
});

test('payment surfaces use production-ready payment wording', () => {
  const paymentSurfaceFiles = [
    path.join('pages', 'checkout', 'checkout.wxml'),
    path.join('pages', 'checkout', 'checkout.js'),
    path.join('pages', 'recharge', 'detail.wxml'),
    path.join('pages', 'recharge', 'detail.js')
  ];
  for (const relativePath of paymentSurfaceFiles) {
    const source = readMiniappFile(relativePath);
    assert.equal(source.includes('模拟支付'), false, `${relativePath} should not label production payment as simulated`);
  }
});

test('miniapp registers each page route once', () => {
  const appConfig = JSON.parse(readMiniappFile('app.json'));
  const pageRoutes = appConfig.pages;

  assert.equal(pageRoutes.length, new Set(pageRoutes).size);
  for (const route of pageRoutes) {
    for (const extension of ['.js', '.json', '.wxml', '.wxss']) {
      assert.ok(fs.existsSync(path.join(miniappDirectory, `${route}${extension}`)), `${route}${extension} should exist`);
    }
  }
});

test('campus map data covers professional buildings and daily services', () => {
  const mapData = require('../miniprogram/data/campus-map');
  const names = mapData.spots.map((spot) => spot.title);

  for (const name of [
    '人文社科楼',
    '工学院',
    '动科楼',
    '水产学院',
    '景园楼',
    '食品学院',
    '教超',
    '二十四节气柱',
    '健身房',
    '运动场'
  ]) {
    assert.ok(names.includes(name), `${name} should be searchable on the campus map`);
  }

  for (const spot of mapData.spots) {
    assert.match(spot.source, /hzau|华中农业大学/i);
    assert.equal(typeof spot.x, 'number');
    assert.equal(typeof spot.y, 'number');
    assert.ok(spot.qImage);
    assert.ok(spot.realImage);
  }
});

test('campus map search matches aliases and category filters', () => {
  const { searchSpots, filterSpots } = require('../miniprogram/data/campus-map');

  assert.deepEqual(searchSpots('动科').map((spot) => spot.title), ['动科楼']);
  assert.deepEqual(searchSpots('二十四节气').map((spot) => spot.title), ['二十四节气柱']);
  assert.ok(filterSpots('professional').every((spot) => spot.category === 'professional'));
  assert.ok(filterSpots('commerce').some((spot) => spot.title === '教超'));
});

test('campus map route summary provides walking distance and time', () => {
  const { getRouteSummary, getSpotById } = require('../miniprogram/data/campus-map');
  const southGate = getSpotById('south-gate');
  const library = getSpotById('library');
  const summary = getRouteSummary(southGate, library);

  assert.equal(summary.start, '南校门');
  assert.equal(summary.end, '图书馆');
  assert.ok(summary.distanceMeters > 0);
  assert.equal(summary.distanceText, `${summary.distanceMeters} 米`);
  assert.match(summary.durationText, /分钟/);
  assert.ok(summary.landmarks.length > 0);
});

test('map page exposes search, route, image toggle, and official map entry points', () => {
  const wxml = readMiniappFile(path.join('pages', 'map', 'map.wxml'));
  const js = readMiniappFile(path.join('pages', 'map', 'map.js'));

  for (const marker of [
    'bindinput="onSearchInput"',
    'bindtap="startRoute"',
    'bindtap="toggleImageMode"',
    'bindtap="openOfficialMap"',
    '搜索建筑、食堂、专业楼'
  ]) {
    assert.ok(wxml.includes(marker), `${marker} should be available in the map UI`);
  }
  for (const marker of ['onSearchInput', 'startRoute', 'toggleImageMode', 'getLocation']) {
    assert.ok(js.includes(marker), `${marker} should be implemented in the map page`);
  }
});

test('merchant apply supports rejected evidence resubmission', () => {
  const js = readMiniappFile(path.join('pages', 'merchant', 'apply.js'));
  const wxml = readMiniappFile(path.join('pages', 'merchant', 'apply.wxml'));

  for (const marker of ['resubmitEvidence', '/resubmit`', 'REJECTED']) {
    assert.ok(js.includes(marker), `${marker} should be implemented in merchant apply page`);
  }
  for (const marker of ['补充资质材料', 'bindtap="resubmitEvidence"', '驳回原因']) {
    assert.ok(wxml.includes(marker), `${marker} should be available in merchant apply UI`);
  }
});

test('merchant surfaces collect qualification expiry for renewals', () => {
  const applyJs = readMiniappFile(path.join('pages', 'merchant', 'apply.js'));
  const applyWxml = readMiniappFile(path.join('pages', 'merchant', 'apply.wxml'));
  const indexJs = readMiniappFile(path.join('pages', 'merchant', 'index.js'));
  const indexWxml = readMiniappFile(path.join('pages', 'merchant', 'index.wxml'));

  assert.ok(applyJs.includes('licenseExpireDate'), 'apply submission should send expiry date');
  assert.ok(applyWxml.includes('mode="date"'), 'apply form should provide a date picker');
  assert.ok(indexJs.includes('submitQualificationRenewal'), 'merchant home should submit renewals');
  assert.ok(indexJs.includes('/api/merchant/qualification-renewals'), 'merchant home should call renewal API');
  assert.ok(indexWxml.includes('资质有效期'), 'merchant home should show current expiry');
  assert.ok(indexWxml.includes('bindtap="submitQualificationRenewal"'), 'merchant home should provide renewal action');
});

test('orders page surfaces after-sale progress and merchant result', () => {
  const js = readMiniappFile(path.join('pages', 'orders', 'orders.js'));
  const wxml = readMiniappFile(path.join('pages', 'orders', 'orders.wxml'));

  assert.ok(js.includes('afterSaleJourney'), 'orders page should build an after-sale journey');
  assert.ok(js.includes('afterSales'), 'orders page should read after-sale records from server data');
  assert.ok(js.includes('售后详情'), 'orders page should guide users to view an active after-sale case');
  assert.ok(wxml.includes('after-sale-panel'), 'orders page should show an after-sale panel');
  assert.ok(wxml.includes('处理结果'), 'orders page should show the merchant resolution note');
  assert.ok(wxml.includes('item.afterSale.resolutionNote'), 'orders page should bind the merchant resolution note');
});

test('merchant products expose an inventory movement ledger', () => {
  const js = readMiniappFile(path.join('pages', 'merchant', 'products.js'));
  const wxml = readMiniappFile(path.join('pages', 'merchant', 'products.wxml'));

  assert.ok(js.includes('/api/merchant/stock-movements'), 'merchant products should load the stock movement API');
  assert.ok(js.includes('decorateStockMovements'), 'merchant products should decorate stock movement records');
  assert.ok(js.includes('setStockMovementFilter'), 'merchant products should filter stock movements');
  for (const marker of ['库存流水', 'stockMovementFilter', 'bindtap="setStockMovementFilter"', 'item.stockText']) {
    assert.ok(wxml.includes(marker), `${marker} should be available in merchant products UI`);
  }
});

test('merchant products surface sales and restock guidance', () => {
  const js = readMiniappFile(path.join('pages', 'merchant', 'products.js'));
  const wxml = readMiniappFile(path.join('pages', 'merchant', 'products.wxml'));

  assert.ok(js.includes('salesCount'), 'merchant products should preserve product sales counts');
  assert.ok(js.includes('salesText'), 'merchant products should format sales guidance');
  assert.ok(js.includes('restockHint'), 'merchant products should preserve restock hints');
  for (const marker of ['item.salesText', 'item.restockHint']) {
    assert.ok(wxml.includes(marker), `${marker} should be available in merchant products UI`);
  }
});

test('limited recharge promos run as an availability-controlled campaign', () => {
  const cardJs = readMiniappFile(path.join('pages', 'card', 'card.js'));
  const cardWxml = readMiniappFile(path.join('pages', 'card', 'card.wxml'));
  const adminJs = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'admin.js'), 'utf8');
  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'admin.html'), 'utf8');

  assert.ok(cardJs.includes('promoStatus'), 'card page should preserve campaign status from the server');
  assert.ok(cardJs.includes('isBuyable'), 'card page should prevent unavailable promo submission');
  for (const marker of ['item.statusLabel', 'item.availabilityText', 'item.isBuyable']) {
    assert.ok(cardWxml.includes(marker), `${marker} should be shown in the recharge campaign UI`);
  }

  assert.ok(adminJs.includes('p.linkedOrderCount'), 'admin promos should show campaign order metrics');
  assert.ok(adminJs.includes('startsAt'), 'admin promo save should send campaign start time');
  assert.ok(adminJs.includes('endsAt'), 'admin promo save should send campaign end time');
  assert.ok(adminHtml.includes('promoStartsAt'), 'admin promo form should configure start time');
  assert.ok(adminHtml.includes('promoEndsAt'), 'admin promo form should configure end time');
});
