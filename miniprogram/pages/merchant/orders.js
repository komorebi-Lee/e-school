const { request: apiRequest } = require('../../services/api');

const statusLabels = { PAID: '待发货', FULFILLING: '履约中', COMPLETED: '已完成', CANCELLED: '已取消', AFTER_SALE: '售后中' };
const afterSaleLabels = { SUBMITTED: '待处理', REVIEWING: '处理中', CLOSED: '已完成' };
const afterSaleTypes = { REFUND: '申请退款', RETURN: '退货', REPAIR: '维修' };
const nextSteps = { PAID:'确认履约', FULFILLING:'核验交付码并完成配送', COMPLETED:'已交付', CANCELLED:'已关闭' };
const roleLabels = { USER:'用户', MERCHANT:'商家', PLATFORM:'平台' };

Page({
  data: { orders: [], filtered: [], afterSales: [], metrics: null, filter: 'ALL', filters: [
    { key:'ALL', label:'全部' },
    { key:'PENDING', label:'待履约' },
    { key:'AFTER_SALE', label:'售后' },
    { key:'COMPLETED', label:'已完成' }
  ], loading: true },
  onShow() {
    this.load();
  },

  request(path, options = {}) {
    const token = wx.getStorageSync('campusGoMerchantToken');
    return apiRequest(path, { ...options, header: { authorization: `Bearer ${token}` } });
  },
  load() {
    this.request('/api/merchant/overview').then(({ data }) => {
      const afterSales = (data.afterSales || []).map((record) => ({
        ...record,
        statusLabel: afterSaleLabels[record.status] || record.status,
        typeLabel: afterSaleTypes[record.type] || record.type,
        dueText: String(record.responseDueAt || '').slice(5, 16).replace('T', ' ')
      }));
      const orders = (data.orders || []).map((order) => this.decorateOrder(order, afterSales));
      this.setData({
        orders,
        filtered: this.filterOrders(orders, this.data.filter),
        afterSales,
        metrics: data.metrics || null,
        loading: false
      });
    }).catch(() => {
      this.setData({ loading: false });
      wx.showToast({ title: '请重新进入商家工作台', icon: 'none' });
    });
  },
  setFilter(e) {
    const filter = e.currentTarget.dataset.key || 'ALL';
    this.setData({ filter, filtered: this.filterOrders(this.data.orders, filter) });
  },
  filterOrders(orders, filter) {
    if (filter === 'ALL') return orders;
    if (filter === 'PENDING') return orders.filter((order) => ['PAID', 'FULFILLING'].includes(order.status));
    return orders.filter((order) => order.status === filter);
  },
  decorateOrder(order, afterSales) {
    return {
      ...order,
      statusLabel: statusLabels[order.status] || order.status,
      nextStep: nextSteps[order.status] || '等待更新',
      delivery: order.fulfillment?.type === 'DELIVERY' ? {
        contactName: order.fulfillment.contactName || '未填写',
        contactPhone: order.fulfillment.contactPhone || '未填写',
        date: order.fulfillment.date || '尽快配送',
        address: order.fulfillment.address || '未填写'
      } : null,
      intervention: order.collaboration?.intervention?.status === 'REQUESTED',
      userMessages: (order.collaboration?.messages || []).filter((message)=>message.role==='USER').slice(0,2),
      afterSale: afterSales.find((record) => record.orderId === order.id) || null,
      timeline: (order.collaboration?.handoffs || []).slice(0,4).map((event, index) => ({
        id:index,
        roleLabel: roleLabels[event.role] || '平台',
        note: event.note || '状态已更新',
        timeText: String(event.createdAt || '').replace('T',' ').slice(5,16)
      }))
    };
  },
  updateAfterSale(e) {
    const { id, status } = e.currentTarget.dataset;
    if (status !== 'CLOSED') {
      return this.submitAfterSaleStatus(id, { status });
    }
    wx.showModal({
      title: '填写处理结果',
      editable: true,
      placeholderText: '例如：已上门更换刹车片并试车完成',
      success: ({ confirm, content }) => {
        if (!confirm) return;
        this.submitAfterSaleStatus(id, { status, resolutionNote: (content || '').trim() });
      }
    });
  },
  submitAfterSaleStatus(id, data) {
    return this.request(`/api/merchant/after-sales/${id}/status`, { method: 'POST', data }).then(() => {
      wx.showToast({ title: '售后已更新' });
      this.load();
    }).catch((error) => wx.showToast({ title: error.message || '更新失败', icon: 'none' }));
  },
  update(e) {
    const { id, status } = e.currentTarget.dataset;
    if (status !== 'COMPLETED') {
      return this.submitStatus(id, { status });
    }
    wx.showModal({
      title: '核验交付码',
      editable: true,
      placeholderText: '请向用户确认 6 位交付码',
      success: (res) => {
        if (!res.confirm) return;
        this.submitStatus(id, { status, deliveryCode: (res.content || '').trim() });
      }
    });
  },
  submitStatus(id, data) {
    return this.request(`/api/merchant/orders/${id}/status`, { method: 'POST', data }).then(() => {
      wx.showToast({ title: '订单已更新' });
      this.load();
    }).catch((error) => wx.showToast({ title: error.message || '更新失败', icon: 'none' }));
  },
  collab(e) {
    const { id, action } = e.currentTarget.dataset;
    wx.showModal({
      title: '发送给用户和平台',
      editable: true,
      placeholderText: '例如：车辆已备好，今天下午送至宿舍区。',
      success: (res) => {
        if (!res.confirm) return;
        this.request('/api/order-collab', { method: 'POST', data: { role: 'MERCHANT', orderId: id, action, note: res.content } }).then(() => {
          wx.showToast({ title: '已发送' });
          this.load();
        }).catch((error) => wx.showToast({ title: error.message || '发送失败', icon: 'none' }));
      }
    });
  }
});
