const defaultConfig = {
  brandName: '狮山智生活',
  schoolName: '华中农业大学',
  campusName: '狮山校区',
  servicePhone: '15527111396',
  serviceWechat: '15527111396',
  deliveryFeeInCents: 0,
  deliveryResponseHours: 24,
  plateResponseHours: 48,
  externalPlateFeeInCents: 4900,
  leadResponseHours: 24,
  phoneCardActivationHours: 24,
  afterSaleResponseHours: 24,
  afterSaleResolutionHours: 72,
  deliveryTimeSlots: ['尽快配送'],
  platformNotice: '服务范围和办理结果以学校及合作方最终确认为准。'
};

function normalizeConfig(config = {}) {
  return {
    ...defaultConfig,
    ...config,
    deliveryFee: Math.round(((config.deliveryFeeInCents || 0) / 100) * 100) / 100,
    externalPlateFee: Math.round(((config.externalPlateFeeInCents ?? 4900) / 100) * 100) / 100,
    deliveryFeeText: config.deliveryFeeInCents ? `¥${config.deliveryFeeInCents / 100}` : '免费'
  };
}

function loadBusinessConfig() {
  const cached = wx.getStorageSync('shishanBusinessConfig');
  const { request } = require('./api');
  return request('/api/business-config').then(({ data }) => {
    const normalized = normalizeConfig(data);
    wx.setStorageSync('shishanBusinessConfig', normalized);
    return normalized;
  }).catch(() => normalizeConfig(cached || {}));
}

module.exports = { loadBusinessConfig, normalizeConfig };
