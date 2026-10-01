const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

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

/**
 * 读取 server/src 下全部源码并拼接后返回。
 *
 * 这些断言要校验的是「服务端源码中存在这段逻辑」，而非「这段逻辑恰好写在 app.js 里」。
 * 采用拼接读法后，模块拆分与路由迁移不会让文本断言成片失效。
 */
function readServerSource() {
  const root = path.join(serverDirectory, 'src');
  const files = fs.readdirSync(root, { recursive: true })
    .filter((item) => String(item).endsWith('.js'))
    .map((item) => path.join(root, String(item)));
  return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

/**
 * 读取「商品列表页 + 它委托的展示层模块」源码并拼接后返回。
 *
 * 与 readServerSource() 同型：断言要校验的是「列表页这套代码里有服务端折算价」，
 * 而不是「这段逻辑恰好写在 scooters.js 里」。
 *
 * T37 把售卖 / 租赁的展示映射抽到 `miniprogram/utils/product-view.js`（纯函数，
 * 可被 test/miniapp-runtime.test.js 真实加载断言）后，单读页面文件会让断言退化成
 * 「注释里恰好有该字符串」的假阳性 —— 那正是本文件要防的一类空断言。
 *
 * ⚠️ 本函数返回的是**含注释的原始文本**，所以用它的断言必须匹配「只可能出现在代码里」
 * 的记号（带括号的调用 / 字段读取），不能匹配一个名词本身 —— 否则一句解释性注释
 * 就能让断言恒真。改名等重构会让这类断言转红，这是本文件既有文本断言的固有代价
 * （如 `recommendWeight`），行为层面的保证由 test/miniapp-runtime.test.js 承担。
 */
function readProductListViewSource() {
  return [
    readMiniappFile(path.join('pages', 'scooters', 'scooters.js')),
    readMiniappFile(path.join('utils', 'product-view.js'))
  ].join('\n');
}

/**
 * 读取「订单页 + 它委托的卡片装饰层」源码并拼接后返回。
 *
 * 与 `readProductListViewSource()` 同型，理由也相同：M3-P1-05 把 `card(item)`
 * 及其文案表（`typeNames` / `ebikeJourney` / `afterSaleJourney` / `statusTones`
 * / `decorateAfterSale` / `formatDueText` / `rentalNextStep`）从 `orders.js` 抽到
 * `utils/order-card.js`（纯函数，可被 `test/miniapp-runtime.test.js` 真实加载断言）。
 *
 * 这些断言的**意图**是「订单页这套代码里有售后进度 / 部分退款 / 平台处理结果」，
 * 而不是「这段逻辑恰好写在 orders.js 里」。若继续单读 `orders.js`，抽取之后断言
 * 会转红 —— 但页面行为一个字都没变。改成拼接读法后，断言继续守住原意图，
 * 且「订单卡片逻辑跑去了别处」这种真正的回归依然会被 `order-card.js` 的运行时用例拦住。
 *
 * @returns {string} `orders.js` 与 `utils/order-card.js` 的源码拼接。
 */
function readOrdersCardSource() {
  return [
    readMiniappFile(path.join('pages', 'orders', 'orders.js')),
    readMiniappFile(path.join('utils', 'order-card.js'))
  ].join('\n');
}

test('miniapp JavaScript parses without syntax errors', () => {
  for (const file of listMiniappFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    // 与 `node --check` 等价的语法校验：编译而不执行。
    // 改用进程内 vm.Script 是因为本环境 node 无法 spawn node（EBUSY），
    // 原实现为 43 个文件各起一个子进程，全部失败。
    assert.doesNotThrow(
      () => new vm.Script(source, { filename: file }),
      `${path.relative(miniappDirectory, file)} 存在语法错误`
    );
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
  assert.ok(source.includes('/pages/addresses/addresses'), 'checkout should link to address manager');
  assert.match(source, /onShow\(\)[\s\S]*this\.loadAddresses\(\)/, 'checkout should refresh addresses when returning from the address manager');

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
  assert.ok(source.includes('Math.max(1, Math.min(sellableStock, MAX_ORDER_QUANTITY_PER_ITEM))'), 'quantity cap should follow sellable stock and the named platform cap');
  assert.ok(source.includes('setQuantity'), 'checkout should expose quantity controls');
  assert.ok(source.includes('Math.max(1, Math.min(Number(this.data.quantity || 1), this.data.maxQuantity || 1))'), 'totals should guard against stale quantity state');
  assert.ok(source.includes('quantity > Number(scooter.sellableStock || 0)'), 'submit should guard against stock changes');
  assert.ok(source.includes('{ productId: scooter.id, quantity }'), 'order payload should submit selected quantity');
  assert.ok(source.includes('items: [orderItem]'), 'order payload should be assembled through the normalized order item');
  assert.ok(source.includes('rentalUnits: this.data.rentalUnits'), 'rental order payload should submit the chosen rental units');
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

test('completed aftersales remain visible with resolution results', () => {
  const source = readMiniappFile(path.join('pages', 'aftersales', 'aftersales.js'));
  const markup = readMiniappFile(path.join('pages', 'aftersales', 'aftersales.wxml'));
  const styles = readMiniappFile(path.join('pages', 'aftersales', 'aftersales.wxss'));

  assert.ok(source.includes('completed: null'), 'aftersales should initialize completed result state');
  assert.ok(source.includes("item.status === 'CLOSED'"), 'aftersales should select completed records');
  assert.ok(source.includes('formatDate(completed.resolvedAt || completed.updatedAt || completed.createdAt)'), 'aftersales should format the completion time');
  assert.ok(source.includes("CLOSED: '已完成'"), 'completed aftersales should use an operational label');
  assert.ok(markup.includes('completed-title'), 'aftersales should show the completed result card');
  assert.ok(markup.includes('completed.resolvedText'), 'aftersales should bind the completion time');
  assert.ok(markup.includes('completed.resolutionNote'), 'aftersales should bind the merchant resolution note');
  assert.ok(markup.includes('previewExistingImages'), 'completed aftersales should keep image previews');
  assert.ok(styles.includes('.completed-title') && styles.includes('.completed-copy'), 'completed result card should be styled');
  assert.ok(styles.includes('.completed .evidence-grid'), 'completed result images should be styled');
});

test('completed aftersales guide users to review the order', () => {
  const source = readMiniappFile(path.join('pages', 'aftersales', 'aftersales.js'));
  const markup = readMiniappFile(path.join('pages', 'aftersales', 'aftersales.wxml'));
  const ordersSource = readMiniappFile(path.join('pages', 'orders', 'orders.js'));

  assert.ok(source.includes('canReview'), 'aftersales should compute review eligibility from completed orders');
  assert.ok(source.includes('reviewedKeys'), 'aftersales should exclude already reviewed products');
  assert.ok(source.includes('goReview'), 'aftersales should provide a review action');
  assert.ok(source.includes('campusGoOrderFocusId'), 'review action should hand the order focus to the orders page');
  assert.ok(markup.includes('bindtap="goReview"'), 'completed aftersales should expose the review button');
  assert.ok(ordersSource.includes('campusGoOrderFocusId'), 'orders page should consume the stored focus id');
});

test('aftersales status and contact actions stay understandable', () => {
  const source = readMiniappFile(path.join('pages', 'aftersales', 'aftersales.js'));
  const markup = readMiniappFile(path.join('pages', 'aftersales', 'aftersales.wxml'));
  const styles = readMiniappFile(path.join('pages', 'aftersales', 'aftersales.wxss'));

  assert.ok(source.includes('statusCopy'), 'aftersales should derive status-aware wording');
  assert.ok(source.includes("REJECTED: { title: '商家已反馈本次售后'"), 'rejected aftersales should not sound like active work');
  assert.ok(source.includes('config.servicePhone || config.serviceWechat'), 'aftersales should load configured contact info');
  assert.ok(source.includes('callContact()'), 'aftersales should expose a phone contact action');
  assert.ok(markup.includes('{{existing.title}}'), 'aftersales should bind status-aware titles');
  assert.ok(markup.includes('{{existing.tip}}'), 'aftersales should bind actionable next-step guidance');
  assert.ok(markup.includes('open-type="contact"'), 'aftersales should expose WeChat customer service');
  assert.ok(markup.includes('bindtap="callContact"'), 'aftersales should expose phone customer service');
  assert.ok(styles.includes('.contact-row'), 'contact actions should be styled');
});

test('rejected aftersales can request platform assistance', () => {
  const source = readMiniappFile(path.join('pages', 'aftersales', 'aftersales.js'));
  const markup = readMiniappFile(path.join('pages', 'aftersales', 'aftersales.wxml'));
  const styles = readMiniappFile(path.join('pages', 'aftersales', 'aftersales.wxss'));
  const server = readServerSource();

  assert.ok(source.includes("appealRequested: order?.collaboration?.intervention?.status === 'REQUESTED'"), 'aftersales should read platform intervention state');
  assert.ok(source.includes("action: 'APPEAL'"), 'aftersales should submit the platform appeal action');
  assert.ok(source.includes('requestAppeal()'), 'aftersales should expose the appeal action');
  assert.ok(markup.includes('appealRequested'), 'aftersales should show the appeal request state');
  assert.ok(markup.includes('bindtap="requestAppeal"'), 'aftersales should expose the platform assistance button');
  assert.ok(styles.includes('.appeal-state'), 'appeal request state should be styled');
  assert.ok(server.includes("${item.orderNo} 申请平台协助"), 'order appeals should create platform notifications');
});

test('aftersales surface platform resolution results to users', () => {
  const source = readMiniappFile(path.join('pages', 'aftersales', 'aftersales.js'));
  const markup = readMiniappFile(path.join('pages', 'aftersales', 'aftersales.wxml'));
  const styles = readMiniappFile(path.join('pages', 'aftersales', 'aftersales.wxss'));

  assert.ok(source.includes("intervention?.status === 'RESOLVED'"), 'aftersales should read resolved platform intervention');
  assert.ok(source.includes('platformResult'), 'aftersales should derive platform resolution state');
  assert.ok(source.includes('formatDate(intervention.updatedAt || intervention.createdAt)'), 'aftersales should show the platform resolution time');
  assert.ok(markup.includes('platform-result-title'), 'aftersales should render the platform result card');
  assert.ok(markup.includes('platformResult.note'), 'aftersales should bind the platform resolution note');
  assert.ok(styles.includes('.platform-result-title') && styles.includes('.platform-result-copy'), 'platform result card should be styled');
});

test('orders surface platform resolution results to users', () => {
  const source = readOrdersCardSource();
  const markup = readMiniappFile(path.join('pages', 'orders', 'orders.wxml'));
  const styles = readMiniappFile(path.join('pages', 'orders', 'orders.wxss'));

  assert.ok(source.includes("item.collaboration?.intervention?.status === 'RESOLVED'"), 'orders should read resolved platform intervention');
  assert.ok(source.includes('platformResult'), 'orders should derive platform resolution state');
  assert.ok(markup.includes('platform-result-label'), 'orders should render the platform result card');
  assert.ok(markup.includes('item.platformResult.note'), 'orders should bind the platform resolution note');
  assert.ok(styles.includes('.platform-result-label') && styles.includes('.platform-result-copy'), 'platform result card should be styled');
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
  const serverSource = readServerSource();
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

  const homeSource = readMiniappFile(path.join('pages', 'home', 'home.js'));
  assert.ok(homeSource.includes('/api/my/recommendations'), 'home should load personalized recommendations');
  assert.ok(homeSource.includes('loadRecommendations'), 'home should refresh recommendations on show');
  const homeMarkup = readMiniappFile(path.join('pages', 'home', 'home.wxml'));
  assert.ok(homeMarkup.includes('recommendations.length'), 'home should surface recommendations section');
  assert.ok(homeMarkup.includes('goDetail'), 'recommendations should navigate to product detail');

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
  const js = readOrdersCardSource();
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
  const js = readOrdersCardSource();
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
  assert.ok(js.includes("['AFTER_SALE', 'PARTIALLY_REFUNDED'].includes(order.status)"), 'partial refunds should remain visible in the after-sale queue');
  assert.ok(wxml.includes('partial-refund'), 'merchant orders should show the partial refund notice');
  assert.ok(wxml.includes('剩余 {{item.remainingQuantity}} 件继续履约'), 'merchant orders should show the remaining quantity');
});

test('after-sale rejection keeps users and merchants connected', () => {
  const merchantJs = readMiniappFile(path.join('pages', 'merchant', 'orders.js'));
  const merchantWxml = readMiniappFile(path.join('pages', 'merchant', 'orders.wxml'));
  const ordersJs = readOrdersCardSource();
  const afterSaleJs = readMiniappFile(path.join('pages', 'aftersales', 'aftersales.js'));

  assert.ok(merchantJs.includes('REJECTED'), 'merchant after-sale labels should include rejection');
  assert.ok(merchantJs.includes('拒绝售后申请'), 'merchant should supply a rejection reason');
  assert.ok(merchantWxml.includes('拒绝申请'), 'merchant orders should expose the reject action');
  assert.ok(ordersJs.includes('REJECTED'), 'user order timeline should explain rejection');
  assert.ok(afterSaleJs.includes('REJECTED'), 'after-sale detail should show rejection status');
});

test('after-sale images can be previewed from orders and aftersales', () => {
  const ordersJs = readMiniappFile(path.join('pages', 'orders', 'orders.js'));
  const ordersWxml = readMiniappFile(path.join('pages', 'orders', 'orders.wxml'));
  const aftersalesJs = readMiniappFile(path.join('pages', 'aftersales', 'aftersales.js'));
  const aftersalesWxml = readMiniappFile(path.join('pages', 'aftersales', 'aftersales.wxml'));

  assert.ok(ordersJs.includes('previewAfterSaleImages'), 'orders should expose after-sale image preview');
  assert.ok(ordersWxml.includes('previewAfterSaleImages'), 'orders should bind the after-sale image preview');
  assert.ok(aftersalesJs.includes('previewExistingImages'), 'aftersales should expose existing image preview');
  assert.ok(aftersalesWxml.includes('previewExistingImages'), 'aftersales should bind existing image preview');
  assert.ok(aftersalesJs.includes('previewNewImages'), 'aftersales should expose new image preview');
  assert.ok(aftersalesWxml.includes('previewNewImages'), 'aftersales should bind new image preview');
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

test('profile links to a my reviews page with merchant replies', () => {
  const appConfig = JSON.parse(readMiniappFile('app.json'));
  assert.ok(appConfig.pages.includes('pages/reviews/reviews'), 'my reviews page should be registered');

  const reviewsSource = readMiniappFile(path.join('pages', 'reviews', 'reviews.js'));
  assert.ok(reviewsSource.includes('/api/my/product-reviews'), 'my reviews page should load server reviews');
  const reviewsMarkup = readMiniappFile(path.join('pages', 'reviews', 'reviews.wxml'));
  assert.ok(reviewsMarkup.includes('item.reply'), 'my reviews page should surface merchant replies');

  const profileSource = readMiniappFile(path.join('pages', 'profile', 'profile.js'));
  assert.ok(profileSource.includes('/pages/reviews/reviews'), 'profile should link to my reviews');
});
test('buy again jumps straight into checkout with the product id', () => {
  const ordersJs = readMiniappFile(path.join('pages', 'orders', 'orders.js'));
  const checkoutJs = readMiniappFile(path.join('pages', 'checkout', 'checkout.js'));

  assert.ok(ordersJs.includes('/pages/checkout/checkout?id='), 'buy again should open checkout directly');
  assert.ok(checkoutJs.includes('options.id'), 'checkout should accept a product id deep link');
});
test('profile links to a browsing footprints page', () => {
  const appConfig = JSON.parse(readMiniappFile('app.json'));
  assert.ok(appConfig.pages.includes('pages/footprints/footprints'), 'footprints page should be registered');

  const footprintsSource = readMiniappFile(path.join('pages', 'footprints', 'footprints.js'));
  assert.ok(footprintsSource.includes('/api/my/footprints'), 'footprints page should load server footprints');
  const footprintsMarkup = readMiniappFile(path.join('pages', 'footprints', 'footprints.wxml'));
  assert.ok(footprintsMarkup.includes('goDetail'), 'footprints should navigate to product detail');

  const profileSource = readMiniappFile(path.join('pages', 'profile', 'profile.js'));
  assert.ok(profileSource.includes('/pages/footprints/footprints'), 'profile should link to footprints');
});
test('profile links to a reusable address manager page', () => {
  const appConfig = JSON.parse(readMiniappFile('app.json'));
  assert.ok(appConfig.pages.includes('pages/addresses/addresses'), 'address manager page should be registered');

  const addressesSource = readMiniappFile(path.join('pages', 'addresses', 'addresses.js'));
  assert.ok(addressesSource.includes('/api/my/addresses'), 'address manager should use server addresses');
  const addressesMarkup = readMiniappFile(path.join('pages', 'addresses', 'addresses.wxml'));
  assert.ok(addressesMarkup.includes('setDefault'), 'address manager should support setting a default address');
  assert.ok(addressesMarkup.includes('deleteAddress'), 'address manager should support deleting an address');

  const profileSource = readMiniappFile(path.join('pages', 'profile', 'profile.js'));
  assert.ok(profileSource.includes('/pages/addresses/addresses'), 'profile should link to address manager');
});
test('user login falls back to demo login when platform login fails', () => {
  const source = readMiniappFile(path.join('lib', 'cloud-request.js'));

  assert.ok(source.includes('/api/auth/login'), 'cloud request should try platform login first');
  assert.ok(source.includes('/api/auth/demo-login'), 'cloud request should fall back to demo login');
  assert.ok(source.includes('loginWithPlatform().catch'), 'fallback should trigger only after platform login fails');
});
test('plate page surfaces charging eligibility linked to review status', () => {
  const plateJs = readMiniappFile(path.join('pages', 'plate', 'plate.js'));
  const plateWxml = readMiniappFile(path.join('pages', 'plate', 'plate.wxml'));
  const homeWxml = readMiniappFile(path.join('pages', 'home', 'home.wxml'));
  const homeJs = readMiniappFile(path.join('pages', 'home', 'home.js'));

  assert.ok(plateJs.includes('/api/my/charging-eligibility'), 'plate page should load charging eligibility');
  assert.ok(plateWxml.includes('charging-eligibility'), 'plate page should surface the charging card');
  assert.ok(plateWxml.includes('{{charging.stateLabel}}'), 'charging card should show eligibility state');
  assert.ok(homeWxml.includes('catchtap="goView"'), 'home charging entry should navigate to the plate page');
  assert.ok(homeJs.includes('goView(event)'), 'home should route the charging entry');
});
test('detail page records browsing footprints for recommendations', () => {
  const detailJs = readMiniappFile(path.join('pages', 'detail', 'detail.js'));

  assert.ok(detailJs.includes('/api/my/footprints'), 'detail should record browsing footprints');
  assert.ok(detailJs.includes('productId: data.id'), 'footprints should reference the viewed product');
});
test('home search opens a unified commerce search page', () => {
  const homeJs = readMiniappFile(path.join('pages', 'home', 'home.js'));
  const homeWxml = readMiniappFile(path.join('pages', 'home', 'home.wxml'));
  const searchJs = readMiniappFile(path.join('pages', 'search', 'search.js'));
  const searchWxml = readMiniappFile(path.join('pages', 'search', 'search.wxml'));
  const cardJs = readMiniappFile(path.join('pages', 'card', 'card.js'));
  const appConfig = JSON.parse(readMiniappFile('app.json'));

  assert.ok(homeWxml.includes('search-bar'), 'home should expose a search entry');
  assert.ok(homeWxml.includes('bindconfirm="goSearch"'), 'home search should submit on confirm');
  assert.ok(homeJs.includes('goSearch'), 'home should navigate to the unified search page');
  assert.ok(homeJs.includes('/pages/search/search?query='), 'home search should pass the keyword');
  assert.ok(appConfig.pages.includes('pages/search/search'), 'unified search page should be registered');
  assert.ok(searchJs.includes('/api/products'), 'search should load commerce products');
  assert.ok(searchJs.includes('/api/recharge-promos'), 'search should load recharge promotions');
  assert.ok(searchWxml.includes('filteredProducts'), 'search should render product results');
  assert.ok(searchWxml.includes('filteredPromos'), 'search should render promo results');
  assert.ok(searchWxml.includes('result-thumb'), 'search should show product artwork');
  assert.ok(searchJs.includes('onShareAppMessage'), 'search should support sharing');
  assert.ok(searchJs.includes('merchantScore'), 'search should use the server merchant score');
  assert.ok(searchWxml.includes('service-score'), 'search should surface the service score');
  assert.ok(searchWxml.includes('result-summary'), 'search should show the result count');
  assert.ok(searchWxml.includes('resetFilters'), 'search should support clearing filters');
  assert.ok(searchJs.includes('goHome'), 'search should provide a home entry when empty');
  assert.ok(cardJs.includes('options.promoId'), 'card page should accept promo deep links');
});

test('market pages expose list, detail, and publish flows', () => {
  const appConfig = JSON.parse(readMiniappFile('app.json'));
  const marketJs = readMiniappFile(path.join('pages', 'market', 'market.js'));
  const marketWxml = readMiniappFile(path.join('pages', 'market', 'market.wxml'));
  const itemJs = readMiniappFile(path.join('pages', 'market', 'item.js'));
  const itemWxml = readMiniappFile(path.join('pages', 'market', 'item.wxml'));
  const publishJs = readMiniappFile(path.join('pages', 'market', 'publish.js'));
  const homeJs = readMiniappFile(path.join('pages', 'home', 'home.js'));

  assert.ok(appConfig.pages.includes('pages/market/market'), 'market list should be registered');
  assert.ok(appConfig.pages.includes('pages/market/item'), 'market detail should be registered');
  assert.ok(appConfig.pages.includes('pages/market/publish'), 'market publish should be registered');
  assert.ok(marketJs.includes('/api/market/items'), 'market list should load marketplace items');
  assert.ok(marketWxml.includes('bindtap="goItem"'), 'market list should link item cards to detail');
  assert.ok(marketWxml.includes('bindtap="goPublish"'), 'market list should expose the publish entry');
  assert.ok(marketWxml.includes('bindtap="goForum"'), 'market list should link to the forum');
  assert.ok(itemJs.includes('/api/market/items/'), 'market detail should load a single item');
  assert.ok(itemJs.includes("data: { status }"), 'market detail should support seller status changes');
  assert.ok(itemWxml.includes('bindtap="copyContact"'), 'market detail should expose seller contact');
  assert.ok(publishJs.includes("method: 'POST'") && publishJs.includes('/api/market/items'), 'publish should submit to the marketplace API');
  assert.ok(publishJs.includes('conditionOptions'), 'publish should collect item condition');
  assert.ok(homeJs.includes('goMarket'), 'home should route to the marketplace');
});

test('forum pages expose boards, posts, comments, and likes', () => {
  const appConfig = JSON.parse(readMiniappFile('app.json'));
  const forumJs = readMiniappFile(path.join('pages', 'forum', 'forum.js'));
  const forumWxml = readMiniappFile(path.join('pages', 'forum', 'forum.wxml'));
  const postJs = readMiniappFile(path.join('pages', 'forum', 'post.js'));
  const postWxml = readMiniappFile(path.join('pages', 'forum', 'post.wxml'));
  const publishJs = readMiniappFile(path.join('pages', 'forum', 'publish.js'));

  assert.ok(appConfig.pages.includes('pages/forum/forum'), 'forum list should be registered');
  assert.ok(appConfig.pages.includes('pages/forum/post'), 'forum post detail should be registered');
  assert.ok(appConfig.pages.includes('pages/forum/publish'), 'forum publish should be registered');
  assert.ok(forumJs.includes('/api/forum/posts'), 'forum list should load posts');
  assert.ok(forumWxml.includes('bindtap="goPost"'), 'forum list should link posts to detail');
  assert.ok(forumWxml.includes('bindtap="goPublish"'), 'forum list should expose the publish entry');
  assert.ok(forumWxml.includes('bindtap="goMarket"'), 'forum list should link to the marketplace');
  assert.ok(postJs.includes('/comments'), 'post detail should load comments');
  assert.ok(postJs.includes('/like'), 'post detail should support likes');
  assert.ok(postWxml.includes('bindtap="toggleLike"'), 'post detail should expose the like action');
  assert.ok(postWxml.includes('submitComment'), 'post detail should expose the comment input');
  assert.ok(publishJs.includes("method: 'POST'") && publishJs.includes('/api/forum/posts'), 'forum publish should submit posts');
  assert.ok(publishJs.includes('boardOptions'), 'forum publish should collect the board');
});

test('admin console moderates marketplace listings and forum posts', () => {
  const adminJs = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'admin.js'), 'utf8');
  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'admin.html'), 'utf8');

  assert.ok(adminHtml.includes('data-view="market"'), 'admin sidebar should link to marketplace moderation');
  assert.ok(adminHtml.includes('data-view="forum"'), 'admin sidebar should link to forum moderation');
  assert.ok(adminJs.includes('marketView'), 'admin should render the marketplace view');
  assert.ok(adminJs.includes('forumView'), 'admin should render the forum view');
  assert.ok(adminJs.includes('/api/admin/market-items/'), 'admin should call the marketplace moderation API');
  assert.ok(adminJs.includes('/api/admin/forum-posts/'), 'admin should call the forum moderation API');
  assert.ok(adminJs.includes('.toggle-market'), 'admin should bind marketplace moderation buttons');
  assert.ok(adminJs.includes('.toggle-forum'), 'admin should bind forum moderation buttons');
  assert.ok(adminJs.includes("REMOVED: '已下架'"), 'admin should label removed listings');
});

test('search page keeps history and hot keyword suggestions', () => {
  const searchJs = readMiniappFile(path.join('pages', 'search', 'search.js'));
  const searchWxml = readMiniappFile(path.join('pages', 'search', 'search.wxml'));
  const searchCss = readMiniappFile(path.join('pages', 'search', 'search.wxss'));

  assert.ok(searchJs.includes('campusGoSearchHistory'), 'search should persist history in local storage');
  assert.ok(searchJs.includes('recordHistory'), 'confirmed searches should be recorded');
  assert.ok(searchJs.includes('clearHistory'), 'search history should be clearable');
  assert.ok(searchJs.includes('hotKeywords'), 'search should suggest hot keywords from loaded results');
  assert.ok(searchWxml.includes('bindconfirm="confirmSearch"'), 'search confirm should record history');
  assert.ok(searchWxml.includes('搜索历史'), 'search history should be visible');
  assert.ok(searchWxml.includes('热门搜索'), 'hot keywords should be visible');
  assert.ok(searchWxml.includes('bindtap="tapKeyword"'), 'suggested keywords should be tappable');
  assert.ok(searchCss.includes('.suggest-tag'), 'suggestions should be styled');
});
test('product sale campaigns show server-controlled promo pricing', () => {
  const homeJs = readMiniappFile(path.join('pages', 'home', 'home.js'));
  const homeWxml = readMiniappFile(path.join('pages', 'home', 'home.wxml'));
  const scooterJs = readProductListViewSource();
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
  assert.ok(scooterJs.includes('effectivePriceInCentsOf('), 'scooter list should use server effective pricing');
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

test('merchant workbench surfaces pending platform review on the dashboard', () => {
  const js = readMiniappFile(path.join('pages', 'merchant', 'index.js'));
  const wxml = readMiniappFile(path.join('pages', 'merchant', 'index.wxml'));
  const wxss = readMiniappFile(path.join('pages', 'merchant', 'index.wxss'));

  assert.ok(wxml.includes('pending-banner'), 'pending review banner should appear on the dashboard');
  assert.ok(wxml.includes('待平台复核商品'), 'pending review section should stay in the risk tab');
  assert.ok(js.includes('pendingPublishProducts: data.pendingPublishProducts'), 'workspace should load pending review products');
  assert.ok(wxss.includes('.pending-banner'), 'pending review banner should have distinct styling');
});

test('merchant workbench orders expose a status-aware action', () => {
  const js = readMiniappFile(path.join('pages', 'merchant', 'index.js'));
  const wxml = readMiniappFile(path.join('pages', 'merchant', 'index.wxml'));

  assert.ok(js.includes('orderActionLabels'), 'workbench should map orders to explicit actions');
  assert.ok(js.includes("PAID: '去发货'"), 'fulfillment orders should prompt shipping');
  assert.ok(js.includes("AFTER_SALE: '处理售后'"), 'after-sale orders should prompt handling');
  assert.ok(js.includes("COMPLETED: '查看详情'"), 'completed orders should prompt review');
  assert.ok(js.includes("PARTIALLY_REFUNDED: '部分退款'"), 'partial refunds should have a clear label');
  assert.ok(wxml.includes('{{item.actionText}}'), 'recent orders should render the status-aware action');
});

test('merchant workbench links orders and settlements to detail queues', () => {
  const js = readMiniappFile(path.join('pages', 'merchant', 'index.js'));
  const wxml = readMiniappFile(path.join('pages', 'merchant', 'index.wxml'));

  assert.ok(wxml.includes('section-more'), 'overview sections should expose quick links');
  assert.ok(wxml.includes('bindtap="goOrders"'), 'recent orders should link to the full order queue');
  assert.ok(wxml.includes('bindtap="goFinance"'), 'recent settlements should link to the finance tab');
  assert.ok(js.includes('goFinance()'), 'settlement links should switch to the finance tab');
});

test('merchant workbench metrics drill into finance and orders', () => {
  const js = readMiniappFile(path.join('pages', 'merchant', 'index.js'));
  const wxml = readMiniappFile(path.join('pages', 'merchant', 'index.wxml'));

  assert.ok(wxml.includes('metric-link'), 'dashboard metrics should be tappable');
  assert.ok(wxml.includes('bindtap="goFinance"'), 'revenue metric should open the finance tab');
  assert.ok(wxml.includes('bindtap="goOrders"'), 'order metric should open the order queue');
  assert.ok(js.includes('goOrders()'), 'metric links should reuse the order navigation');
});

test('merchant workbench surfaces a today overview', () => {
  const js = readMiniappFile(path.join('pages', 'merchant', 'index.js'));
  const wxml = readMiniappFile(path.join('pages', 'merchant', 'index.wxml'));

  assert.ok(wxml.includes('workbench-today'), 'dashboard should show a today overview strip');
  assert.ok(wxml.includes('{{metrics.today.orderCount}}'), 'today overview should show today order count');
  assert.ok(wxml.includes('{{metrics.today.revenueInCents / 100}}'), 'today overview should show today revenue');
  assert.ok(js.includes('metrics: data.metrics'), 'workspace should load the today metrics from the server payload');
});

test('merchant workbench surfaces a store health snapshot on the overview', () => {
  const js = readMiniappFile(path.join('pages', 'merchant', 'index.js'));
  const wxml = readMiniappFile(path.join('pages', 'merchant', 'index.wxml'));

  assert.ok(wxml.includes('class="health card"'), 'overview should show a store health card');
  assert.ok(wxml.includes('{{serviceScore.score}}'), 'health card should show the service score');
  assert.ok(wxml.includes('data-tab="risk"'), 'health card should drill into the risk tab');
  assert.ok(js.includes('setWorkbenchTab(event)'), 'health card should reuse the tab switch handler');
});

test('merchant workbench surfaces a revenue trend chart', () => {
  const js = readMiniappFile(path.join('pages', 'merchant', 'index.js'));
  const wxml = readMiniappFile(path.join('pages', 'merchant', 'index.wxml'));

  assert.ok(wxml.includes('rev-bars'), 'dashboard should render a revenue trend chart');
  assert.ok(wxml.includes('近7日营收 / 订单趋势'), 'trend chart should use plain merchant wording');
  assert.ok(wxml.includes('bindtap="setTrendMetric"'), 'trend chart should switch between revenue and orders');
  assert.ok(js.includes('buildTrend('), 'trend chart should normalize the server series');
  assert.ok(js.includes('/api/merchant/revenue-trend'), 'trend chart should load the server trend endpoint');
});

test('merchant workbench surfaces subscription template configuration', () => {
  const js = readMiniappFile(path.join('pages', 'merchant', 'index.js'));
  const wxml = readMiniappFile(path.join('pages', 'merchant', 'index.wxml'));

  assert.ok(js.includes('/api/subscribe-templates'), 'workbench should load template configuration');
  assert.ok(js.includes("item.audience === 'MERCHANT'"), 'workbench should filter merchant templates');
  assert.ok(wxml.includes('notice-subscription'), 'messages tab should show the subscription card');
  assert.ok(wxml.includes('template-row'), 'subscription card should list configured templates');
  assert.ok(wxml.includes('subscribeScoreNotice'), 'subscription card should expose the toggle');
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

test('home surfaces the user favorites section', () => {
  const homeJs = readMiniappFile(path.join('pages', 'home', 'home.js'));
  const homeWxml = readMiniappFile(path.join('pages', 'home', 'home.wxml'));

  assert.ok(homeWxml.includes('我的收藏'), 'home should show a favorites section');
  assert.ok(homeWxml.includes('bindtap="goFavorites"'), 'favorites section should link to the favorites manager');
  assert.ok(homeWxml.includes('wx:for="{{favorites}}"'), 'favorites section should render saved products');
  assert.ok(homeJs.includes('/api/my/favorites'), 'home should load favorites from the server');
  assert.ok(homeJs.includes('goFavorites()'), 'home should expose the favorites manager entry');
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
  const orderJs = readOrdersCardSource();
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
  const orderJs = readOrdersCardSource();
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
  const app = readServerSource();
  const admin = readServerFile(path.join('public', 'admin.js'));

  assert.ok(app.includes("const actor = requireAdmin(request, 'ORDER_MANAGE')"), 'lead follow-ups should require an admin session');
  assert.ok(app.includes('if (!item.assignee) item.assignee = operator'), 'first follow-up should claim the lead');
  assert.ok(admin.includes("esc(x.assignee || '待认领')"), 'lead table should show the accountable owner');
  assert.ok(admin.includes("esc(lead.assignee || '待认领')"), 'lead drawer should show the accountable owner');
});

test('overdue leads keep owner accountability', () => {
  const app = readServerSource();
  const admin = readServerFile(path.join('public', 'admin.js'));

  assert.ok(app.includes('ownerId: record.assigneeId ||'), 'lead patrol targets should carry the assigned operator');
  assert.ok(app.includes("addNotification(data, owner.id, 'SLA'"), 'assigned operators should receive SLA notices');
  assert.ok(app.includes('item.acknowledgedBy = actor.displayName'), 'SLA acknowledgements should record the operator');
  assert.ok(admin.includes('alert.ownerName || alert.acknowledgedBy'), 'patrol rows should expose the accountable owner');
});

test('sla alerts surface owner workload and filtering', () => {
  const app = readServerSource();
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
  const app = readServerSource();
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
  assert.ok(wxml.includes('bindtap="goAfterSales"'), 'after-sale alert should open the after-sale queue directly');
  assert.ok(wxml.includes('bindtap="openNoticeCenter"'), 'notice quick action should route subscribed merchants to notices');
  assert.ok(wxml.includes('bindtap="goWorkbenchOrder"'), 'recent workbench orders should be tappable');
  assert.ok(wxml.includes('class="order-link"'), 'recent workbench orders should expose an explicit processing action');
  assert.ok(js.includes('goFinance()'), 'finance quick access should scroll to the settlement panel');
  assert.ok(js.includes('openQualificationPanel()'), 'qualification quick access should reveal the form');
  assert.ok(js.includes('goAfterSales()'), 'after-sale alert should carry an explicit queue filter');
  assert.ok(js.includes('openNoticeCenter()'), 'notice quick action should avoid toggling an existing subscription');
  assert.ok(js.includes("goWorkbenchOrder(event)"), 'recent orders should route into the matching merchant queue');
  assert.ok(js.includes("['PAID', 'FULFILLING'].includes(status)"), 'fulfillment orders should open the pending queue');
  assert.ok(css.includes('.workbench-metrics'), 'operations dashboard should have visible layout styles');
  assert.ok(wxml.includes('class="workbench-tabs"'), 'workbench details should be grouped by fixed tabs');
  assert.ok(wxml.includes("activeWorkbenchTab === 'risk'"), 'risk operations should be isolated from daily operations');
  assert.ok(wxml.includes("activeWorkbenchTab === 'finance'"), 'finance records should have a dedicated tab');
  assert.ok(wxml.includes("activeWorkbenchTab === 'messages'"), 'merchant notices should have a dedicated tab');
  assert.ok(js.includes('setWorkbenchTab(event)'), 'workbench tabs should switch on tap');
  assert.ok(js.includes("hasUrgentRisk ? 'risk' : 'overview'"), 'urgent risk should open the risk tab by default');
  assert.ok(js.includes('workbenchCounts: {'), 'workbench tabs should carry operation todo counts');
  assert.ok(js.includes("'workbenchCounts.messages': unreadNotificationCount"), 'message tab should surface unread notices');
  assert.ok(wxml.includes('wx:if="{{workbenchCounts.risk}}"'), 'risk badge should only render when risk work exists');
  assert.ok(css.includes('.tab-badge.alert'), 'active tab badges should use a calm color');
});

test('navigation utility separates tabBar navigation from page navigation', () => {
  const source = readMiniappFile('utils/navigation.js');

  assert.ok(source.includes('wx.switchTab'), 'tabBar 页面必须走 switchTab');
  assert.ok(source.includes('wx.navigateTo'), '非 tabBar 页面仍走 navigateTo');
  // switchTab 不支持 query，焦点参数只能改用 Storage
  assert.ok(source.includes('campusGoOrderFocusId'), '焦点参数需经 Storage 传递');
  // 静默失败会让用户点了没反应，历史上站内通知就是因此完全不可用
  assert.equal(
    /fail:\s*\(\s*\)\s*=>\s*\{\s*\}/.test(source),
    false,
    '跳转失败不应被空函数吞掉'
  );
});

test('navigation tabBar list stays in sync with app.json', () => {
  const appConfig = JSON.parse(readMiniappFile('app.json'));
  const source = readMiniappFile('utils/navigation.js');
  const tabBarPaths = (appConfig.tabBar?.list || []).map((item) => `/${item.pagePath}`);

  assert.ok(tabBarPaths.length > 0, 'app.json 应配置了 tabBar');

  for (const pagePath of tabBarPaths) {
    assert.ok(
      source.includes(`'${pagePath}'`),
      `navigation.js 的 TABBAR_PAGES 缺少 ${pagePath}，与 app.json 不一致`
    );
  }

  // 反向检查：不应保留已从 app.json 移除的 tabBar 页面。
  // 注意：此处**不得**再用 `tabBarPaths.includes(item)` 过滤字面量 —— 那个过滤会把
  // 「navigation.js 多出来的条目」在比较之前就丢掉，使 `declared ⊆ tabBarPaths` 恒成立，
  // 反向检查退化为与上面的正向检查逻辑等价（永远无法单独失败）。
  // 正确做法是把取值范围收敛到 `TABBAR_PAGES` 数组本身。
  const tabBarBlockStart = source.indexOf('const TABBAR_PAGES');
  assert.notEqual(tabBarBlockStart, -1, 'navigation.js 应声明 TABBAR_PAGES');
  const tabBarBlockEnd = source.indexOf('];', tabBarBlockStart);
  assert.notEqual(tabBarBlockEnd, -1, 'TABBAR_PAGES 应以 `];` 结束');
  const declared = (source.slice(tabBarBlockStart, tabBarBlockEnd).match(/'(\/pages\/[^']+)'/g) || [])
    .map((item) => item.slice(1, -1));
  assert.deepEqual(
    [...new Set(declared)].sort(),
    [...new Set(tabBarPaths)].sort(),
    'navigation.js 声明的 tabBar 页面应与 app.json 完全一致'
  );
});

test('no navigateTo call targets a tabBar page', () => {
  const appConfig = JSON.parse(readMiniappFile('app.json'));
  const tabBarPaths = (appConfig.tabBar?.list || []).map((item) => `/${item.pagePath}`);

  for (const file of listMiniappFiles()) {
    if (file.endsWith(path.join('utils', 'navigation.js'))) continue;
    const content = fs.readFileSync(file, 'utf8');
    for (const pagePath of tabBarPaths) {
      const escaped = pagePath.replace(/\//g, '\\/');
      const pattern = new RegExp(`navigateTo\\([^)]*['"\`]${escaped}`);
      assert.equal(
        pattern.test(content),
        false,
        `${path.relative(miniappDirectory, file)} 使用 navigateTo 跳转 tabBar 页面 ${pagePath}，应改用 openLink`
      );
    }
  }
});

test('every WXML file has balanced view tags', () => {
  // WXML 结构错误不会让 node --check 报错，只会在真机上渲染异常。
  // merchant/index.wxml 就曾漏掉一个 </view> 并多出一行重复的 <view>，
  // 二者恰好互相抵消成「看起来能用」，因此需要显式配平检查。
  const wxmlFiles = fs.readdirSync(miniappDirectory, { recursive: true })
    .filter((item) => String(item).endsWith('.wxml'))
    .map((item) => path.join(miniappDirectory, String(item)));

  assert.ok(wxmlFiles.length >= 30, `应扫描到全部页面模板，实际 ${wxmlFiles.length} 个`);

  for (const file of wxmlFiles) {
    const source = fs.readFileSync(file, 'utf8');
    // 兼容两种闭合写法：`</view>` 与换行后接 `>` 的紧凑风格
    const selfClosing = (source.match(/<view\b[^>]*\/>/g) || []).length;
    const opened = (source.match(/<view(?=[\s>])/g) || []).length - selfClosing;
    const closed = (source.match(/<\/view(?=[\s>])/g) || []).length;
    assert.equal(
      opened,
      closed,
      `${path.relative(miniappDirectory, file)} 的 <view> 与 </view> 不配平：开启 ${opened} / 闭合 ${closed}`
    );
  }
});

test('T40 反向护栏：商家端售卖文案表与售卖按钮逐字未改', () => {
  // 商家订单页的文案表住在页面脚本里（顶层调用 `Page()`，Node 无法加载），
  // 所以「售卖链路一行不改」只能用源码断言守。这里的断言刻意**连 `const` 声明
  // 一起匹配**：只匹配 `{ PAID:'确认履约', ... }` 的话，注释里写一遍也能满足，
  // 等于用注释喂断言。
  const pageScript = fs.readFileSync(path.join(miniappDirectory, 'pages', 'merchant', 'orders.js'), 'utf8');
  const pageTemplate = fs.readFileSync(path.join(miniappDirectory, 'pages', 'merchant', 'orders.wxml'), 'utf8');

  assert.ok(
    pageScript.includes("const nextSteps = { PAID:'确认履约', FULFILLING:'核验交付码并完成配送', COMPLETED:'已交付', CANCELLED:'已关闭' };"),
    '售卖「下一步」文案表必须逐字保留'
  );
  assert.ok(
    pageScript.includes("const statusLabels = { PAID: '待发货', FULFILLING: '履约中', COMPLETED: '已完成', CANCELLED: '已取消', AFTER_SALE: '售后中', PARTIALLY_REFUNDED: '部分退款' };"),
    '售卖状态标签表必须逐字保留'
  );

  // 两个售卖按钮的条件与文案同样逐字未改。
  assert.ok(
    pageTemplate.includes('<button wx:if="{{item.status === \'PAID\'}}" size="mini" class="ghost-button" data-id="{{item.id}}" data-status="FULFILLING" bindtap="update">开始履约</button>'),
    '售卖「开始履约」按钮必须逐字保留'
  );
  assert.ok(
    pageTemplate.includes('<button wx:if="{{item.status === \'FULFILLING\'}}" size="mini" class="primary-button" data-id="{{item.id}}" data-status="COMPLETED" bindtap="update">完成</button>'),
    '售卖「完成」按钮必须逐字保留'
  );
});

test('T40：商家端「核验归还」入口已接线（条件 / 动作 / 备注兜底）', () => {
  const pageScript = fs.readFileSync(path.join(miniappDirectory, 'pages', 'merchant', 'orders.js'), 'utf8');
  const pageTemplate = fs.readFileSync(path.join(miniappDirectory, 'pages', 'merchant', 'orders.wxml'), 'utf8');

  // 模板：按钮由纯函数产出的 `canVerifyReturn` 驱动，不把判定散落在 WXML 里。
  assert.ok(
    pageTemplate.includes('<button wx:if="{{item.canVerifyReturn}}" size="mini" class="primary-button" data-id="{{item.id}}" bindtap="verifyReturn">核验归还</button>'),
    '「核验归还」按钮必须由 canVerifyReturn 驱动'
  );

  // 脚本：判定与文案都来自纯函数模块（可被运行时断言），不在页面里重写一遍。
  assert.ok(
    pageScript.includes('canVerifyReturn: rentalJourney.canVerifyRentalReturn(order),'),
    '按钮条件必须调用纯函数 canVerifyRentalReturn'
  );
  assert.ok(
    pageScript.includes('nextStep: rentalJourney.merchantRentalNextStep(order) || nextSteps[order.status] || \'等待更新\','),
    '租赁文案必须来自纯函数，售卖回落到原表'
  );

  // 动作：走既有协同入口，不新开端点。
  assert.ok(pageScript.includes("action: 'RETURN_VERIFY'"), '必须提交 RETURN_VERIFY 动作');
  assert.ok(pageScript.includes("role: 'MERCHANT'"), '必须以商家身份提交');
  assert.ok(
    pageScript.includes("const DEFAULT_RETURN_VERIFY_NOTE = '归还核验通过';"),
    '备注兜底常量必须存在'
  );
  assert.ok(
    pageScript.includes('const note = (res.content || \'\').trim() || DEFAULT_RETURN_VERIFY_NOTE;'),
    '服务端 requireString(note) 要求非空，留空时必须兜底'
  );
});

/**
 * 静默失败修复第一批（merchant/index + card）。
 *
 * 为什么需要源码级护栏：页面脚本在顶层调用 `Page()`，Node 里无法真实执行，
 * 因此「页面确实用了共享工具 / 每块都有可见错误态与重试入口」只能用源码断言守住。
 * 三态工具本身的运行时行为由 `test/miniapp-runtime.test.js` 覆盖。
 */
test('静默失败修复：merchant/card 不再有空 catch，每块都有可见错误态与重试入口', () => {
  // 空格容错：`}).catch(()=>{});` 与 `}).catch(() => {});` 都要被逮住。
  const emptyCatch = /catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/;

  const pages = [
    {
      name: '商家工作台',
      js: path.join('pages', 'merchant', 'index.js'),
      wxml: path.join('pages', 'merchant', 'index.wxml'),
      retries: ['retryNotifications', 'retryMessageSubscriptions', 'retryMessageTemplates', 'retryRevenueTrend', 'retryStatement']
    },
    {
      name: '校园电话卡',
      js: path.join('pages', 'card', 'card.js'),
      wxml: path.join('pages', 'card', 'card.wxml'),
      retries: ['retryPlans', 'retryPromos', 'retryBusinessConfig']
    }
  ];

  for (const page of pages) {
    const source = readMiniappFile(page.js);
    const markup = readMiniappFile(page.wxml);

    assert.equal(emptyCatch.test(source), false, `${page.name}（${page.js}）不得再出现空 catch`);
    assert.ok(source.includes('utils/load-state'), `${page.name} 应使用共享的三态工具`);
    assert.ok(source.includes('loadState.loadBlock('), `${page.name} 应通过 loadBlock 写块状态`);

    for (const handler of page.retries) {
      assert.ok(source.includes(`${handler}()`), `${page.name} 应提供 ${handler} 重试入口`);
      assert.ok(markup.includes(`bindtap="${handler}"`), `${page.wxml} 应把 ${handler} 绑到错误占位`);
    }
    assert.ok(markup.includes('load-error'), `${page.name} 的错误占位应有独立样式类`);
    assert.ok(readMiniappFile(page.wxml.replace(/wxml$/, 'wxss')).includes('.load-error'), `${page.name} 的 wxss 应定义 .load-error`);
  }

  // `Promise.all(...)` 上那个把 5 个块的失败合并成一次静默的 catch 必须消失。
  const merchantSource = readMiniappFile(path.join('pages', 'merchant', 'index.js'));
  assert.equal(
    merchantSource.includes(']).catch('),
    false,
    'merchant 的 Promise.all 不得再挂 catch —— 每块自己持有 error，失败不再被吞'
  );

  // 两个区块的错误态必须互相独立：各自有独立的状态键。
  const cardSource = readMiniappFile(path.join('pages', 'card', 'card.js'));
  for (const key of ['plansBlock', 'promosBlock']) {
    assert.ok(cardSource.includes(`${key}: loadState.initialBlock()`), `card 的 ${key} 必须独立初始化`);
  }
});

/**
 * 静默失败修复第二批：5 个「失败时显示空列表」的页面。
 *
 * 运行时行为由 `test/miniapp-page-blocks.test.js` 覆盖（它直接调用重试函数）；
 * 这里守的是运行时测不到的两件事：**wxml 有没有把重试函数绑上**、
 * **空态有没有同时排除「加载中」与「失败」**。
 *
 * 后者是本批的核心：改造前失败时页面显示「还没有帖子 / 暂时没有闲置」——
 * 那是在向用户断言一个假事实。只要空态的 `wx:if` 少写一个 `!xxx.error`，
 * 这个误导就会回来，所以必须逐页钉死。
 */
test('静默失败修复第二批：5 个列表页的空态必须同时排除「加载中」与「失败」', () => {
  const emptyCatch = /catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/;

  const pages = [
    {
      name: '论坛', directory: 'forum', retry: 'retryPosts', key: 'postsBlock',
      // 空态：不在加载 且 没有错误 且 列表为空 —— 三个条件缺一不可
      guard: '!postsBlock.loading && !postsBlock.error && !filtered.length'
    },
    {
      name: '市集', directory: 'market', retry: 'retryItems', key: 'itemsBlock',
      guard: '!itemsBlock.loading && !itemsBlock.error && !filtered.length'
    },
    {
      name: '足迹', directory: 'footprints', retry: 'retryFootprints', key: 'footprintsBlock',
      guard: '!footprintsBlock.data.length && !footprintsBlock.error'
    },
    {
      name: '评价', directory: 'reviews', retry: 'retryReviews', key: 'reviewsBlock',
      guard: '!reviewsBlock.data.length && !reviewsBlock.error'
    },
    {
      name: '收藏', directory: 'favorites', retry: 'retryFavorites', key: 'favoritesBlock',
      guard: '!favoritesBlock.data.length && !favoritesBlock.error'
    }
  ];

  for (const page of pages) {
    const base = path.join('pages', page.directory, page.directory);
    const source = readMiniappFile(`${base}.js`);
    const markup = readMiniappFile(`${base}.wxml`);
    const styles = readMiniappFile(`${base}.wxss`);

    assert.equal(emptyCatch.test(source), false, `${page.name}（${page.directory}.js）不得再出现空 catch`);
    assert.ok(source.includes('utils/load-state'), `${page.name} 应复用共享的三态工具`);
    assert.ok(
      source.includes('loadState.initialListBlock()'),
      `${page.name} 的列表块必须用 initialListBlock（保证 data 始终是数组，失败不会被误判成空态）`
    );
    assert.ok(source.includes(`${page.retry}()`), `${page.name} 应提供 ${page.retry} 重试入口`);
    assert.ok(markup.includes(`bindtap="${page.retry}"`), `${page.name} 的 wxml 应把 ${page.retry} 绑到错误占位`);
    assert.ok(markup.includes(`${page.key}.error`), `${page.name} 的 wxml 应渲染 ${page.key}.error`);
    assert.ok(markup.includes('load-error'), `${page.name} 应有错误占位`);
    assert.ok(styles.includes('.load-error'), `${page.name} 的 wxss 应定义 .load-error`);
    assert.ok(
      markup.includes(page.guard),
      `${page.name} 的空态条件必须同时排除「加载中」与「失败」：缺一个就会把「没取到」说成「确实没有」`
    );
  }
});

test('★ 全仓不变量：miniprogram 下不存在任何空 catch', () => {
  // 两类空 catch 都必须拦住，缺一类就会留下一整片沉默失败的盲区。
  //
  // ① promise 式 `.catch(() => {})`
  // 空格容错：`}).catch(()=>{});`（plate.js:28 那种无空格写法）也必须命中。
  const promiseEmptyCatch = /catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/;
  //
  // ② try/catch 式 `catch (e) {}` —— 块内只有空白即算空块。
  // - `\s*` 含换行，故单行 `catch (e) {}` 与多行 `catch (e) {\n}` 都会命中；
  // - 块内只要有**一行注释**就不再算空块 —— 这正是「显式声明可忽略」的形式；
  // - 可选参数组兼顾 `catch {}`（optional catch binding）；
  // - 该正则不会误命中 `.catch(() => {})`：`() => ` 之后不是 `{`，回溯后仍不匹配。
  const tryEmptyCatch = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g;

  const files = listMiniappFiles();
  // 必须遍历**全部** miniprogram JS 文件，不能只查改动过的 ——
  // 否则将来任何一处新写的空 catch 都不会被这条断言拦住。
  assert.ok(files.length >= 46, `应遍历全部 miniprogram JS 文件，实得 ${files.length} 个`);

  const promiseOffenders = files
    .filter((file) => promiseEmptyCatch.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(miniappDirectory, file));
  assert.deepEqual(
    promiseOffenders, [],
    `空 catch 会让失败彻底沉默（无提示、无重试）。要么改成三态（loadBlock + 错误占位 + 重试），`
    + `要么写成 .catch(ignoreSilently) 并紧跟一行注释说明理由。违规文件：${promiseOffenders.join(', ')}`
  );

  // try/catch 型同理不允许「无声忽略」。同步 storage 这类调用失败时不影响主流程，
  // 但**必须在块内写明为什么忽略是安全的** —— 与 ignoreSilently 同一原则：
  // 忽略可以是正确的决定，但必须是**显式的**决定。
  // 用 `match` 而不是带 g 的 `test` 逐个调用：`test` 在 /g 下会保留 lastIndex，
  // 连续调用同一正则会出现真假交替（同一类「判据写错导致假通过」的坑）。
  const tryOffenders = files
    .map((file) => ({
      file: path.relative(miniappDirectory, file),
      count: (fs.readFileSync(file, 'utf8').match(tryEmptyCatch) || []).length
    }))
    .filter((item) => item.count > 0)
    .map((item) => `${item.file}（${item.count} 处）`);
  assert.deepEqual(
    tryOffenders, [],
    `try/catch 空块同样会让失败彻底沉默。若忽略是安全的（例如存储写入失败不应阻断主流程），`
    + `请在 catch 块内写一行注释说明理由；否则应改为三态（错误占位 + 重试）。`
    + `违规文件：${tryOffenders.join(', ')}`
  );
});

test('第三批：11 处显式忽略（配置加载 / 动作类）必须走 ignoreSilently 而不是内联空函数', () => {
  const emptyCatch = /catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/;
  // 8 处配置加载：`loadBusinessConfig` 内部已用缓存/默认值兜底、永不 reject；
  // 3 处动作类：上报已读 / 记录足迹 / 保存常用地址 —— 失败不影响用户可见内容。
  const sites = [
    { file: path.join('pages', 'profile', 'profile.js'), why: '配置加载 + 上报已读（动作）' },
    { file: path.join('pages', 'plate', 'plate.js'), why: '配置加载' },
    { file: path.join('pages', 'orders', 'orders.js'), why: '配置加载' },
    { file: path.join('pages', 'edit-order', 'edit-order.js'), why: '配置加载（配送时段，主加载已兜底）' },
    { file: path.join('pages', 'detail', 'detail.js'), why: '记录足迹（动作）' },
    { file: path.join('pages', 'consult', 'consult.js'), why: '配置加载' },
    { file: path.join('pages', 'checkout', 'checkout.js'), why: '保存常用地址（动作）' },
    { file: path.join('pages', 'agreement', 'agreement.js'), why: '配置加载' },
    { file: path.join('pages', 'aftersales', 'aftersales.js'), why: '配置加载' },
    { file: path.join('pages', 'addresses', 'addresses.js'), why: '配置加载' }
  ];
  for (const site of sites) {
    const source = readMiniappFile(site.file);
    assert.ok(
      source.includes('loadState.ignoreSilently'),
      `${site.file}（${site.why}）的失败必须显式声明可忽略，写成 .catch(loadState.ignoreSilently)`
    );
    assert.equal(emptyCatch.test(source), false, `${site.file} 不得再出现空 catch`);
    assert.ok(
      source.includes("require('../../utils/load-state')") || source.includes('require("../../utils/load-state")'),
      `${site.file} 应引入共享工具 load-state`
    );
  }
});

test('第三批：plate 申请状态是加载类，必须三态化（块 + 错误占位 + 重试）', () => {
  const source = readMiniappFile(path.join('pages', 'plate', 'plate.js'));
  const markup = readMiniappFile(path.join('pages', 'plate', 'plate.wxml'));
  const styles = readMiniappFile(path.join('pages', 'plate', 'plate.wxss'));

  assert.ok(source.includes('loadState.loadBlock('), 'plate 状态加载应复用 loadBlock');
  assert.ok(
    source.includes('statusBlock:loadState.initialBlock()'),
    'plate 应使用 statusBlock 三态块（改造前失败时 status 停在 null，会把「没取到」渲染成「还没申请」）'
  );
  assert.ok(source.includes('retryStatus()'), 'plate 应提供 retryStatus 重试入口');
  assert.ok(markup.includes('bindtap="retryStatus"'), 'plate.wxml 应把 retryStatus 绑到错误占位');
  assert.ok(markup.includes('statusBlock.error'), 'plate.wxml 应渲染 statusBlock.error');
  assert.ok(markup.includes('statusBlock.loading'), 'plate.wxml 应渲染加载态');
  assert.ok(styles.includes('.load-error'), 'plate.wxss 应定义 .load-error');
});

test('第四批：orders / addresses / aftersales 的加载失败必须「保留 + 错误占位 + 重试」', () => {
  const emptyCatch = /catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/;
  // 三处原本是「非空 catch 但同样误导」：清空数据 + 一闪而过的 toast，或干脆无提示。
  const pages = [
    {
      name: '订单', directory: 'orders', retry: 'retryRecords', errorKey: 'recordsError',
      guard: '!loading && !recordsError && filtered.length === 0'
    },
    {
      name: '地址', directory: 'addresses', retry: 'retryAddresses', errorKey: 'addressesError',
      guard: '!loading && !addressesError && !addresses.length'
    },
    {
      name: '售后', directory: 'aftersales', retry: 'retryContext', errorKey: 'contextError',
      guard: '!loading && !contextError'
    }
  ];
  for (const page of pages) {
    const base = path.join('pages', page.directory, page.directory);
    const source = readMiniappFile(`${base}.js`);
    const markup = readMiniappFile(`${base}.wxml`);
    const styles = readMiniappFile(`${base}.wxss`);

    assert.equal(emptyCatch.test(source), false, `${page.name}（${page.directory}.js）不得再出现空 catch`);
    assert.ok(source.includes(page.errorKey), `${page.name} 应有 ${page.errorKey} 错误字段`);
    assert.ok(
      source.includes('loadState.blockErrorText('),
      `${page.name} 的错误文案应复用 loadState.blockErrorText（截断 + 兜底）`
    );
    assert.ok(source.includes(`${page.retry}()`), `${page.name} 应提供 ${page.retry} 重试入口`);
    assert.ok(markup.includes(`bindtap="${page.retry}"`), `${page.name} 的 wxml 应把 ${page.retry} 绑到错误占位`);
    assert.ok(markup.includes(page.errorKey), `${page.name} 的 wxml 应渲染 ${page.errorKey}`);
    assert.ok(markup.includes('load-error'), `${page.name} 应有错误占位`);
    assert.ok(styles.includes('.load-error'), `${page.name} 的 wxss 应定义 .load-error`);
    assert.ok(
      markup.includes(page.guard),
      `${page.name} 的空态条件必须排除「失败」：否则失败时会把「没取到」说成「确实没有」`
    );
  }
});

test('M3-P1-05：待支付倒计时分级高亮已接线（纯函数模块 / 紧急类 / 动态节奏 / 租赁不动）', () => {
  const js = readMiniappFile(path.join('pages', 'orders', 'orders.js'));
  const wxml = readMiniappFile(path.join('pages', 'orders', 'orders.wxml'));
  const styles = readMiniappFile(path.join('pages', 'orders', 'orders.wxss'));
  const cardSource = readMiniappFile(path.join('utils', 'order-card.js'));
  const formatSource = readMiniappFile(path.join('utils', 'format.js'));

  // 一、分级逻辑必须住在纯函数模块里（可被 test/miniapp-runtime.test.js 运行时断言），
  //     而不是埋在页面脚本 —— 页面脚本顶层调用 `Page()`，Node 无法加载。
  assert.ok(formatSource.includes('function paymentCountdownText('), 'format.js 应提供 paymentCountdownText');
  assert.ok(formatSource.includes('function isPaymentUrgent('), 'format.js 应提供 isPaymentUrgent');
  assert.ok(formatSource.includes('function isPaymentExpired('), 'format.js 应提供 isPaymentExpired');
  assert.equal(js.includes('function paymentCountdownText('), false, '订单页不得再自带倒计时文案实现（已抽到 format.js）');
  assert.equal(js.includes('function isPaymentExpired('), false, '订单页不得再自带超时判定实现（已抽到 format.js）');
  assert.equal(js.includes('function card('), false, '订单页不得再自带卡片装饰实现（已抽到 order-card.js）');
  assert.ok(js.includes("require('../../utils/format')"), '订单页应引入 format.js');
  assert.ok(js.includes("require('../../utils/order-card')"), '订单页应引入 order-card.js');
  assert.ok(js.includes('orderCard.card'), '订单页应通过 order-card.js 的 card() 装饰记录');
  assert.ok(cardSource.includes('countdownUrgent'), 'order-card.js 应为卡片写入 countdownUrgent');

  // 二、模板接线：紧急类必须绑到倒计时容器上（只在 JS 里算出字段、模板不绑定等于没做）。
  assert.ok(wxml.includes("item.countdownUrgent ? 'countdown-urgent' : ''"), 'orders.wxml 应把 countdown-urgent 绑到倒计时容器');
  assert.ok(styles.includes('.countdown-urgent'), 'orders.wxss 应定义 .countdown-urgent');

  // 三、动态节奏：紧急 1000ms / 常态 30000ms；重建必须先 clear 再 set（否则定时器累积）。
  assert.ok(js.includes('COUNTDOWN_INTERVAL_URGENT = 1000'), '订单页应声明紧急间隔 1000ms');
  assert.ok(js.includes('COUNTDOWN_INTERVAL_IDLE = 30000'), '订单页应声明常态间隔 30000ms');
  assert.ok(js.includes('countdownIntervalFor()'), '订单页应提供「按紧迫度算间隔」的方法');
  assert.ok(js.includes('rebuildCountdownTimer()'), '订单页应提供重建定时器的方法');
  assert.match(
    js, /clearInterval\(this\.countdownTimer\)[\s\S]*setInterval\(/,
    '★ 重建必须先 clearInterval 再 setInterval，否则每重建一次就多一条走秒链'
  );

  // 四、租赁倒计时（T39 的产物）一行未动 —— 本批只加待支付的分级高亮。
  assert.ok(wxml.includes('item.rentalCountdownText'), '租赁应还倒计时文案不得改动');
  assert.ok(wxml.includes('rental-countdown'), '租赁倒计时容器不得改动');
  assert.ok(wxml.includes("item.rentalOverdue ? 'overdue' : ''"), '租赁逾期类不得改动');
  assert.ok(styles.includes('.rental-countdown.overdue'), '租赁逾期样式不得改动');
});

test('M1-P1-02：市集是第 5 个 tabBar 项（只追加，地图项位置不动）', () => {
  const appConfig = JSON.parse(readMiniappFile('app.json'));
  const list = appConfig.tabBar?.list || [];

  // ② 追加第 5 项，内容正确。
  assert.equal(list.length, 5, 'tabBar 应有 5 项（第 5 项是市集）');
  assert.equal(list[4].pagePath, 'pages/market/market', '第 5 项的 pagePath 应是市集');
  assert.equal(list[4].text, '市集', '第 5 项的文案应是「市集」');

  // ③ ★ 地图项必须仍在且位置未变 —— 本次只允许「追加一项」，不得删除/重排。
  assert.equal(list[1].pagePath, 'pages/map/map', '★ 地图必须仍是第 2 项（本次只允许追加，不得重排）');
  assert.equal(list[1].text, '地图', '★ 地图文案不得改动');
  assert.deepEqual(
    list.slice(0, 4).map((item) => item.pagePath),
    ['pages/home/home', 'pages/map/map', 'pages/orders/orders', 'pages/profile/profile'],
    '★ 原有 4 项的顺序与内容必须逐字不变'
  );

  // 定位相关声明一律不动（PRD 硬约束）。
  assert.deepEqual(appConfig.requiredPrivateInfos, ['getLocation'], 'requiredPrivateInfos 不得改动');
  assert.ok(
    appConfig.permission['scope.userLocation'].desc.includes('校园地图'),
    'scope.userLocation 的说明不得改动'
  );

  // 既有 4 项都没有 iconPath —— 第 5 项保持一致，不为它新增二进制图标资源。
  assert.equal(
    list.every((item) => item.iconPath === undefined && item.selectedIconPath === undefined),
    true,
    'tabBar 项一律不带图标（与既有 4 项一致，避免为此新增二进制资源）'
  );

  // 首页跳市集必须走 openLink（tabBar 页用 navigateTo 会失败）。
  const homeJs = readMiniappFile(path.join('pages', 'home', 'home.js'));
  assert.match(
    homeJs, /goMarket\(\)\s*\{\s*openLink\(["']\/pages\/market\/market["']\)/,
    '首页 goMarket 应改走 openLink'
  );

  // 首页价格失败时必须给出可见重试入口（T18 ①②③ 的产物，作回归）。
  const homeWxml = readMiniappFile(path.join('pages', 'home', 'home.wxml'));
  assert.ok(homeWxml.includes('价格加载失败，点击重试'), '首页价格失败时应给出重试文案');
  assert.ok(homeWxml.includes('catchtap="reloadCatalog"'), '重试入口应绑 reloadCatalog 且阻止冒泡');
  assert.ok(homeWxml.includes('scooterFromPrice !== null'), '车辆价格必须只在有真值时展示');
  assert.ok(homeWxml.includes('phoneFromPrice !== null'), '电话卡价格必须只在有真值时展示');

  // 首页通往市集的唯一入口是 market-banner（`bindtap="goMarket"`），本次改的是它的**实现**
  // （改走 openLink），入口本身必须保留。
  assert.ok(homeWxml.includes('bindtap="goMarket"'), '首页市集 banner 入口应保留');

  // 市集页自身的「去逛论坛」入口不得被本次改动波及。
  // 说明：T18 ⑧ 把该按钮记作 `home.wxml` 的「逛论坛」次级按钮，实际它在 `market.wxml:52`
  // （文案为「去逛论坛」，`bindtap` 而非 `catchtap`；`home.wxml` 里没有任何论坛入口）。
  // 这里按**真实位置**断言，并顺带锁住它的跳转目标。
  const marketWxml = readMiniappFile(path.join('pages', 'market', 'market.wxml'));
  assert.ok(marketWxml.includes('bindtap="goForum"'), '市集空态的「去逛论坛」入口应保留');
  const marketJs = readMiniappFile(path.join('pages', 'market', 'market.js'));
  assert.match(
    marketJs, /goForum\(\)\s*\{\s*wx\.navigateTo\(\{\s*url:\s*['"]\/pages\/forum\/forum['"]\s*\}\s*\)/,
    'forum 不是 tabBar 页，「去逛论坛」仍应走 navigateTo'
  );
});

test('M3-P2-01：图片读取只有 utils/upload.js 一处，7 个页面全部改为调用它', () => {
  const files = listMiniappFiles();

  // ---------- ⑥ `readFile({filePath: file.tempFilePath` 只出现在 utils/upload.js ----------
  // ★ 不能用不带空白容错的字面串：改造前的写法是
  //     wx.getFileSystemManager().readFile({
  //       filePath: file.tempFilePath,
  //   `{` 与 `filePath` 之间本来就隔着换行，那个字面串在改造前也是 0 次命中。
  //   必须让正则容忍空白，否则这条断言会「恒真」，等于没断言。
  const readFilePattern = /readFile\(\s*\{\s*filePath:\s*file\.tempFilePath/g;
  const readFileHits = files
    .map((file) => ({
      file: path.relative(miniappDirectory, file).split(path.sep).join('/'),
      count: (fs.readFileSync(file, 'utf8').match(readFilePattern) || []).length
    }))
    .filter((item) => item.count > 0);
  assert.deepEqual(
    readFileHits,
    [{ file: 'utils/upload.js', count: 1 }],
    '★ 图片读取必须收敛到唯一一处，且只在 utils/upload.js —— 散落 9 处时服务端白名单一变必然漏改'
  );

  // ---------- ⑧ 页面里不得再出现裸 `getFileSystemManager().readFile` ----------
  const pages = files.filter((file) => file.split(path.sep).includes('pages'));
  assert.ok(pages.length >= 30, '应遍历到页面文件（当前 32 个），实得 ' + pages.length + ' 个');
  const offenders = pages
    .filter((file) => /getFileSystemManager\(\)\s*\.\s*readFile/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(miniappDirectory, file));
  assert.deepEqual(
    offenders, [],
    '以下页面仍在自己调 readFile，应改为 require utils/upload：' + offenders.join(', ')
  );

  // ---------- ⑧ 7 个页面逐个断言确实接上了 utils/upload.js ----------
  // 调用次数与原 readFile 处数一一对应（合计 9 处），少一处就说明有页面漏改。
  const wired = [
    { file: path.join('pages', 'aftersales', 'aftersales.js'), calls: 1 },
    { file: path.join('pages', 'forum', 'publish.js'), calls: 1 },
    { file: path.join('pages', 'market', 'publish.js'), calls: 1 },
    { file: path.join('pages', 'merchant', 'apply.js'), calls: 1 },
    { file: path.join('pages', 'merchant', 'index.js'), calls: 2 },
    { file: path.join('pages', 'merchant', 'products.js'), calls: 1 },
    { file: path.join('pages', 'orders', 'orders.js'), calls: 2 }
  ];
  let totalCalls = 0;
  for (const entry of wired) {
    const source = readMiniappFile(entry.file);
    assert.match(
      source, /require\(['"][^'"]*utils\/upload['"]\)/,
      entry.file + ' 应 require utils/upload'
    );
    // 空白容错：允许 `upload .uploadImage(` / 换行后接 `.uploadImage(`，
    // 否则换个排版这条断言会静默少算。
    const calls = (source.match(/upload\s*\.\s*(uploadImage|readImagePayload)\s*\(/g) || []).length;
    assert.equal(calls, entry.calls, entry.file + ' 应调用 ' + entry.calls + ' 次 utils/upload（实得 ' + calls + '）');
    totalCalls += calls;
  }
  assert.equal(totalCalls, 9, '★ 7 个页面合计应有 9 处调用，与改造前 9 处 readFile 一一对应');
});

test('M7-P1-01：帖子详情页的隐藏/恢复按钮只对作者渲染（模板守卫）', () => {
  const wxml = readMiniappFile(path.join('pages', 'forum', 'post.wxml'));
  const js = readMiniappFile(path.join('pages', 'forum', 'post.js'));

  // ★ 结构性断言，不是「文件里出现过 post.isOwner」那种子串断言。
  //
  // 子串断言的问题是：把 `wx:if` 从按钮上挪走、或**新加一个没带守卫的按钮**，
  // 它照样绿。所以这里先按 `bindtap="toggleVisibility"` 定位到那一个元素，
  // 再检查**同一个元素的开标签**上是否带着守卫。
  const marker = 'bindtap="toggleVisibility"';
  const occurrences = wxml.split(marker).length - 1;
  assert.equal(
    occurrences, 1,
    '★ 隐藏/恢复按钮应当只有一个 —— 多出来的那个极可能没带 isOwner 守卫，'
    + '会让所有访客都看到「隐藏」按钮（点了才拿 403）'
  );

  const markerIndex = wxml.indexOf(marker);
  const elementStart = wxml.lastIndexOf('<button', markerIndex);
  assert.ok(elementStart !== -1, '★ 应能在 wxml 里定位到按钮的开标签');
  const tagEnd = wxml.indexOf('>', markerIndex);
  const openingTag = wxml.slice(elementStart, tagEnd + 1);

  assert.ok(
    openingTag.includes('wx:if="{{post.isOwner}}"'),
    '★ 按钮必须被 wx:if="{{post.isOwner}}" 守住。注意不能只写 `post.isOwner`：'
    + '服务端对 `authorId` 为 null/undefined 的脏数据必须判成「非作者」，'
    + '前端这条守卫与它一一对应。实得开标签：' + openingTag
  );
  assert.ok(
    openingTag.includes('disabled="{{togglingStatus}}"'),
    '★ 按钮在请求进行中必须禁用（与 toggleVisibility 里的 togglingStatus 守卫配套，防重复提交）'
  );
  // 文案在**元素体**里，不在开标签上 —— 第一次写这条断言时我把它挂在了
  // `openingTag` 上，于是它必然为假（断言自测当场逮住了这个写法错误，
  // 而不是被测代码的错误）。
  const elementEnd = wxml.indexOf('</button>', tagEnd);
  assert.ok(elementEnd !== -1, '★ 应能定位到按钮的闭标签');
  const elementText = wxml.slice(tagEnd + 1, elementEnd);
  assert.ok(
    elementText.includes("'恢复帖子'") && elementText.includes("'隐藏帖子'"),
    '★ 按钮文案必须随当前状态切换（隐藏态显示「恢复帖子」，否则用户看不出它现在会做什么）。'
    + '实得元素体：' + elementText
  );

  // 作者看到自己的隐藏帖时必须有常驻说明，否则他会以为帖子还在正常展示。
  assert.ok(
    wxml.includes("wx:if=\"{{post.isOwner && post.status === 'HIDDEN'}}\""),
    '★ 作者打开自己的隐藏帖时必须给出常驻提示（不是 toast），说明只有他自己能看到'
  );

  // ★★ 状态词汇守卫：`ACTIVE` 只用于市集商品，论坛帖是 PUBLISHED / HIDDEN。
  // 四处读取（列表 / 详情 / 点赞 / 评论）都判 `=== 'PUBLISHED'`，
  // 一旦把「恢复」写成 ACTIVE，帖子会对**所有人**永久消失且没有任何测试会发现。
  assert.equal(
    js.includes("'ACTIVE'") || js.includes('"ACTIVE"'), false,
    '★★ post.js 不得出现 ACTIVE —— 论坛帖的可见状态只有 PUBLISHED / HIDDEN'
  );
  // 运行时的真正防线在上一条用例里（断言实际发出的请求体），这里只挡住「写错词」。
  assert.ok(
    js.includes("'PUBLISHED'") && js.includes("'HIDDEN'"),
    '★ post.js 必须使用既有词汇 PUBLISHED / HIDDEN'
  );
});

test('M7-P1-01：「我的帖子」已注册，profile 有入口，且 tabBar 仍是 5 项', () => {
  const appConfig = JSON.parse(readMiniappFile('app.json'));
  const profileJs = readMiniappFile(path.join('pages', 'profile', 'profile.js'));
  const profileWxml = readMiniappFile(path.join('pages', 'profile', 'profile.wxml'));

  // ==================== ⑩ 页面注册 ====================
  assert.ok(
    appConfig.pages.includes('pages/forum/mine'),
    '⑩ ★ 「我的帖子」必须在 app.json 里注册（否则跳过去是空白页）'
  );
  for (const extension of ['js', 'wxml', 'json', 'wxss']) {
    const file = path.join(miniappDirectory, 'pages', 'forum', `mine.${extension}`);
    assert.ok(fs.existsSync(file), `⑩ ★ pages/forum/mine.${extension} 必须存在`);
  }

  // ==================== ⑩ tabBar 不得被打断 ====================
  const tabBarList = appConfig.tabBar?.list || [];
  assert.equal(
    tabBarList.length, 5,
    '⑩ ★★ tabBar 必须仍是 5 项 —— 「我的帖子」是新页面，不是新的 tab'
  );
  assert.deepEqual(
    tabBarList.map((item) => item.pagePath),
    ['pages/home/home', 'pages/map/map', 'pages/orders/orders', 'pages/profile/profile', 'pages/market/market'],
    '⑩ ★★ tabBar 的项与顺序都不得被这次改动影响'
  );

  // ==================== ⑩ 地图隐私配置不得被碰到 ====================
  assert.deepEqual(
    appConfig.requiredPrivateInfos, ['getLocation'],
    '⑩ ★ requiredPrivateInfos 必须原样（绝对禁区）'
  );
  assert.equal(
    appConfig.permission?.['scope.userLocation']?.desc,
    '用于在校园地图中辅助你确认当前位置附近的建筑和路线。',
    '⑩ ★ scope.userLocation 的说明文案必须原样（绝对禁区）'
  );

  // ==================== ⑩ profile 入口 ====================
  assert.ok(profileJs.includes('goMyForumPosts'), '⑩ 「我的帖子」入口必须在 profile.js 里');
  assert.ok(profileWxml.includes('bindtap="goMyForumPosts"'), '⑩ 「我的帖子」菜单项必须在 profile.wxml 里绑定');
  // 走 openLink 而不是裸 wx.navigateTo：站内跳转统一由它分发（tabBar 页要 switchTab、
  // 失败要提示而不是静默）。这里断言的是**接线**，不是字面串。
  assert.match(
    profileJs, /goMyForumPosts\s*\(\s*\)\s*\{\s*openLink\(/,
    '⑩ ★ goMyForumPosts 必须走 openLink（将来该页若变成 tabBar 页，这里不用改）'
  );
});

test('M6-P1-01：「我发布的闲置」已注册，profile 有入口，删除按钮用 catchtap 守卫', () => {
  const appConfig = JSON.parse(readMiniappFile('app.json'));
  const profileJs = readMiniappFile(path.join('pages', 'profile', 'profile.js'));
  const profileWxml = readMiniappFile(path.join('pages', 'profile', 'profile.wxml'));
  const wxml = readMiniappFile(path.join('pages', 'market', 'mine.wxml'));

  // ==================== ⑪ 页面注册 ====================
  assert.ok(
    appConfig.pages.includes('pages/market/mine'),
    '⑪ ★ 「我发布的闲置」必须在 app.json 里注册（否则跳过去是空白页）'
  );
  for (const extension of ['js', 'wxml', 'json', 'wxss']) {
    const file = path.join(miniappDirectory, 'pages', 'market', `mine.${extension}`);
    assert.ok(fs.existsSync(file), `⑪ ★ pages/market/mine.${extension} 必须存在`);
  }

  // ==================== ⑪ tabBar 不得被打断 ====================
  const tabBarList = appConfig.tabBar?.list || [];
  assert.equal(
    tabBarList.length, 5,
    '⑪ ★★ tabBar 必须仍是 5 项 —— 「我发布的闲置」是新页面，不是新的 tab'
  );
  assert.deepEqual(
    tabBarList.map((item) => item.pagePath),
    ['pages/home/home', 'pages/map/map', 'pages/orders/orders', 'pages/profile/profile', 'pages/market/market'],
    '⑪ ★★ tabBar 的项与顺序都不得被这次改动影响'
  );

  // ==================== ⑪ 地图隐私配置不得被碰到 ====================
  assert.deepEqual(
    appConfig.requiredPrivateInfos, ['getLocation'],
    '⑪ ★ requiredPrivateInfos 必须原样（绝对禁区）'
  );
  assert.equal(
    appConfig.permission?.['scope.userLocation']?.desc,
    '用于在校园地图中辅助你确认当前位置附近的建筑和路线。',
    '⑪ ★ scope.userLocation 的说明文案必须原样（绝对禁区）'
  );

  // ==================== ⑪ profile 入口（与「我的帖子」同级） ====================
  assert.ok(profileJs.includes('goMyMarketItems'), '⑪ 「我发布的闲置」入口必须在 profile.js 里');
  assert.ok(profileWxml.includes('bindtap="goMyMarketItems"'), '⑪ 菜单项必须在 profile.wxml 里绑定');
  assert.match(
    profileJs, /goMyMarketItems\s*\(\s*\)\s*\{\s*openLink\(/,
    '⑪ ★ goMyMarketItems 必须走 openLink（与 T26 的 goMyForumPosts 同级、同一种接线）'
  );

  // ==================== ★ 删除按钮的结构性守卫 ====================
  //
  // 这里不写「文件里出现过 deletable」这种子串断言 —— 把 `wx:if` 从按钮上挪走、
  // 或新加一个没带守卫的删除按钮，子串断言照样绿。先按 `catchtap="deleteItem"`
  // 定位到那一个元素，再检查**同一个元素的开标签**上是否带着守卫。
  const marker = 'catchtap="deleteItem"';
  assert.equal(
    wxml.split(marker).length - 1, 1,
    '★ 删除按钮应当只有一个 —— 多出来的那个极可能没带 deletable 守卫'
  );
  // ★★ 必须用 `catchtap` 而不是 `bindtap`：删除按钮在整张卡片
  // （`bindtap="goItem"`）**里面**，`bindtap` 会冒泡 —— 点「删除」会顺带跳进详情页。
  assert.equal(
    wxml.includes('bindtap="deleteItem"'), false,
    '★★ 删除按钮不得用 bindtap：它会冒泡到卡片的 goItem，点「删除」会顺带跳进详情页'
  );

  const markerIndex = wxml.indexOf(marker);
  const elementStart = wxml.lastIndexOf('<button', markerIndex);
  assert.ok(elementStart !== -1, '★ 应能在 wxml 里定位到删除按钮的开标签');
  const tagEnd = wxml.indexOf('>', markerIndex);
  const openingTag = wxml.slice(elementStart, tagEnd + 1);
  assert.ok(
    openingTag.includes('wx:if="{{item.deletable}}"'),
    '★ 删除按钮必须被 `wx:if="{{item.deletable}}"` 守住 —— 已售 / 已删除的条目'
    + '不该出现一个点了必然失败的按钮。实得开标签：' + openingTag
  );
  assert.ok(
    openingTag.includes('data-id="{{item.id}}"'),
    '★ 删除按钮必须带上 `data-id`，否则 deleteItem 拿不到要删哪一条'
  );
  assert.ok(
    openingTag.includes('disabled="{{deletingId === item.id}}"'),
    '★ 删除进行中必须禁用（与 confirmDelete 里的 deletingId 守卫配套，防重复提交）'
  );

  // ==================== ★ 状态必须看得见 ====================
  assert.ok(
    wxml.includes('{{item.statusText}}') && wxml.includes('{{item.statusClass}}'),
    '★ 每条必须渲染状态文案与状态样式 —— 这一页是唯一能看到「已售 / 已删除 / 已下架」的地方'
  );
  // 不可删除时必须说明原因（与 deletable 互斥），而不是把按钮悄悄拿掉。
  assert.ok(
    wxml.includes('{{item.lockedText}}'),
    '★ 不可删除时必须渲染 lockedText 说明原因，否则用户以为页面坏了'
  );
});
