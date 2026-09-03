Page({
  data: { verified: false, customerService: "15527111396" },
  verify() { this.setData({ verified: true }); wx.showToast({ title: "演示认证成功" }); },
  goOrders() { wx.switchTab({ url: "/pages/orders/orders" }); },
  goCard() { wx.navigateTo({ url: "/pages/card/card" }); },
  goMerchant() { wx.navigateTo({ url: "/pages/merchant/index" }); },
  goPlate() { wx.navigateTo({ url: "/pages/plate/plate" }); },
  callService() { wx.makePhoneCall({ phoneNumber: this.data.customerService }); },
  copyWechat() { wx.setClipboardData({ data: this.data.customerService }); }
});
