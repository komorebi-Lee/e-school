const { CLOUD_ENV_ID } = require('./config/api');

App({
  globalData: {
    brand: "狮山智生活",
    school: "华中农业大学",
    campus: "狮山校区",
    customerService: "15527111396"
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
    if (!wx.getStorageSync("campusGoOrders")) {
      wx.setStorageSync("campusGoOrders", []);
    }
  }
});
