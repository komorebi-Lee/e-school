const statusLabels = { PAID: '待发货', FULFILLING: '履约中', COMPLETED: '已完成', CANCELLED: '已取消', AFTER_SALE: '售后中' };
const nextSteps = { PAID:'确认履约', FULFILLING:'完成配送', COMPLETED:'等待用户确认', CANCELLED:'已关闭' };

Page({
  data: { orders: [], loading: true },
  onShow() {
    this.load();
  },

  request(path, options = {}) {
    const token = wx.getStorageSync('campusGoMerchantToken');
    return apiRequest(path, { ...options, header: { authorization: `Bearer ${token}` } });
  },
  load() {
    this.request('/api/merchant/overview').then(({ data }) => {
      const orders = data.orders.map((order) => ({
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
        userMessages: (order.collaboration?.messages || []).filter((message)=>message.role==='USER').slice(0,2)
      }));
      this.setData({ orders, loading: false });
    }).catch(() => {
      this.setData({ loading: false });
      wx.showToast({ title: '请重新进入商家工作台', icon: 'none' });
    });
  },
  update(e) {
    const { id, status } = e.currentTarget.dataset;
    this.request(`/api/merchant/orders/${id}/status`, { method: 'POST', data: { status } }).then(() => {
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
        this.request('/api/order-collab', { method: 'POST', data: { role: 'MERCHANT', orderId: id, action, text: res.content } }).then(() => {
          wx.showToast({ title: '已发送' });
          this.load();
        }).catch((error) => wx.showToast({ title: error.message || '发送失败', icon: 'none' }));
      }
    });
  }
});
