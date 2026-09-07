const { request } = require('./api');

function requestWeChatPayment(parameters) {
  return new Promise((resolve, reject) => {
    wx.requestPayment({
      timeStamp: parameters.timeStamp,
      nonceStr: parameters.nonceStr,
      package: parameters.package,
      signType: parameters.signType || 'RSA',
      paySign: parameters.paySign,
      success: resolve,
      fail: (error) => reject(new Error(error.errMsg || '微信支付未完成'))
    });
  });
}

async function payPaymentOrder(paymentOrder) {
  if (!paymentOrder?.id) throw new Error('支付单不存在');
  const providerParameters = paymentOrder.providerPayload || paymentOrder.payload;
  if (providerParameters?.paySign) {
    await requestWeChatPayment(providerParameters);
  }
  return request(`/api/payment-orders/${encodeURIComponent(paymentOrder.id)}/confirm`, { method: 'POST' });
}

async function payPaymentOrderById(paymentOrderId) {
  if (!paymentOrderId) throw new Error('支付单不存在');
  const response = await request(`/api/payment-orders/${encodeURIComponent(paymentOrderId)}`);
  return payPaymentOrder(response.data);
}

module.exports = { payPaymentOrder, payPaymentOrderById };
