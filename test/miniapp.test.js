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

test('miniapp JavaScript parses without syntax errors', () => {
  const { execFileSync } = require('node:child_process');
  for (const file of listMiniappFiles()) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  }
});

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

test('checkout reuses and saves delivery addresses', () => {
  const source = readMiniappFile(path.join('pages', 'checkout', 'checkout.js'));
  assert.ok(source.includes('/api/my/addresses'), 'checkout should load and save server addresses');
  assert.ok(source.includes('selectedAddressId'), 'checkout should track the selected address');
  assert.ok(source.includes('saveAddress'), 'checkout should let users save a new address');

  const markup = readMiniappFile(path.join('pages', 'checkout', 'checkout.wxml'));
  assert.ok(markup.includes('saved-addresses'), 'checkout should show saved addresses');
  assert.ok(markup.includes('selectAddress'), 'checkout should let users select an address');
  assert.ok(markup.includes('deleteAddress'), 'checkout should let users delete an address');
});

test('sold-out products can register restock alerts', () => {
  const source = readMiniappFile(path.join('pages', 'detail', 'detail.js'));
  assert.ok(source.includes('/restock-alert'), 'detail should call the restock alert API');
  assert.ok(source.includes('toggleRestockAlert'), 'detail should support restock registration');

  const markup = readMiniappFile(path.join('pages', 'detail', 'detail.wxml'));
  assert.ok(markup.includes('restockSubscribed'), 'detail should show the restock alert state');
});

test('merchant storefront is reachable from product detail', () => {
  const appConfig = JSON.parse(readMiniappFile('app.json'));
  assert.ok(appConfig.pages.includes('pages/store/store'), 'merchant storefront should be a registered page');

  const source = readMiniappFile(path.join('pages', 'store', 'store.js'));
  assert.ok(source.includes('/storefront'), 'storefront should load the merchant storefront API');
  assert.ok(source.includes('goProduct'), 'storefront should link to product detail');
  assert.ok(source.includes('reviewSummary'), 'storefront should summarize verified reviews');
  assert.ok(source.includes('positiveRateText'), 'storefront should show the positive review rate');

  const storeMarkup = readMiniappFile(path.join('pages', 'store', 'store.wxml'));
  assert.ok(storeMarkup.includes('store-reviews'), 'storefront should show verified review evidence');
  assert.ok(storeMarkup.includes('positiveRateText'), 'storefront should show the positive review rate');

  const markup = readMiniappFile(path.join('pages', 'detail', 'detail.wxml'));
  assert.ok(markup.includes('goStore'), 'product detail should provide a storefront entry');
});

test('orders link back to the merchant storefront', () => {
  const js = readMiniappFile(path.join('pages', 'orders', 'orders.js'));
  const wxml = readMiniappFile(path.join('pages', 'orders', 'orders.wxml'));
  assert.ok(js.includes('goStore'), 'orders page should navigate to merchant storefront');
  assert.ok(js.includes('merchantId'), 'orders page should preserve merchant identity');
  assert.ok(wxml.includes('goStore'), 'orders page should expose a storefront action');
});

test('users can favorite products and revisit favorites', () => {
  const appConfig = JSON.parse(readMiniappFile('app.json'));
  assert.ok(appConfig.pages.includes('pages/favorites/favorites'), 'favorites should be a registered page');

  const detailSource = readMiniappFile(path.join('pages', 'detail', 'detail.js'));
  assert.ok(detailSource.includes('/favorite'), 'detail should load and update favorite state');
  assert.ok(detailSource.includes('toggleFavorite'), 'detail should support favorite toggling');
  const detailMarkup = readMiniappFile(path.join('pages', 'detail', 'detail.wxml'));
  assert.ok(detailMarkup.includes('toggleFavorite'), 'detail should provide a favorite action');

  const favoritesSource = readMiniappFile(path.join('pages', 'favorites', 'favorites.js'));
  assert.ok(favoritesSource.includes('/api/my/favorites'), 'favorites page should load server favorites');
  assert.ok(favoritesSource.includes('goDetail'), 'favorites page should navigate to product detail');
  const favoritesMarkup = readMiniappFile(path.join('pages', 'favorites', 'favorites.wxml'));
  assert.ok(favoritesMarkup.includes('goDetail'), 'favorites page should expose product navigation');
  assert.ok(favoritesMarkup.includes('promo-badge'), 'favorites should surface active promotions');
  assert.ok(favoritesMarkup.includes('original-price'), 'favorites should compare original and sale prices');

  const profileSource = readMiniappFile(path.join('pages', 'profile', 'profile.js'));
  assert.ok(profileSource.includes('/pages/favorites/favorites'), 'profile should link to favorites');
  assert.ok(profileSource.includes('openNotification'), 'profile should support notification navigation');
  const profileMarkup = readMiniappFile(path.join('pages', 'profile', 'profile.wxml'));
  assert.ok(profileMarkup.includes('goFavorites'), 'profile should expose a favorites entry');
  assert.ok(profileMarkup.includes('openNotification'), 'profile should expose tappable notifications');
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

test('merchant and admin demand panels expose favorite interest', () => {
  const merchantJs = readMiniappFile(path.join('pages', 'merchant', 'products.js'));
  const merchantWxml = readMiniappFile(path.join('pages', 'merchant', 'products.wxml'));
  const merchantIndexWxml = readMiniappFile(path.join('pages', 'merchant', 'index.wxml'));
  const adminJs = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'admin.js'), 'utf8');

  assert.ok(merchantJs.includes('favoriteCount'), 'merchant products should read favorite demand');
  assert.ok(merchantJs.includes('favoriteDemandText'), 'merchant products should show favorite demand');
  assert.ok(merchantWxml.includes('favoriteDemandText'), 'merchant products should surface favorite demand');
  assert.ok(merchantIndexWxml.includes('favoriteDemandText'), 'merchant home should show low-stock favorite demand');
  assert.ok(adminJs.includes('favoriteDemandProducts'), 'admin dashboard should render favorite demand');
  assert.ok(adminJs.includes('favoriteDemandText'), 'admin dashboard should show favorite demand text');
});

test('merchant products support self-service sale campaigns', () => {
  const js = readMiniappFile(path.join('pages', 'merchant', 'products.js'));
  const wxml = readMiniappFile(path.join('pages', 'merchant', 'products.wxml'));

  assert.ok(js.includes('salePriceInCents'), 'merchant products should submit sale prices');
  assert.ok(js.includes('saleStartsAt'), 'merchant products should submit sale start time');
  assert.ok(js.includes('effectivePriceInCents'), 'merchant products should preserve server effective pricing');
  for (const marker of ['item.priceText', 'item.originalPriceText', 'item.promotionText', 'form.salePrice']) {
  assert.ok(wxml.includes(marker), `${marker} should be available in merchant sale UI`);
  }
});

test('promotion operations expose campaign metrics', () => {
  const merchantJs = readMiniappFile(path.join('pages', 'merchant', 'index.js'));
  const merchantWxml = readMiniappFile(path.join('pages', 'merchant', 'index.wxml'));
  const adminJs = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'admin.js'), 'utf8');

  assert.ok(merchantJs.includes('promotionSummary'), 'merchant workspace should load promotion metrics');
  for (const marker of ['promotionSummary.length', 'item.campaignStatusLabel', 'item.campaignAmountText', 'item.campaignDiscountText']) {
    assert.ok(merchantWxml.includes(marker), `${marker} should be visible in merchant promotion panel`);
  }
  assert.ok(adminJs.includes('campaignStatusLabel'), 'admin products should show campaign status');
  assert.ok(adminJs.includes('campaignPaidOrderCount'), 'admin products should show paid campaign orders');
  assert.ok(adminJs.includes('campaignAmountInCents'), 'admin products should show campaign revenue');
});

test('limited recharge promos run as an availability-controlled campaign', () => {
  const cardJs = readMiniappFile(path.join('pages', 'card', 'card.js'));
  const cardWxml = readMiniappFile(path.join('pages', 'card', 'card.wxml'));
  const adminJs = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'admin.js'), 'utf8');
  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'admin.html'), 'utf8');

  assert.ok(cardJs.includes('promoStatus'), 'card page should preserve campaign status from the server');
  assert.ok(cardJs.includes('isBuyable'), 'card page should prevent unavailable promo submission');
  assert.ok(cardJs.includes('effectivePriceInCents'), 'card page should use server phone-plan pricing');
  assert.ok(cardWxml.includes('plan-original'), 'card page should show crossed-out phone-plan prices');
  assert.ok(cardWxml.includes('plan-promo'), 'card page should surface phone-plan promotions');
  for (const marker of ['item.statusLabel', 'item.availabilityText', 'item.isBuyable']) {
    assert.ok(cardWxml.includes(marker), `${marker} should be shown in the recharge campaign UI`);
  }

  assert.ok(adminJs.includes('p.linkedOrderCount'), 'admin promos should show campaign order metrics');
  assert.ok(adminJs.includes('startsAt'), 'admin promo save should send campaign start time');
  assert.ok(adminJs.includes('endsAt'), 'admin promo save should send campaign end time');
  assert.ok(adminHtml.includes('promoStartsAt'), 'admin promo form should configure start time');
  assert.ok(adminHtml.includes('promoEndsAt'), 'admin promo form should configure end time');
});

test('product sale campaigns show server-controlled promo pricing', () => {
  const homeJs = readMiniappFile(path.join('pages', 'home', 'home.js'));
  const homeWxml = readMiniappFile(path.join('pages', 'home', 'home.wxml'));
  const scooterJs = readMiniappFile(path.join('pages', 'scooters', 'scooters.js'));
  const scooterWxml = readMiniappFile(path.join('pages', 'scooters', 'scooters.wxml'));
  const detailJs = readMiniappFile(path.join('pages', 'detail', 'detail.js'));
  const detailWxml = readMiniappFile(path.join('pages', 'detail', 'detail.wxml'));
  const checkoutJs = readMiniappFile(path.join('pages', 'checkout', 'checkout.js'));
  const checkoutWxml = readMiniappFile(path.join('pages', 'checkout', 'checkout.wxml'));
  const adminJs = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'admin.js'), 'utf8');
  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'admin.html'), 'utf8');

  assert.ok(detailJs.includes('effectivePriceInCents'), 'detail should use server effective pricing');
  assert.ok(detailJs.includes('promotionPrice'), 'detail should format promotion pricing');
  for (const marker of ['scooter.promotionPrice', 'scooter.originalPrice', 'scooter.promotionStatusText']) {
    assert.ok(detailWxml.includes(marker), `${marker} should be visible on product detail`);
  }
  assert.ok(checkoutJs.includes('effectivePriceInCents'), 'checkout should preserve server effective pricing');
  assert.ok(checkoutWxml.includes('originalPrice'), 'checkout should show the crossed-out original price');
  assert.ok(homeJs.includes('effectivePriceInCents'), 'home should use server effective pricing');
  assert.ok(homeWxml.includes('originalPrice'), 'home should show crossed-out original prices');
  assert.ok(scooterJs.includes('effectivePriceInCents'), 'scooter list should use server effective pricing');
  assert.ok(scooterWxml.includes('promo-badge'), 'scooter list should surface promotions');
  assert.ok(scooterWxml.includes('original-price'), 'scooter list should compare original and sale prices');
  assert.ok(checkoutWxml.includes('paymentTimeoutText'), 'checkout should show the configured payment timeout');
  assert.ok(checkoutJs.includes('stockNote'), 'checkout should explain unavailable stock');
  assert.ok(checkoutWxml.includes('stockNote'), 'checkout should show the unavailable stock note');

  assert.ok(adminJs.includes('salePriceInCents'), 'admin should configure sale prices');
  assert.ok(adminJs.includes('saleStartsAt'), 'admin should configure sale start time');
  assert.ok(adminHtml.includes('productSalePrice'), 'admin product form should include sale price');
  assert.ok(adminHtml.includes('productSaleStartsAt'), 'admin product form should include sale start time');
});

test('merchant workspace surfaces rectification review deadlines', () => {
  const js = readMiniappFile(path.join('pages', 'merchant', 'index.js'));
  const wxml = readMiniappFile(path.join('pages', 'merchant', 'index.wxml'));

  assert.ok(js.includes('rectifyCountdown'), 'merchant page should decorate rectification deadlines');
  assert.ok(js.includes('complianceCase?.dueAt'), 'delisted products should use the case due time');
  assert.ok(wxml.includes('复核时限'), 'score cases should show the review deadline');
  assert.ok(wxml.includes('item.countdownText'), 'delisted products should show remaining time');
});

test('merchant workspace visualizes service score trend', () => {
  const js = readMiniappFile(path.join('pages', 'merchant', 'index.js'));
  const wxml = readMiniappFile(path.join('pages', 'merchant', 'index.wxml'));
  const wxss = readMiniappFile(path.join('pages', 'merchant', 'index.wxss'));

  assert.ok(js.includes('decorateScoreTrend'), 'merchant page should decorate score trend');
  assert.ok(js.includes('scoreTrend: decorateScoreTrend(data.scoreTrend)'), 'overview should map server trend');
  assert.ok(js.includes('整改后'), 'trend decoration should state the score gain after rectification');
  assert.ok(wxml.includes('14 天服务分趋势'), 'workspace should show the trend title');
  assert.ok(wxml.includes('trend-chart'), 'workspace should render trend bars');
  assert.ok(wxml.includes('trend-effect'), 'workspace should connect the trend with rectification outcome');
  assert.ok(js.includes('及时处理可回升'), 'trend decoration should expose recoverable score risk');
  assert.ok(wxml.includes('trend-risk'), 'workspace should warn about current service score risk');
  assert.ok(js.includes('riskTasks'), 'workspace should load the prioritized risk task list');
  assert.ok(js.includes('goRiskTask'), 'risk tasks should route merchants to the matching workspace');
  assert.ok(wxml.includes('风险处理清单'), 'workspace should show the risk task title');
  assert.ok(wxml.includes('risk-task-block'), 'workspace should render the risk task list');
  assert.ok(wxss.includes('.trend-chart'), 'trend bars should have visible styling');
  assert.ok(wxss.includes('.risk-task-block'), 'risk task list should have visible styling');
});

test('product detail surfaces merchant rectification status prominently', () => {
  const js = readMiniappFile(path.join('pages', 'detail', 'detail.js'));
  const wxml = readMiniappFile(path.join('pages', 'detail', 'detail.wxml'));
  const wxss = readMiniappFile(path.join('pages', 'detail', 'detail.wxss'));

  assert.ok(js.includes('merchantRectify'), 'detail should decorate merchant rectification status');
  assert.ok(js.includes('店铺整改中'), 'rectification banner should use plain business wording');
  assert.ok(wxml.includes('rectify-badge'), 'seller line should show a rectification badge');
  assert.ok(wxml.includes('rectify-banner'), 'detail should show a unified rectification banner');
  assert.ok(wxss.includes('.rectify-banner'), 'rectification banner should have visible styling');
});
