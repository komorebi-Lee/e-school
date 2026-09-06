const { request: apiRequest, userId } = require('../../services/api');

const orderStatusLabels = {
  PENDING_PAYMENT: '待支付',
  PAID: '待发货',
  FULFILLING: '履约中',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  AFTER_SALE: '售后中'
};

function statementMoney(value) {
  return ((Number(value) || 0) / 100).toFixed(2);
}

function statementCsvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildStatementCsv(statement) {
  const rows = [
    ['记录类型', '单据号', '状态', '金额(元)', '平台佣金(元)', '商家应收(元)', '时间', '打款凭证']
  ];
  for (const item of statement.settlements || []) {
    rows.push([
      '收入分账', item.orderNo, item.statusLabel, statementMoney(item.amountInCents),
      statementMoney(item.platformFeeInCents), statementMoney(item.payableInCents),
      item.createdAt, item.settlementReference
    ]);
  }
  for (const item of statement.payouts || []) {
    const paid = item.paidAmountInCents || (item.status === 'SETTLED' ? item.amountInCents : 0);
    rows.push([
      '提现出账', item.requestNo, item.statusLabel, `-${statementMoney(paid)}`,
      '', `-${statementMoney(paid)}`, item.reviewedAt || item.createdAt, item.settlementReference
    ]);
  }
  const totals = statement.totals || {};
  rows.push([
    '本月汇总', '', '', statementMoney(totals.businessGrossInCents),
    statementMoney(totals.commissionInCents), statementMoney(totals.netInCents),
    statement.generatedAt, ''
  ]);
  return rows.map((row) => row.map(statementCsvCell).join(',')).join('\r\n');
}

// 分账要经过“交付核验 → 账期 → 可结算”，商家需要看懂钱卡在哪一步。
const settlementStageLabels = {
  PENDING_DELIVERY: '待交付核验',
  IN_ACCOUNT_PERIOD: '账期中',
  PENDING_SETTLE: '可结算',
  PAYOUT_REQUESTED: '提现待审核',
  FROZEN: '售后冻结',
  SETTLED: '已结算',
  REFUNDED: '已冲销'
};

const payoutStatusLabels = {
  PENDING_REVIEW: '待平台审核',
  SETTLED: '已打款',
  REJECTED: '已驳回',
  CANCELLED: '已关闭'
};

function decorateSettlement(item) {
  const status = item.settlementStatus || 'PENDING_DELIVERY';
  const availableText = item.availableAt ? String(item.availableAt).slice(5, 10).replace('-', '/') : '';
  const hints = {
    PENDING_DELIVERY: '用户确认交付码后进入账期',
    IN_ACCOUNT_PERIOD: availableText ? `${availableText} 后可结算` : '账期中',
    PENDING_SETTLE: '等待平台打款',
    PAYOUT_REQUESTED: '提现申请已提交，等待平台审核',
    FROZEN: item.frozenReason || '售后处理中，暂停打款',
    SETTLED: item.settlementReference ? `凭证 ${item.settlementReference}` : '已完成打款',
    REFUNDED: '订单退款，分账已冲销'
  };
  return {
    ...item,
    stageLabel: settlementStageLabels[status] || status,
    stageHint: hints[status] || '',
    stageTone: status === 'PENDING_SETTLE' ? 'done' : status === 'FROZEN' || status === 'REFUNDED' ? 'warn' : status === 'SETTLED' ? 'blue' : 'todo'
  };
}

function decoratePayoutRequest(item) {
  const status = item.status || 'PENDING_REVIEW';
  return {
    ...item,
    amountText: ((item.amountInCents || 0) / 100).toFixed(2),
    statusLabel: payoutStatusLabels[status] || status,
    statusTone: status === 'SETTLED' ? 'blue' : status === 'REJECTED' || status === 'CANCELLED' ? 'warn' : 'todo',
    createdText: String(item.createdAt || '').slice(5, 16).replace('T', ' '),
    noteText: item.reviewNote || (status === 'PENDING_REVIEW' ? '平台核对收款账户后打款' : ''),
    accountText: `${item.accountBank || ''} ${item.accountMasked || ''}`.trim()
  };
}

// 平台巡检会把逾期/临期的履约事项推给责任商家，这里换成一眼能看懂的倒计时。
function decorateSlaAlert(item) {
  const dueMs = new Date(item.dueAt).getTime();
  const diffMinutes = Number.isFinite(dueMs) ? Math.round((dueMs - Date.now()) / 60000) : 0;
  let countdown = '';
  if (diffMinutes <= 0) {
    const overdue = Math.abs(diffMinutes);
    countdown = overdue >= 60 ? `已超时 ${Math.floor(overdue / 60)} 小时` : `已超时 ${overdue} 分钟`;
  } else {
    countdown = diffMinutes >= 60 ? `剩余 ${Math.floor(diffMinutes / 60)} 小时` : `剩余 ${diffMinutes} 分钟`;
  }
  return {
    ...item,
    countdownText: countdown,
    levelLabel: item.level === 'OVERDUE' ? '已超时' : '即将超时',
    levelTone: item.level === 'OVERDUE' ? 'warn' : 'todo',
    ackText: item.status === 'ACKNOWLEDGED' && item.acknowledgeNote ? `平台跟进：${item.acknowledgeNote}` : ''
  };
}

// 服务分要让商家看懂三件事：现在多少分、平台对我做了什么、哪一项拖了后腿。
const scoreStageTone = { NORMAL: 'done', LIMITED: 'todo', RESTRICTED: 'warn' };
const scoreStageConsequences = {
  NORMAL: '商品曝光正常，可自主上新',
  LIMITED: '商品曝光已降权，新增商品需平台复核',
  RESTRICTED: '已暂停上新，商品曝光大幅降低'
};
const scoreCaseStatusLabels = { SUBMITTED: '待平台审核', REVIEWING: '处理中', COMPLETED: '已通过', REJECTED: '未通过' };
const scoreCaseStatusTones = { SUBMITTED: 'todo', REVIEWING: 'blue', COMPLETED: 'done', REJECTED: 'warn' };
const appealReasons = [
  { key: 'REMOVED_NEGATIVE_REVIEW', label: '差评记录有误' },
  { key: 'DELAYED_DELIVERY', label: '履约有合理原因' },
  { key: 'AFTER_SALE_ISSUE', label: '售后责任有异议' }
];

function decorateServiceScore(score) {
  if (!score) return null;
  const breakdown = (score.breakdown || []).map((part) => ({
    ...part,
    toneClass: part.score >= 90 ? 'done' : part.score >= 75 ? 'todo' : 'warn'
  }));
  const weakest = breakdown.slice().sort((a, b) => a.score - b.score)[0];
  return {
    ...score,
    breakdown,
    stageTone: scoreStageTone[score.stage] || 'todo',
    consequenceText: scoreStageConsequences[score.stage] || '',
    weakestText: weakest ? `${weakest.label} ${weakest.score} 分 · ${weakest.detail}` : '',
    onTimeRateText: score.metrics && score.metrics.completedOrderCount
      ? `${Math.round((score.metrics.onTimeCount / score.metrics.completedOrderCount) * 100)}%`
      : '—'
  };
}

Page({
  data: {
    merchant: null, metrics: null, products: [], orders: [], settlements: [], payoutRequests: [],
    slaAlerts: [], notifications: [], unreadNotificationCount: 0, loading: true,
    serviceScore: null, pendingPublishProducts: [], scoreCases: [], scoreNoticeSubscribed: false,
    scoreEvidence: [], uploadingScoreEvidence: false,
    delistedProducts: [], rectifyProductIndex: 0,
    scoreCaseType: 'APPEAL', scoreCaseReasonTypeIndex: 0, appealReasons,
    payoutMinimumText: '100.00', payableText: '0.00', canRequestPayout: false, payoutHint: '', payoutSubmitting: false,
    statement: null, statementMonth: new Date().toISOString().slice(0, 7), statementSaving: false
  },
  onShow() {
    this.load();
  },

  // 商家态接口统一带上登录后的商家 token，避免调用方漏传导致 401。
  request(path, options = {}) {
    const token = this.merchantToken || wx.getStorageSync('campusGoMerchantToken');
    return apiRequest(path, { ...options, header: { authorization: `Bearer ${token}` } });
  },
  load() {
    const tryLogin = (merchantId) => {
      return apiRequest('/api/merchant/login', {
        method: 'POST',
        data: { userId: userId(), merchantId }
      }).then(({ data }) => {
        this.merchantToken = data.token;
        wx.setStorageSync('campusGoMerchantToken', data.token);
        return this.request('/api/merchant/overview');
      });
    };
    const merchantId = wx.getStorageSync('campusGoMerchantId');
    (merchantId ? tryLogin(merchantId) : apiRequest(`/api/merchants?userId=${encodeURIComponent(userId())}`).then(({ data }) => {
      const approved = data.find((item) => item.status === 'APPROVED');
      if (!approved) throw new Error('NOT_APPROVED');
      wx.setStorageSync('campusGoMerchantId', approved.id);
      return tryLogin(approved.id);
    })).then(({ data }) => {
      const orders = (data.orders || []).slice(0, 5).map((order) => ({
        ...order,
        statusLabel: orderStatusLabels[order.status] || order.status
      }));
      const settlementMetrics = data.metrics?.settlementMetrics || {};
      const payableInCents = Number(settlementMetrics.payableInCents || 0);
      const minimumInCents = Number(settlementMetrics.payoutMinimumInCents || 0);
      const pendingRequest = settlementMetrics.pendingPayoutRequest;
      this.setData({
        merchant: data.merchant,
        metrics: data.metrics,
        products: data.products,
        orders,
        settlements: (data.settlements || []).slice(0, 5).map(decorateSettlement),
        payoutRequests: (data.payoutRequests || []).slice(0, 3).map(decoratePayoutRequest),
        slaAlerts: (data.slaAlerts || []).slice(0, 4).map(decorateSlaAlert),
        serviceScore: decorateServiceScore(data.serviceScore),
        scoreCases: (data.scoreCases || []).slice(0, 5).map((item) => ({
          ...item,
          statusLabel: scoreCaseStatusLabels[item.status] || item.status,
          statusTone: scoreCaseStatusTones[item.status] || 'todo',
          timeText: String(item.updatedAt || item.createdAt).slice(5, 16).replace('T', ' '),
          resultText: item.type === 'APPEAL' && item.appliedAdjustment ? `核定补分 +${item.appliedAdjustment}` : ''
        })),
        pendingPublishProducts: data.pendingPublishProducts || [],
        delistedProducts: (data.products || [])
          .filter((item) => item.autoDelistRule === 'LOW_QUALITY' && item.active === false)
          .map((item) => ({
            ...item,
            evidenceText: `低分评价 ${item.autoDelistEvidence?.lowRatingCount || 0} 条 · 均分 ${item.autoDelistEvidence?.averageRating || 0}`,
            statusText: item.complianceCase?.statusLabel || (item.autoDelistStatus === 'REVIEW_PENDING' ? '整改待平台复核' : item.autoDelistStatus === 'REVIEW_REJECTED' ? '整改未通过' : '待提交整改'),
            nextActionText: item.complianceCase?.status === 'SUBMITTED' || item.complianceCase?.status === 'REVIEWING'
              ? '平台审核中，无需重复提交'
              : item.autoDelistStatus === 'REVIEW_REJECTED' || item.complianceCase?.status === 'REJECTED'
                ? '请补充整改凭证和措施后重新提交'
                : '提交整改工单，平台 48 小时内复核',
            canResubmit: item.autoDelistStatus === 'REVIEW_REJECTED' || item.complianceCase?.status === 'REJECTED'
          })),
        rectifyProductIndex: 0,
        payableText: (payableInCents / 100).toFixed(2),
        payoutMinimumText: (minimumInCents / 100).toFixed(2),
        canRequestPayout: Boolean(data.merchant?.settlementAccountReady) && !pendingRequest && payableInCents >= minimumInCents && payableInCents > 0,
        payoutHint: this.buildPayoutHint(data.merchant, settlementMetrics, payableInCents, minimumInCents),
        loading: false
      });
      const notificationTask = this.request('/api/merchant/notifications').then(({ data: items }) => {
        const notifications = (items || []).slice(0, 5).map((item) => ({
          ...item,
          timeText: String(item.createdAt || '').slice(5, 16).replace('T', ' ')
        }));
        const unreadNotificationCount = (items || []).filter((item) => !item.read).length;
        this.setData({ notifications, unreadNotificationCount });
        if (unreadNotificationCount) return this.request('/api/merchant/notifications/read', { method: 'POST' });
      });
      const subscriptionTask = this.request('/api/merchant/message-subscriptions').then(({ data }) => {
        this.setData({ scoreNoticeSubscribed: data.subscribed === true });
      });
      const statementTask = this.loadStatement();
      return Promise.all([notificationTask, subscriptionTask, statementTask]).catch(() => {});
    }).catch(() => {
      this.setData({ loading: false });
      wx.removeStorageSync('campusGoMerchantId');
      apiRequest(`/api/merchants?userId=${encodeURIComponent(userId())}`).then(({ data }) => {
        const pending = data.find((item) => item.status === 'REVIEWING');
        if (pending) wx.redirectTo({ url: `/pages/merchant/apply` });
        else this.goApply();
      }).catch(() => this.goApply());
    });
  },
  goApply() {
    wx.redirectTo({ url: '/pages/merchant/apply' });
  },
  goOrders() {
    wx.navigateTo({ url: '/pages/merchant/orders' });
  },
  goProducts() {
    wx.navigateTo({ url: '/pages/merchant/products' });
  },
  goReviews() {
    wx.navigateTo({ url: '/pages/merchant/reviews' });
  },
  setStatementMonth(event) {
    this.setData({ statementMonth: event.detail.value });
    this.loadStatement();
  },
  loadStatement() {
    const month = this.data.statementMonth || new Date().toISOString().slice(0, 7);
    return this.request(`/api/merchant/settlement-statement?month=${encodeURIComponent(month)}`)
      .then(({ data }) => {
        this.setData({ statement: data });
      })
      .catch(() => {});
  },
  saveStatement() {
    if (this.data.statementSaving || !this.data.statement) return;
    const month = this.data.statementMonth;
    const filePath = `${wx.env.USER_DATA_PATH}/shishan-statement-${month}.csv`;
    try {
      wx.getFileSystemManager().writeFileSync(filePath, buildStatementCsv(this.data.statement), 'utf8');
      this.setData({ statementSaving: true });
      wx.shareFileMessage({
        filePath,
        fileName: `狮山智生活-${month}-商家对账单.csv`,
        success: () => wx.showToast({ title: '已生成对账文件', icon: 'success' }),
        fail: () => wx.showToast({ title: '当前环境不支持分享文件', icon: 'none' }),
        complete: () => this.setData({ statementSaving: false })
      });
    } catch (error) {
      this.setData({ statementSaving: false });
      wx.showToast({ title: '生成对账文件失败', icon: 'none' });
    }
  },

  setScoreCaseType(event) {
    const target = event.currentTarget.dataset;
    const productIndex = target.productIndex === undefined ? undefined : Number(target.productIndex);
    this.setData({
      scoreCaseType: target.type || 'APPEAL',
      ...(productIndex === undefined ? {} : { rectifyProductIndex: productIndex })
    });
  },
  setAppealReason(event) {
    this.setData({ scoreCaseReasonTypeIndex: Number(event.detail.value) });
  },
  setRectifyProduct(event) {
    this.setData({ rectifyProductIndex: Number(event.detail.value) });
  },
  chooseScoreEvidence() {
    const remaining = 6 - this.data.scoreEvidence.length;
    if (remaining <= 0) {
      wx.showToast({ title: '最多上传 6 张凭证', icon: 'none' });
      return;
    }
    wx.chooseMedia({
      count: remaining,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: ({ tempFiles = [] }) => {
        if (!tempFiles.length) return;
        this.setData({ uploadingScoreEvidence: true });
        const uploadOne = (file) => new Promise((resolve, reject) => {
          if ((file.size || 0) > 5 * 1024 * 1024) {
            reject(new Error('凭证图片不能超过 5MB'));
            return;
          }
          const extension = String(file.tempFilePath || '').split('.').pop().toLowerCase();
          const mimeType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
          wx.getFileSystemManager().readFile({
            filePath: file.tempFilePath,
            encoding: 'base64',
            success: ({ data }) => resolve({ dataBase64: data, mimeType }),
            fail: () => reject(new Error('读取凭证图片失败'))
          });
        }).then((payload) => this.request('/api/uploads', { method: 'POST', data: payload }))
          .then(({ data }) => {
            this.setData({ scoreEvidence: [...this.data.scoreEvidence, data.url] });
          });
        tempFiles.reduce((task, file) => task.then(() => uploadOne(file)), Promise.resolve())
          .catch((error) => wx.showToast({ title: error.message || '凭证上传失败', icon: 'none' }))
          .finally(() => this.setData({ uploadingScoreEvidence: false }));
      }
    });
  },
  removeScoreEvidence(event) {
    const url = event.currentTarget.dataset.url;
    this.setData({ scoreEvidence: this.data.scoreEvidence.filter((item) => item !== url) });
  },
  previewScoreEvidence(event) {
    const url = event.currentTarget.dataset.url;
    wx.previewImage({ current: url, urls: this.data.scoreEvidence.length ? this.data.scoreEvidence : [url] });
  },
  openScoreCase() {
    const score = this.data.serviceScore;
    if (!score) return;
    const pending = (this.data.scoreCases || []).find((item) => ['SUBMITTED', 'REVIEWING'].includes(item.status));
    if (pending) {
      wx.showToast({ title: '已有一件工单在处理中', icon: 'none' });
      return;
    }
    const isAppeal = this.data.scoreCaseType === 'APPEAL';
    wx.showModal({
      title: isAppeal ? '提交记录申诉' : '提交整改申请',
      editable: true,
      placeholderText: isAppeal
        ? '请说明记录有误的证据或事实'
        : '请填写整改措施，例如 48 小时内清空超时工单',
      success: ({ confirm, content }) => {
        const reason = (content || '').trim();
        if (!confirm) return;
        if (reason.length < 8) return wx.showToast({ title: '说明至少 8 个字', icon: 'none' });
        const payload = isAppeal
          ? { type: 'APPEAL', reasonType: this.data.appealReasons[this.data.scoreCaseReasonTypeIndex].key, reason }
          : {
            type: 'RECTIFY',
            reason,
            plan: reason,
            productId: this.data.delistedProducts[this.data.rectifyProductIndex]?.id || ''
          };
        payload.evidence = this.data.scoreEvidence;
        this.request('/api/merchant/score-cases', { method: 'POST', data: payload }).then(() => {
          wx.showToast({ title: '已提交', icon: 'success' });
          this.setData({ scoreEvidence: [] });
          setTimeout(() => this.load(), 450);
        }).catch((error) => wx.showToast({ title: error.message || '提交失败', icon: 'none' }));
      }
    });
  },
  subscribeScoreNotice() {
    if (this.data.scoreNoticeSubscribed) {
      this.request('/api/merchant/message-subscriptions', { method: 'POST', data: { accepted: false } }).then(() => {
        this.setData({ scoreNoticeSubscribed: false });
        wx.showToast({ title: '已关闭提醒', icon: 'success' });
      }).catch((error) => wx.showToast({ title: error.message || '设置失败', icon: 'none' }));
      return;
    }
    apiRequest('/api/subscribe-templates').then(({ data = [] }) => {
      const tmplIds = data.filter((item) => item.audience !== 'USER').map((item) => item.configuredId).filter(Boolean).slice(0, 3);
      const finish = () => this.request('/api/merchant/message-subscriptions', {
        method: 'POST',
        data: { accepted: true }
      }).then(() => {
        this.setData({ scoreNoticeSubscribed: true });
        wx.showToast({ title: '已开启服务分提醒', icon: 'success' });
      });
      if (!tmplIds.length) {
        finish();
        return;
      }
      wx.requestSubscribeMessage({
        tmplIds,
        complete: finish
      });
    }).catch((error) => wx.showToast({ title: error.message || '订阅配置读取失败', icon: 'none' }));
  },

  // 商家只能发起申请，实际打款由平台在管理端审核，前端提前把不满足的原因说清楚。
  buildPayoutHint(merchant, metrics, payableInCents, minimumInCents) {
    if (!merchant?.settlementAccountReady) return '请先补全收款账户资料才能申请提现';
    if (metrics.pendingPayoutRequest) return `提现单 ${metrics.pendingPayoutRequest.requestNo} 正在审核中`;
    if (!payableInCents) {
      if (metrics.frozenInCents) return '有分账处于售后冻结，售后关闭后可申请';
      if (metrics.inAccountPeriodInCents) return '账期到期后可申请提现';
      if (metrics.pendingDeliveryInCents) return '完成交付核验后进入账期';
      return '暂无可提现金额';
    }
    if (payableInCents < minimumInCents) return `还差 ¥${((minimumInCents - payableInCents) / 100).toFixed(2)} 达到起提金额`;
    return `可提现 ¥${(payableInCents / 100).toFixed(2)}，提交后由平台审核打款`;
  },

  requestPayout() {
    if (this.data.payoutSubmitting || !this.data.canRequestPayout) return;
    const account = `${this.data.merchant?.settlementBank || ''} ${this.data.merchant?.settlementAccountMasked || ''}`.trim();
    wx.showModal({
      title: '申请提现',
      content: `提现金额 ¥${this.data.payableText}\n收款账户 ${account || '请核对'}\n平台审核通过后打款`,
      confirmText: '提交申请',
      success: (result) => {
        if (!result.confirm) return;
        this.setData({ payoutSubmitting: true });
        this.request('/api/merchant/payout-requests', { method: 'POST', data: { remark: '商家工作台申请' } })
          .then(({ data }) => {
            wx.showToast({ title: `已提交 ${data.requestNo}`, icon: 'success' });
            this.setData({ payoutSubmitting: false });
            this.load();
          })
          .catch((error) => {
            this.setData({ payoutSubmitting: false });
            wx.showModal({ title: '暂不能提现', content: error.message || '请稍后重试', showCancel: false });
          });
      }
    });
  }
});
