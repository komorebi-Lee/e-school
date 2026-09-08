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
