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
