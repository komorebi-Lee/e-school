const { request: apiRequest } = require('../../services/api');
const rentalJourney = require('../../utils/rental-journey');
const loadState = require('../../utils/load-state');

const statusLabels = { PAID: '待发货', FULFILLING: '履约中', COMPLETED: '已完成', CANCELLED: '已取消', AFTER_SALE: '售后中', PARTIALLY_REFUNDED: '部分退款' };
const afterSaleLabels = { SUBMITTED: '待处理', REVIEWING: '处理中', CLOSED: '已完成', REJECTED: '未通过' };
const afterSaleTypes = { REFUND: '申请退款', RETURN: '退货', REPAIR: '维修' };
const nextSteps = { PAID:'确认履约', FULFILLING:'核验交付码并完成配送', COMPLETED:'已交付', CANCELLED:'已关闭' };
const roleLabels = { USER:'用户', MERCHANT:'商家', PLATFORM:'平台' };
/** 商家未填写核验备注时的默认值：服务端 `requireString(body.note)` 要求 note 非空。 */
const DEFAULT_RETURN_VERIFY_NOTE = '归还核验通过';

Page({
  data: { orders: [], filtered: [], afterSales: [], metrics: null, filter: 'ALL', focusId: '', filters: [
    { key:'ALL', label:'全部' },
    { key:'PENDING', label:'待履约' },
    { key:'AFTER_SALE', label:'售后' },
    { key:'COMPLETED', label:'已完成' }
  ], loading: true, ordersError: '' },
  onLoad(options = {}) {
    if (options.focusId) this.focusId = options.focusId;
    if (options.filter) this.setData({ filter: options.filter });
  },
  onShow() {
    this.load();
  },

  focusLoadedItem(prefix, items) {
    const focusId = this.focusId;
    if (!focusId || !(items || []).some((item) => item.id === focusId)) return;
    this.setData({ focusId });
    wx.nextTick(() => {
      wx.pageScrollTo({ selector: `#${prefix}-${focusId}`, offsetTop: 80, duration: 300 });
    });
  },
  request(path, options = {}) {
    const token = wx.getStorageSync('campusGoMerchantToken');
    return apiRequest(path, { ...options, header: { authorization: `Bearer ${token}` } });
  },
  /**
   * 加载商家订单。
   *
   * ★ 失败时**不清空** `orders` / `filtered`，也不再弹 toast（T49）。
   *
   * 改造前的失败路径是 `setData({loading:false})` + toast「请重新进入商家工作台」，
   * 而 `orders` 的初值是 `[]`，于是**同一屏上出现两句互相矛盾的话**：
   * 空态说「暂无订单」，toast 说「请重新进入商家工作台」。
   * 前者是关于这家店经营状况的假陈述（他可能有一百个订单），后者不提供任何可执行动作
   * （「重新进入」既不是重试，也不保证有用）。现在只留一句可重试的错误占位。
   */
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
        loading: false,
        ordersError: ''
      });
      this.focusLoadedItem('merchant-order', orders);
    }).catch((error) => {
      this.setData({ loading: false, ordersError: loadState.blockErrorText(error) });
    });
  },
  retryOrders() { return this.load(); },
  setFilter(e) {
    const filter = e.currentTarget.dataset.key || 'ALL';
    this.setData({ filter, filtered: this.filterOrders(this.data.orders, filter) });
  },
  filterOrders(orders, filter) {
    if (filter === 'ALL') return orders;
    if (filter === 'PENDING') return orders.filter((order) => ['PAID', 'FULFILLING'].includes(order.status));
    if (filter === 'AFTER_SALE') return orders.filter((order) => ['AFTER_SALE', 'PARTIALLY_REFUNDED'].includes(order.status));
    return orders.filter((order) => order.status === filter);
  },
  decorateOrder(order, afterSales) {
    const totalQuantity = (order.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const refundedQuantity = Number(order.refundedQuantity || 0);
    return {
      ...order,
      // 租赁单用租赁标签（待取车 / 租期中 / 待核验归还），售卖单回落到既有表，逐字不变。
      statusLabel: rentalJourney.merchantRentalStatusLabel(order) || statusLabels[order.status] || order.status,
      totalQuantity,
      refundedQuantity,
      remainingQuantity: Math.max(0, totalQuantity - refundedQuantity),
      // 租赁单走租赁文案（取车 / 归还），**不会**出现售卖链路的「配送」措辞；
      // 非租赁时 `merchantRentalNextStep` 返回 null，这里回落到 `nextSteps`，售卖链路逐字不变。
      nextStep: rentalJourney.merchantRentalNextStep(order) || nextSteps[order.status] || '等待更新',
      // 「核验归还」按钮的显示条件：仅租赁单且 rental.status === 'RETURN_REQUESTED'。
      canVerifyReturn: rentalJourney.canVerifyRentalReturn(order),
      delivery: order.fulfillment?.type === 'DELIVERY' ? {
        contactName: order.fulfillment.contactName || '未填写',
        contactPhone: order.fulfillment.contactPhone || '未填写',
        date: order.fulfillment.date || '尽快配送',
        address: order.fulfillment.address || '未填写'
      } : null,
      intervention: order.collaboration?.intervention?.status === 'REQUESTED',
      hasUnrepliedMessage: !!order.collaboration?.unrepliedMessage,
      partialRefundNotice: refundedQuantity > 0 && refundedQuantity < totalQuantity,
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
    if (status === 'REJECTED') {
      return wx.showModal({
        title: '拒绝售后申请',
        editable: true,
        placeholderText: '请说明拒绝原因，例如车辆外观无损伤且可正常骑行',
        success: ({ confirm, content }) => {
          if (!confirm) return;
          this.submitAfterSaleStatus(id, { status, resolutionNote: (content || '').trim() });
        }
      });
    }
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
  },
  /**
   * 核验归还（租赁商家侧动作）：`RETURN_REQUESTED → RETURNED`。
   *
   * 走既有的 `/api/order-collab` 协同入口，不新开端点 —— 用户侧动作
   * （`RETURN_REQUEST`）也是挂在这里，鉴权与通知链路都已具备。
   *
   * 服务端 `requireString(body.note)` 要求 note **非空**，所以用户留空时
   * 用 `DEFAULT_RETURN_VERIFY_NOTE` 兜底，避免「点了确认却报 400」。
   *
   * 核验成功后服务端会连带做三件事（T35）：库存回补（`RETURN_RESTORE`）、
   * 押金 `HELD → REFUND_PENDING`、订单收口为 `COMPLETED`。前端只需刷新列表。
   */
  verifyReturn(e) {
    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: '核验归还',
      editable: true,
      placeholderText: '例如：车辆外观完好、电量正常，确认归还',
      success: (res) => {
        if (!res.confirm) return;
        const note = (res.content || '').trim() || DEFAULT_RETURN_VERIFY_NOTE;
        this.request('/api/order-collab', {
          method: 'POST',
          data: { role: 'MERCHANT', orderId: id, action: 'RETURN_VERIFY', note }
        }).then(() => {
          wx.showToast({ title: '已核验归还' });
          this.load();
        }).catch((error) => wx.showToast({ title: error.message || '核验失败', icon: 'none' }));
      }
    });
  }
});
