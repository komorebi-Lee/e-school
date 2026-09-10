const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const miniappDirectory = path.join(__dirname, '..', 'miniprogram');
const serverDirectory = path.join(__dirname, '..', 'server');

function readMiniappFile(relativePath) {
  return fs.readFileSync(path.join(miniappDirectory, relativePath), 'utf8');
}

function listMiniappFiles() {
  return fs.readdirSync(miniappDirectory, { recursive: true })
    .filter((item) => String(item).endsWith('.js'))
    .map((item) => path.join(miniappDirectory, String(item)));
}

function readServerFile(relativePath) {
  return fs.readFileSync(path.join(serverDirectory, relativePath), 'utf8');
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

test('checkout supports bounded e-bike purchase quantity', () => {
  const source = readMiniappFile(path.join('pages', 'checkout', 'checkout.js'));
  const markup = readMiniappFile(path.join('pages', 'checkout', 'checkout.wxml'));
  const styles = readMiniappFile(path.join('pages', 'checkout', 'checkout.wxss'));

  assert.ok(source.includes('quantity: 1, maxQuantity: 1'), 'checkout should initialize quantity state');
  assert.ok(source.includes('Math.max(1, Math.min(sellableStock, 5))'), 'quantity cap should follow sellable stock');
  assert.ok(source.includes('setQuantity'), 'checkout should expose quantity controls');
  assert.ok(source.includes('Math.max(1, Math.min(Number(this.data.quantity || 1), this.data.maxQuantity || 1))'), 'totals should guard against stale quantity state');
  assert.ok(source.includes('quantity > Number(scooter.sellableStock || 0)'), 'submit should guard against stock changes');
  assert.ok(source.includes('items: [{ productId: scooter.id, quantity }]'), 'order payload should submit selected quantity');
  assert.ok(markup.includes('每辆车同步免费校园牌照辅助'), 'multi-bike checkout should set plate assistance expectations');
  assert.ok(markup.includes('data-action="increase"') && markup.includes('data-action="decrease"'), 'quantity UI should support both actions');
  assert.ok(markup.includes('bindtap="setQuantity"'), 'quantity controls should be interactive');
  assert.ok(styles.includes('.quantity-row') && styles.includes('.quantity-control'), 'quantity controls should be styled');
});

test('multi-quantity aftersales supports partial refund selection', () => {
  const source = readMiniappFile(path.join('pages', 'aftersales', 'aftersales.js'));
  const markup = readMiniappFile(path.join('pages', 'aftersales', 'aftersales.wxml'));
  const styles = readMiniappFile(path.join('pages', 'aftersales', 'aftersales.wxss'));

  assert.ok(source.includes('quantity: 1, maxQuantity: 1'), 'aftersales should initialize refund quantity');
  assert.ok(source.includes('quantity: this.data.quantity'), 'aftersales should submit refund quantity');
  assert.ok(source.includes('refundedQuantity'), 'aftersales should exclude already refunded bikes');
  assert.ok(markup.includes('maxQuantity > 1'), 'quantity selector should appear only for multi-bike orders');
  assert.ok(markup.includes('bindtap="setQuantity"'), 'quantity selector should be interactive');
  assert.ok(styles.includes('.quantity-row') && styles.includes('.quantity-control'), 'quantity controls should be styled');
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

test('merchant orders surface unreplied user messages', () => {
  const source = readMiniappFile(path.join('pages', 'merchant', 'orders.js'));
  const markup = readMiniappFile(path.join('pages', 'merchant', 'orders.wxml'));
  const styles = readMiniappFile(path.join('pages', 'merchant', 'orders.wxss'));

  assert.ok(source.includes('hasUnrepliedMessage: !!order.collaboration?.unrepliedMessage'), 'merchant orders should derive the unreplied state');
  assert.ok(markup.includes('hasUnrepliedMessage'), 'merchant order card should conditionally show the message warning');
  assert.ok(markup.includes('用户有待回复留言'), 'merchant order warning should use plain operational wording');
  assert.ok(styles.includes('.unreplied-message'), 'unreplied message warning should be styled');
});

test('admin dashboard links fulfillment queues to order operations', () => {
  const admin = readServerFile(path.join('public', 'admin.js'));

  assert.ok(admin.includes('operationsInsights?.orderQueues'), 'dashboard should consume server fulfillment queues');
  assert.ok(admin.includes('履约联动'), 'dashboard should show the fulfillment linkage panel');
  assert.ok(admin.includes('function orderCollabDetail'), 'order drawer should render fulfillment collaboration details');
  assert.ok(admin.includes('view==="orders"?orderCollabDetail(item):""'), 'order detail should activate collaboration detail only for orders');
});

test('service collaboration tracks response state in operations surfaces', () => {
  const serverSource = readServerFile(path.join('src', 'app.js'));
  const admin = readServerFile(path.join('public', 'admin.js'));

  assert.ok(serverSource.includes('unrepliedMessage = { action, text: note, createdAt: time }'), 'service records should persist the latest unreplied user message');
  assert.ok(serverSource.includes("ruleKey: 'SERVICE_USER_MESSAGE'"), 'operations patrol should include service message response SLA');
  assert.ok(serverSource.includes("addNotification(data, 'PLATFORM', 'SERVICE_MESSAGE'"), 'user service messages should create platform notifications');
  assert.ok(admin.includes('pendingMessage=!!collab.unrepliedMessage'), 'service collaboration rows should use persisted response state');
  assert.ok(admin.includes('有待回复留言'), 'service collaboration detail should show response state');
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

test('plate page uses server order history correctly', () => {
  const source = readMiniappFile(path.join('pages', 'plate', 'plate.js'));

  assert.ok(source.includes('data?.ebikeOrders'), 'plate page should read the paginated order history envelope');
  assert.ok(source.includes("data?.serviceRecords"), 'plate page should read service records from the response envelope');
  assert.ok(source.includes('PENDING_PAYMENT'), 'plate page should not offer unpaid orders for free plate assistance');
  assert.ok(source.includes('Number(item.quantity)>1'), 'plate page should expose ordered bike quantity');
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
  const css = readMiniappFile(path.join('pages', 'orders', 'orders.wxss'));

  assert.ok(js.includes('afterSaleJourney'), 'orders page should build an after-sale journey');
  assert.ok(js.includes('afterSales'), 'orders page should read after-sale records from server data');
  assert.ok(js.includes('afterSale: activeAfterSale'), 'orders page should show the active or latest after-sale record');
  assert.ok(js.includes('售后详情'), 'orders page should guide users to view an active after-sale case');
  assert.ok(wxml.includes('after-sale-panel'), 'orders page should show an after-sale panel');
  assert.ok(wxml.includes('处理结果'), 'orders page should show the merchant resolution note');
  assert.ok(wxml.includes('item.afterSale.resolutionNote'), 'orders page should bind the merchant resolution note');
  assert.ok(js.includes('平台已加入催办'), 'orders should explain overdue after-sale escalation');
  assert.ok(js.includes('售后已超时，平台正在催办'), 'overdue after-sale should create a top linkage');
  assert.ok(wxml.includes('after-sale-overdue'), 'orders should render overdue escalation state');
  assert.ok(css.includes('.after-sale-overdue'), 'overdue escalation should have visible styling');
});

test('orders page surfaces partial refund scope to users', () => {
  const js = readMiniappFile(path.join('pages', 'orders', 'orders.js'));
  const wxml = readMiniappFile(path.join('pages', 'orders', 'orders.wxml'));
  const styles = readMiniappFile(path.join('pages', 'orders', 'orders.wxss'));

  assert.ok(js.includes("item.paymentStatus === 'PARTIALLY_REFUNDED'"), 'orders should detect partial refund payment state');
  assert.ok(js.includes('remainingQuantity'), 'orders should calculate the remaining fulfillment quantity');
  assert.ok(js.includes("isPartiallyRefunded ? '部分退款'"), 'orders should show a clear partial refund status');
  assert.ok(wxml.includes('partial-refund'), 'orders should render the partial refund notice');
  assert.ok(styles.includes('.partial-refund'), 'partial refund notice should be styled');
});

test('merchant orders surface partial refund fulfillment scope', () => {
  const js = readMiniappFile(path.join('pages', 'merchant', 'orders.js'));
  const wxml = readMiniappFile(path.join('pages', 'merchant', 'orders.wxml'));

  assert.ok(js.includes('PARTIALLY_REFUNDED'), 'merchant orders should recognize partial refund status');
  assert.ok(js.includes('remainingQuantity'), 'merchant orders should calculate remaining fulfillment quantity');
  assert.ok(js.includes('partialRefundNotice'), 'merchant orders should expose the partial refund notice');
  assert.ok(wxml.includes('partial-refund'), 'merchant orders should show the partial refund notice');
  assert.ok(wxml.includes('剩余 {{item.remainingQuantity}} 件继续履约'), 'merchant orders should show the remaining quantity');
});

test('after-sale rejection keeps users and merchants connected', () => {
  const merchantJs = readMiniappFile(path.join('pages', 'merchant', 'orders.js'));
  const merchantWxml = readMiniappFile(path.join('pages', 'merchant', 'orders.wxml'));
  const ordersJs = readMiniappFile(path.join('pages', 'orders', 'orders.js'));
  const afterSaleJs = readMiniappFile(path.join('pages', 'aftersales', 'aftersales.js'));

  assert.ok(merchantJs.includes('REJECTED'), 'merchant after-sale labels should include rejection');
  assert.ok(merchantJs.includes('拒绝售后申请'), 'merchant should supply a rejection reason');
  assert.ok(merchantWxml.includes('拒绝申请'), 'merchant orders should expose the reject action');
  assert.ok(ordersJs.includes('REJECTED'), 'user order timeline should explain rejection');
  assert.ok(afterSaleJs.includes('REJECTED'), 'after-sale detail should show rejection status');
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
  assert.ok(!detailWxml.includes('¥{{scooter.price}}'), 'detail bottom bar must not fall back to original price');
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

test('merchant workspace surfaces latest platform risk urging', () => {
  const js = readMiniappFile(path.join('pages', 'merchant', 'index.js'));
  const wxml = readMiniappFile(path.join('pages', 'merchant', 'index.wxml'));
  const wxss = readMiniappFile(path.join('pages', 'merchant', 'index.wxss'));

  assert.ok(js.includes('latestRiskUrge: data.latestRiskUrge ?'), 'workspace should read the latest urge');
  assert.ok(wxml.includes('risk-urge-banner'), 'platform urging should be visible');
  assert.ok(wxml.includes('平台已催办'), 'platform urging should use plain wording');
  assert.ok(wxss.includes('.risk-urge-banner'), 'platform urging should have warning styling');
  assert.ok(js.includes('applyNotificationFocus'), 'workspace should focus the score card from notification links');
  assert.ok(wxml.includes('merchant-score-card'), 'score card should expose the focus anchor');
});

test('merchant notifications deep-link into workspace focus areas', () => {
  const js = readMiniappFile(path.join('pages', 'merchant', 'index.js'));
  const wxml = readMiniappFile(path.join('pages', 'merchant', 'index.wxml'));

  assert.ok(js.includes('merchant-delist-'), 'delist notifications should focus the rectification card');
  assert.ok(js.includes('merchant-score-case-'), 'case notifications should focus the score case card');
  assert.ok(wxml.includes('merchant-qualification-card'), 'qualification notifications should have an anchor');
  assert.ok(wxml.includes('merchant-payout-card'), 'payout notifications should have an anchor');
  assert.ok(js.includes("focusValue === 'merchant-payout'"), 'payout notifications should focus the settlement card');
});

test('core commerce pages support sharing', () => {
  const homeJs = readMiniappFile(path.join('pages', 'home', 'home.js'));
  const detailJs = readMiniappFile(path.join('pages', 'detail', 'detail.js'));
  const storeJs = readMiniappFile(path.join('pages', 'store', 'store.js'));

  assert.ok(homeJs.includes('onShareAppMessage'), 'home should support sharing');
  assert.ok(homeJs.includes('onShareTimeline'), 'home should support timeline sharing');
  assert.ok(detailJs.includes('onShareAppMessage'), 'product detail should support sharing');
  assert.ok(detailJs.includes('/pages/detail/detail?id='), 'product shares should deep-link to the product');
  assert.ok(storeJs.includes('onShareAppMessage'), 'store should support sharing');
  assert.ok(storeJs.includes('/pages/store/store?id='), 'store shares should deep-link to the store');
});

test('home phone plans deep-link into the card page selection', () => {
  const homeJs = readMiniappFile(path.join('pages', 'home', 'home.js'));
  const homeWxml = readMiniappFile(path.join('pages', 'home', 'home.wxml'));
  const cardJs = readMiniappFile(path.join('pages', 'card', 'card.js'));

  assert.ok(homeWxml.includes('data-id="{{item.id}}"'), 'home plan cards should carry the plan id');
  assert.ok(homeJs.includes('planId='), 'home should pass the plan id to the card page');
  assert.ok(cardJs.includes('pendingPlanId'), 'card page should focus the requested plan');
});

test('favorites support removing a single item', () => {
  const js = readMiniappFile(path.join('pages', 'favorites', 'favorites.js'));
  const wxml = readMiniappFile(path.join('pages', 'favorites', 'favorites.wxml'));

  assert.ok(js.includes('cancelFavorite'), 'favorites should expose a remove action');
  assert.ok(js.includes('favorited: false'), 'removal should call the favorite toggle API');
  assert.ok(wxml.includes('cancelFavorite'), 'favorite cards should render the remove entry');
});

test('product detail exposes a consult entry', () => {
  const js = readMiniappFile(path.join('pages', 'detail', 'detail.js'));
  const wxml = readMiniappFile(path.join('pages', 'detail', 'detail.wxml'));

  assert.ok(js.includes('consult()'), 'detail should route to the consult page');
  assert.ok(js.includes('购买咨询'), 'consult entry should carry the product interest');
  assert.ok(wxml.includes('consult-button'), 'detail bottom bar should expose the consult entry');
});

test('merchant reviews surface negative review reply deadlines', () => {
  const js = readMiniappFile(path.join('pages', 'merchant', 'reviews.js'));
  const wxml = readMiniappFile(path.join('pages', 'merchant', 'reviews.wxml'));
  const css = readMiniappFile(path.join('pages', 'merchant', 'reviews.wxss'));

  assert.ok(js.includes('replyDueAt'), 'reviews should read persisted reply deadlines');
  assert.ok(js.includes('decorateReview'), 'reviews should decorate due state');
  assert.ok(js.includes('lastUrge'), 'reviews should read platform urge records');
  assert.ok(js.includes('urgeText'), 'urge records should be decorated for merchants');
  assert.ok(wxml.includes('urge-note'), 'platform urge state should be visible');
  assert.ok(css.includes('.urge-note'), 'platform urge note should have warning styling');
  assert.ok(wxml.includes('reply-due'), 'reply deadline should be visible');
  assert.ok(css.includes('.reply-due.overdue'), 'overdue deadline should have warning styling');
});

test('merchant surfaces explain service risk auto delisting', () => {
  const workspaceJs = readMiniappFile(path.join('pages', 'merchant', 'index.js'));
  const productsJs = readMiniappFile(path.join('pages', 'merchant', 'products.js'));

  assert.ok(workspaceJs.includes('SERVICE_RISK'), 'workspace should include service-risk delisted products');
  assert.ok(workspaceJs.includes('售后超时'), 'workspace should tell merchants why service risk happened');
  assert.ok(productsJs.includes('SERVICE_RISK'), 'product list should show service-risk products');
  assert.ok(productsJs.includes('触发平台风控规则'), 'product list should use plain risk wording');
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
  assert.ok(wxss.includes('.focus-item'), 'focused risk cards should have visible highlight');
});

test('risk tasks deep-link into focused workspace entries', () => {
  const workspaceJs = readMiniappFile(path.join('pages', 'merchant', 'index.js'));
  const workspaceWxml = readMiniappFile(path.join('pages', 'merchant', 'index.wxml'));
  const orderJs = readMiniappFile(path.join('pages', 'merchant', 'orders.js'));
  const reviewJs = readMiniappFile(path.join('pages', 'merchant', 'reviews.js'));
  const productJs = readMiniappFile(path.join('pages', 'merchant', 'products.js'));

  assert.ok(workspaceJs.includes('focusId='), 'risk tasks should pass the target id');
  assert.ok(workspaceJs.includes("type === 'NEGATIVE_REVIEW'"), 'negative review risk tasks should route to merchant reviews');
  assert.ok(workspaceJs.includes("type === 'AUTO_DELIST'"), 'delisted products should route back to rectification');
  assert.ok(workspaceJs.includes('merchant-delist-'), 'delisted rectification cards should support anchored focus');
  assert.ok(workspaceJs.includes('merchant-score-case-'), 'service score cases should support anchored focus');
  assert.ok(workspaceWxml.includes('data-id="{{item.reference}}"'), 'risk tasks should carry the exact business reference');
  assert.ok(workspaceWxml.includes('merchant-delist-{{item.id}}'), 'delisted cards should expose anchors');
  assert.ok(workspaceWxml.includes('merchant-score-case-{{item.id}}'), 'score case cards should expose anchors');
  assert.ok(workspaceWxml.includes('risk-task-urge'), 'risk tasks should surface platform urge state');
  assert.ok(orderJs.includes('focusLoadedItem'), 'orders should support focused entry routing');
  assert.ok(reviewJs.includes('focusLoadedItem'), 'reviews should support focused entry routing');
  assert.ok(productJs.includes('focusLoadedItem'), 'products should support focused entry routing');
});

test('message center keeps history filters and actionable notification links', () => {
  const appJson = JSON.parse(fs.readFileSync(path.join(miniappDirectory, 'app.json'), 'utf8'));
  const pageJs = readMiniappFile(path.join('pages', 'notifications', 'notifications.js'));
  const pageWxml = readMiniappFile(path.join('pages', 'notifications', 'notifications.wxml'));
  const profileJs = readMiniappFile(path.join('pages', 'profile', 'profile.js'));
  const profileWxml = readMiniappFile(path.join('pages', 'profile', 'profile.wxml'));

  assert.ok(appJson.pages.includes('pages/notifications/notifications'), 'message center should be registered');
  assert.ok(pageJs.includes('/api/my/notifications'), 'message center should load the full history');
  assert.ok(pageJs.includes('/api/my/notifications/${encodeURIComponent(id)}/read'), 'one notice should mark only itself read');
  assert.ok(pageJs.includes('UNREAD'), 'message center should support unread filtering');
  assert.ok(pageWxml.includes('item.link'), 'notifications should retain business deep links');
  assert.ok(pageJs.includes('PHONE_PLAN: "电话卡"'), 'message center should label phone card notices');
  assert.ok(pageJs.includes('RECHARGE: "话费权益"'), 'message center should label recharge notices');
  assert.ok(profileJs.includes('goNotifications'), 'profile should route to the message center');
  assert.ok(profileWxml.includes('消息中心'), 'profile should expose the message center entry');
});

test('storefront supports commerce filters and image evidence preview', () => {
  const storeJs = readMiniappFile(path.join('pages', 'store', 'store.js'));
  const storeWxml = readMiniappFile(path.join('pages', 'store', 'store.wxml'));
  const detailJs = readMiniappFile(path.join('pages', 'detail', 'detail.js'));
  const detailWxml = readMiniappFile(path.join('pages', 'detail', 'detail.wxml'));

  assert.ok(storeJs.includes('applyFilters'), 'storefront should expose a reusable filter pipeline');
  assert.ok(storeJs.includes('previewReviewImages'), 'store reviews should support image preview');
  assert.ok(storeWxml.includes('catalog-search'), 'storefront should provide product search');
  assert.ok(storeWxml.includes('catalog-tab'), 'storefront should provide category filters');
  assert.ok(storeWxml.includes('filteredProducts'), 'storefront should render filtered results');
  assert.ok(detailJs.includes('previewProductImage'), 'product image should support preview');
  assert.ok(detailJs.includes('previewReviewImages'), 'review evidence should support preview');
  assert.ok(detailWxml.includes('data-urls="{{item.images}}"'), 'review evidence should pass an image set');
});

test('merchant notifications carry actionable business links', () => {
  const js = readMiniappFile(path.join('pages', 'merchant', 'index.js'));
  const wxml = readMiniappFile(path.join('pages', 'merchant', 'index.wxml'));
  const wxss = readMiniappFile(path.join('pages', 'merchant', 'index.wxss'));

  assert.ok(js.includes('openNotification'), 'notifications should expose a tap handler');
  assert.ok(wxml.includes('data-link="{{item.link}}"'), 'notifications should carry server-generated links');
  assert.ok(wxml.includes('查看详情'), 'actionable notifications should show a detail affordance');
  assert.ok(wxss.includes('.notice-action'), 'actionable notifications should have visible styling');
});

test('subscribe messages and user orders deep-link to focused records', () => {
  const orderJs = readMiniappFile(path.join('pages', 'orders', 'orders.js'));
  const orderWxml = readMiniappFile(path.join('pages', 'orders', 'orders.wxml'));
  const orderCss = readMiniappFile(path.join('pages', 'orders', 'orders.wxss'));

  assert.ok(orderJs.includes('focusLoadedRecord'), 'user orders should support focused record routing');
  assert.ok(orderWxml.includes('user-record-{{item.id}}'), 'focused order should be scroll-targetable');
  assert.ok(orderWxml.includes("item.id === focusId ? 'focus-item' : ''"), 'focused order should highlight');
  assert.ok(orderCss.includes('.focus-item'), 'focused order should have visible styling');
});

test('profile order reminders respect the WeChat authorization result', () => {
  const profileJs = readMiniappFile(path.join('pages', 'profile', 'profile.js'));
  const profileWxml = readMiniappFile(path.join('pages', 'profile', 'profile.wxml'));

  assert.ok(profileJs.includes('request("/api/subscribe-templates")'), 'reminder toggle should load configured templates');
  assert.ok(profileJs.includes('wx.requestSubscribeMessage'), 'reminder toggle should request WeChat authorization');
  assert.ok(profileJs.includes('acceptedTemplates.length'), 'only accepted templates should activate the server subscription');
  assert.ok(profileJs.includes('没有获得微信提醒授权'), 'rejected authorization should keep the reminder off');
  assert.ok(profileWxml.includes('toggleOrderMessages'), 'profile should expose the reminder toggle');
});

test('scooter list shows service score and commerce signals', () => {
  const js = readMiniappFile(path.join('pages', 'scooters', 'scooters.js'));
  const wxml = readMiniappFile(path.join('pages', 'scooters', 'scooters.wxml'));
  const wxss = readMiniappFile(path.join('pages', 'scooters', 'scooters.wxss'));

  assert.ok(js.includes('item.merchantScore?.score'), 'product cards should expose the merchant service score');
  assert.ok(js.includes("item.merchantScore?.stage === 'LIMITED'"), 'product cards should use the platform service stage');
  assert.ok(wxss.includes('.service-score.score-risk'), 'restricted merchants should get a visible risk tone');
  assert.ok(js.includes('salesText'), 'product cards should expose verified sales volume');
  assert.ok(js.includes('promoText'), 'active campaigns should be visible in the list');
  assert.ok(js.includes('recommendWeight'), 'recommend sorting should combine sales and rating');
  assert.ok(js.includes("key: 'sales'"), 'product list should offer sales sorting');
  assert.ok(js.includes('sales: (a, b) => b.salesCount - a.salesCount'), 'sales sorting should use verified sales count');
  assert.ok(wxml.includes('service-score'), 'service score should have a visible label');
  assert.ok(wxml.includes('item.promoText'), 'active campaigns should render in the list');
  assert.ok(wxml.includes('item.salesText'), 'sales evidence should render in the list');
  assert.ok(wxss.includes('.signal-row'), 'commerce signals should be visually grouped');
});

test('user orders surface consultation response progress', () => {
  const orderJs = readMiniappFile(path.join('pages', 'orders', 'orders.js'));
  const orderWxml = readMiniappFile(path.join('pages', 'orders', 'orders.wxml'));
  const orderCss = readMiniappFile(path.join('pages', 'orders', 'orders.wxss'));

  assert.ok(orderJs.includes("item.collaboration?.unrepliedMessage"), 'user orders should read the persisted unreplied state');
  assert.ok(orderJs.includes('订单已支付，等待商家确认履约。'), 'platform payment acknowledgement should not count as consultation reply');
  assert.ok(orderJs.includes('已提交留言，预计 ${DEFAULT_RESPONSE_HOURS} 小时内回复'), 'pending consultation should show a response expectation');
  assert.ok(orderJs.includes('客服已回复'), 'answered consultation should show a completed state');
  assert.ok(orderWxml.includes('item.messageStatus'), 'order cards should render the response progress');
  assert.ok(orderCss.includes('.message-status'), 'response progress should have visible styling');
});

test('user notices and service linkage land on focused records', () => {
  const profileJs = readMiniappFile(path.join('pages', 'profile', 'profile.js'));
  const orderJs = readMiniappFile(path.join('pages', 'orders', 'orders.js'));
  const orderWxml = readMiniappFile(path.join('pages', 'orders', 'orders.wxml'));

  assert.ok(profileJs.includes('link: item.link'), 'profile notices should use server business links');
  assert.ok(!profileJs.includes('metadata.productId ? `/pages/detail/detail'), 'profile notices should not hand-roll partial links');
  assert.ok(orderJs.includes('focusId:paidRecharge.id'), 'recharge linkage should preserve the target record');
  assert.ok(orderJs.includes('focusId:plate.id'), 'plate linkage should preserve the target record');
  assert.ok(orderJs.includes('this.focusId=focusId'), 'linkage actions should highlight the focused record');
  assert.ok(orderWxml.includes('data-focus-id="{{item.focusId}}"'), 'linkage cards should carry the focus id');
  assert.ok(orderJs.includes('timeline:(item.collaboration?.handoffs || [])'), 'order timeline should surface service collaboration updates');
});

test('appointment form keeps the originating service record', () => {
  const consultJs = readMiniappFile(path.join('pages', 'consult', 'consult.js'));
  const consultWxml = readMiniappFile(path.join('pages', 'consult', 'consult.wxml'));
  const ordersJs = readMiniappFile(path.join('pages', 'orders', 'orders.js'));
  const rechargeJs = readMiniappFile(path.join('pages', 'recharge', 'detail.js'));

  assert.ok(consultJs.includes('sourceType: this.data.sourceType'), 'appointments should submit their source type');
  assert.ok(consultJs.includes('sourceId: this.data.sourceId'), 'appointments should submit their source record');
  assert.ok(consultWxml.includes('wx:if="{{sourceNo || sourceId}}"'), 'appointments should show the linked record');
  assert.ok(ordersJs.includes('sourceType=${encodeURIComponent(consult.type)}'), 'order fallbacks should carry record type');
  assert.ok(ordersJs.includes('sourceId=${encodeURIComponent(consult.id)}'), 'order fallbacks should carry the record id');
  assert.ok(rechargeJs.includes("sourceType=${encodeURIComponent('RECHARGE')}"), 'recharge consults should carry source type');
  assert.ok(rechargeJs.includes('sourceId=${encodeURIComponent(orderId)}'), 'recharge consults should carry the order id');
});

test('admin lead follow-ups keep accountable operators', () => {
  const app = readServerFile(path.join('src', 'app.js'));
  const admin = readServerFile(path.join('public', 'admin.js'));

  assert.ok(app.includes("const actor = requireAdmin(request, 'ORDER_MANAGE')"), 'lead follow-ups should require an admin session');
  assert.ok(app.includes('if (!item.assignee) item.assignee = operator'), 'first follow-up should claim the lead');
  assert.ok(admin.includes("esc(x.assignee || '待认领')"), 'lead table should show the accountable owner');
  assert.ok(admin.includes("esc(lead.assignee || '待认领')"), 'lead drawer should show the accountable owner');
});

test('overdue leads keep owner accountability', () => {
  const app = readServerFile(path.join('src', 'app.js'));
  const admin = readServerFile(path.join('public', 'admin.js'));

  assert.ok(app.includes('ownerId: record.assigneeId ||'), 'lead patrol targets should carry the assigned operator');
  assert.ok(app.includes("addNotification(data, owner.id, 'SLA'"), 'assigned operators should receive SLA notices');
  assert.ok(app.includes('item.acknowledgedBy = actor.displayName'), 'SLA acknowledgements should record the operator');
  assert.ok(admin.includes('alert.ownerName || alert.acknowledgedBy'), 'patrol rows should expose the accountable owner');
});

test('sla alerts surface owner workload and filtering', () => {
  const app = readServerFile(path.join('src', 'app.js'));
  const admin = readServerFile(path.join('public', 'admin.js'));

  assert.ok(app.includes('slaOwnerTasks(data.slaAlerts'), 'overview should aggregate owner workload');
  assert.ok(app.includes('item.ownerId = actor.id'), 'claiming a platform alert should set the accountable operator');
  assert.ok(admin.includes('function slaOwnerKey'), 'admin should group alerts by the same owner key');
  assert.ok(admin.includes('slaOwnerTasksPanel'), 'admin dashboard should show owner workload');
  assert.ok(admin.includes('data-owner="${esc(task.key)}"'), 'admin should filter patrol alerts by owner');
  assert.ok(app.includes('/assign$'), 'server should expose SLA alert assignment');
  assert.ok(app.includes('ADMIN_NOT_ACTIVE'), 'assignment should reject disabled operators');
  assert.ok(admin.includes('class="assign-alert"'), 'admin should provide an owner assignment control');
  assert.ok(admin.includes('预警已分配，负责人已收到提醒'), 'assignment should confirm operator notification');
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

test('order actions route to edit and after-sale pages', () => {
  const js = readMiniappFile(path.join('pages', 'orders', 'orders.js'));
  const wxml = readMiniappFile(path.join('pages', 'orders', 'orders.wxml'));
  const editPage = readMiniappFile(path.join('pages', 'edit-order', 'edit-order.js'));

  assert.ok(wxml.includes("action.key === 'edit' ? 'editOrder'"), 'edit action should open the delivery editor');
  assert.ok(wxml.includes("action.key === 'aftersale' ? 'afterSales'"), 'after-sale action should open the after-sale page');
  assert.ok(js.includes('editOrder(e)'), 'orders page should implement editOrder');
  assert.ok(js.includes('afterSales(e)'), 'orders page should implement afterSales');
  assert.ok(editPage.includes('this.data.deliveryTimeSlots[deliveryTimeIndex]'), 'rescheduling should use the selected configured time slot');
});

test('order notices focus the matching business tab', () => {
  const js = readMiniappFile(path.join('pages', 'orders', 'orders.js'));

  assert.ok(js.includes('focusRecordType'), 'order page should read the notice record type');
  assert.ok(js.includes('focusRecordType&&focusRecordType!==this.data.active?focusRecordType:this.data.active'), 'order page should switch tabs for focused notices');
});

test('completed order reviews support image evidence and text-only submission', () => {
  const js = readMiniappFile(path.join('pages', 'orders', 'orders.js'));

  assert.ok(js.includes('function uploadReviewImage(file)'), 'review flow should upload local images to the platform');
  assert.ok(js.includes("mediaType: ['image']"), 'review flow should collect image evidence');
  assert.ok(js.includes('count: 3'), 'review flow should cap review images at 3');
  assert.ok(js.includes('fail: () => {'), 'closing the image picker should not block a text review');
});

test('manual compliance review keeps products visible during the observation window', () => {
  const app = readServerFile(path.join('src', 'app.js'));
  const admin = readServerFile(path.join('public', 'admin.js'));
  const merchantJs = readMiniappFile(path.join('pages', 'merchant', 'index.js'));
  const merchantMarkup = readMiniappFile(path.join('pages', 'merchant', 'index.wxml'));

  assert.ok(app.includes('function productComplianceWatchUntil'), 'compliance observation window should be calculated');
  assert.ok(app.includes("action: 'WATCH'"), 'patrol should keep manually restored products under review instead of redelisting');
  assert.ok(admin.includes('reviewDueAt'), 'admin should expose the compliance review deadline');
  assert.ok(merchantJs.includes('watchText'), 'merchant workbench should decorate the observation window');
  assert.ok(merchantMarkup.includes('观察期：'), 'merchant workbench should show the observation window');
});

test('checkout renders promotion text without unsupported WXML chaining', () => {
  const js = readMiniappFile(path.join('pages', 'checkout', 'checkout.js'));
  const wxml = readMiniappFile(path.join('pages', 'checkout', 'checkout.wxml'));

  assert.ok(js.includes('promoText: data.promotion?.statusText'), 'promotion text should be normalized in JavaScript');
  assert.ok(wxml.includes('{{scooter.promoText}}'), 'checkout summary should use the precomputed promotion text');
  assert.ok(!wxml.includes('scooter.promotion?.'), 'WXML should not use optional chaining');
});

test('merchant workbench opens with an operations dashboard', () => {
  const wxml = readMiniappFile(path.join('pages', 'merchant', 'index.wxml'));
  const js = readMiniappFile(path.join('pages', 'merchant', 'index.js'));
  const css = readMiniappFile(path.join('pages', 'merchant', 'index.wxss'));

  assert.ok(wxml.includes('class="workbench card"'), 'merchant workbench should open with an operations dashboard');
  assert.ok(wxml.indexOf('class="workbench card"') < wxml.indexOf('id="merchant-qualification-card"'), 'operations dashboard should come before the qualification form');
  assert.ok(wxml.includes('bindtap="goFinance"'), 'merchant dashboard should expose finance quick access');
  assert.ok(wxml.includes('bindtap="openQualificationPanel"'), 'qualification form should be opened on demand');
  assert.ok(js.includes('goFinance()'), 'finance quick access should scroll to the settlement panel');
  assert.ok(js.includes('openQualificationPanel()'), 'qualification quick access should reveal the form');
  assert.ok(css.includes('.workbench-metrics'), 'operations dashboard should have visible layout styles');
});
