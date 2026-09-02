const { request, userId } = require('../../services/api');
const { getOrders } = require('../../services/store');
Page({
  data: { orders: [], loading: true },
  onShow() { this.loadOrders(); },
  loadOrders() { request(`/api/orders?userId=${encodeURIComponent(userId())}`).then(({ data }) => this.setData({ orders: data || [], loading: false })).catch(() => this.setData({ orders: getOrders(), loading: false })); },
  afterSales(e) { wx.navigateTo({ url: `/pages/aftersales/aftersales?id=${e.currentTarget.dataset.id}` }); },
  editOrder(e) { wx.navigateTo({ url: `/pages/edit-order/edit-order?id=${e.currentTarget.dataset.id}` }); },
  goShop() { wx.navigateTo({ url: '/pages/scooters/scooters' }); }
});
