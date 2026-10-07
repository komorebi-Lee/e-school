// 客服联系方式（电话与微信同号）。
//
// ★ 角色：**仅当配置读取失败时的兜底，不是权威值。**
//   权威值是服务端的 `adminSettings.servicePhone` / `serviceWechat`
//   （`server/src/store.js` 的种子），管理员可通过 `POST /api/admin/settings` 修改。
//   客户端经 `loadBusinessConfig()` → `GET /api/business-config` 取得该权威值，
//   本常量只在「拿不到配置」时兜底。
//
//   因此：**不得**把它当作展示用的权威号码 —— 页面在配置返回前应展示空值，
//   否则管理员改号后，用户会先看到并可能拨到这个已经过期的号。
//   本字面量在整个 `miniprogram/` 里**只允许出现这一次**（由
//   `test/miniapp-service-contact.test.js` 钉住）。
const FALLBACK_SERVICE_CONTACT = '15527111396';

const defaultConfig = {
  brandName: '狮山智生活',
  schoolName: '华中农业大学',
  campusName: '狮山校区',
  servicePhone: FALLBACK_SERVICE_CONTACT,
  serviceWechat: FALLBACK_SERVICE_CONTACT,
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

module.exports = { FALLBACK_SERVICE_CONTACT, loadBusinessConfig, normalizeConfig };
