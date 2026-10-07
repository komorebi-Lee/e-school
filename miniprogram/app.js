const { CLOUD_ENV_ID } = require('./config/api');
const { FALLBACK_SERVICE_CONTACT } = require('./services/business');

App({
  globalData: {
    brand: "狮山智生活",
    school: "华中农业大学",
    campus: "狮山校区",
    // 客服联系方式的**兜底值**（唯一字面量在 `services/business.js`）。
    // 说明：全仓**没有任何页面读取**本字段 —— 各页面各自用
    // `loadBusinessConfig()` 取服务端权威值。保留该字段只是为了不改变
    // `globalData` 的形状；它**不是**权威值，权威值在服务端 `adminSettings`。
    customerService: FALLBACK_SERVICE_CONTACT
  },
  onLaunch() {
    if (!wx.cloud) {
      console.error("Cloud API is unavailable.");
    } else {
      try {
        wx.cloud.init({ env: CLOUD_ENV_ID, traceUser: true });
      } catch (error) {
        console.error("Cloud init failed:", error);
      }
    }
  }
});
