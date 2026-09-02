const { scooters } = require("../data/mock");

function getScooters() { return scooters; }
function getScooter(id) { return scooters.find(item => item.id === id); }

function createOrder(payload) {
  const orders = wx.getStorageSync("campusGoOrders") || [];
  const order = {
    id: `CG${Date.now().toString().slice(-8)}`,
    createdAt: new Date().toLocaleString(),
    status: "待处理",
    ...payload
  };
  orders.unshift(order);
  wx.setStorageSync("campusGoOrders", orders);
  return order;
}

function getOrders() { return wx.getStorageSync("campusGoOrders") || []; }
function updateOrder(id, patch) {
  const orders = getOrders();
  const index = orders.findIndex(item => item.id === id);
  if (index < 0) return null;
  orders[index] = { ...orders[index], ...patch, updatedAt: new Date().toLocaleString() };
  wx.setStorageSync("campusGoOrders", orders);
  return orders[index];
}

function saveCardApplication(payload) {
  const application = { id: `CARD${Date.now().toString().slice(-6)}`, status: "资料待审核", ...payload };
  wx.setStorageSync("campusCardApplication", application);
  return application;
}

function getCardApplication() { return wx.getStorageSync("campusCardApplication") || null; }

function saveAfterSales(payload) {
  const records = wx.getStorageSync("campusGoAfterSales") || [];
  const record = { id: `AS${Date.now().toString().slice(-6)}`, status: "已提交", ...payload };
  records.unshift(record);
  wx.setStorageSync("campusGoAfterSales", records);
  return record;
}

module.exports = { getScooters, getScooter, createOrder, getOrders, updateOrder, saveCardApplication, getCardApplication, saveAfterSales };
