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

// 整改工单有自己的复核时限，直接把剩余时间写在卡片上，商家不用自己换算。
function rectifyCountdown(dueAt, status) {
  if (!['SUBMITTED', 'REVIEWING'].includes(status) || !dueAt) return null;
  const dueMs = new Date(dueAt).getTime();
  if (!Number.isFinite(dueMs)) return null;
  const diffMinutes = Math.round((dueMs - Date.now()) / 60000);
  if (diffMinutes <= 0) {
    const overdue = Math.abs(diffMinutes);
    return { text: overdue >= 60 ? `已超时 ${Math.floor(overdue / 60)} 小时` : `已超时 ${overdue} 分钟`, tone: 'warn' };
  }
  return {
    text: diffMinutes >= 60 ? `剩余 ${Math.floor(diffMinutes / 60)} 小时` : `剩余 ${diffMinutes} 分钟`,
    tone: diffMinutes <= 60 ? 'warn' : 'blue'
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
const qualificationStatusLabels = { PENDING_REVIEW: '待平台审核', APPROVED: '复审通过', REJECTED: '复审未通过' };
const qualificationStatusTones = { PENDING_REVIEW: 'todo', APPROVED: 'done', REJECTED: 'warn' };
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
    complianceText: Number(score.metrics?.compliancePenalty || 0)
      ? `近30天低质下架 ${score.metrics.autoDelistCount30d || 0} 件，服务分扣 ${score.metrics.compliancePenalty} 分`
      : '',
    weakestText: weakest ? `${weakest.label} ${weakest.score} 分 · ${weakest.detail}` : '',
    onTimeRateText: score.metrics && score.metrics.completedOrderCount
      ? `${Math.round((score.metrics.onTimeCount / score.metrics.completedOrderCount) * 100)}%`
      : '—'
  };
}

function decorateScoreTrend(trend) {
  const points = (trend?.points || []).filter((item) => Number.isInteger(item.score));
  if (!points.length) return null;
  const decorated = points.map((item) => ({
    ...item,
    stageTone: scoreStageTone[item.stage] || 'todo',
    heightPercent: Math.max(8, Math.min(100, item.score)),
    label: String(item.date || '').slice(5)
  }));
  const change = Number(trend?.change || 0);
  const effect = trend?.effect;
  const risk = trend?.risk;
  return {
    points: decorated,
    change,
    changeText: `较 14 天前 ${change > 0 ? '+' : ''}${change} 分`,
    changeTone: change > 0 ? 'done' : change < 0 ? 'warn' : 'muted',
    effect: effect ? {
      gain: Number(effect.gain || 0),
      effectText: [
        effect.caseNo,
        effect.approvedDate,
        `${effect.scoreBefore} 分 → ${effect.scoreAfter} 分`,
        `整改后${Number(effect.gain || 0) >= 0 ? '+' : ''}${Number(effect.gain || 0)} 分`
      ].filter(Boolean).join(' · ')
    } : null,
    risk: risk ? {
      riskPoints: Number(risk.riskPoints || 0),
      riskText: `售后超时 ${Number(risk.overdueAfterSales || 0)} 单 · 未关闭 ${Number(risk.openAfterSales || 0)} 单 · 及时处理可回升 ${Number(risk.riskPoints || 0)} 分`
    } : null
  };
}

Page({
  data: {
    merchant: null, metrics: null, products: [], orders: [], settlements: [], payoutRequests: [], focusId: '',
    lowStockProducts: [], lowStockThreshold: 10,
    slaAlerts: [], riskTasks: [], promotionSummary: [], notifications: [], unreadNotificationCount: 0, loading: true,
    serviceScore: null, scoreTrend: null, latestRiskUrge: null, pendingPublishProducts: [], scoreCases: [], scoreNoticeSubscribed: false,
    scoreEvidence: [], uploadingScoreEvidence: false,
    qualificationRenewals: [], renewalLicenseNo: '', renewalLicenseExpireDate: '', renewalNote: '',
    renewalEvidence: [], uploadingRenewalEvidence: false, renewalSubmitting: false,
    delistedProducts: [], watchingProducts: [], rectifyProductIndex: 0, showQualificationPanel: false,
    scoreCaseType: 'APPEAL', scoreCaseReasonTypeIndex: 0, appealReasons,
    payoutMinimumText: '100.00', payableText: '0.00', canRequestPayout: false, payoutHint: '', payoutSubmitting: false,
    statement: null, statementMonth: new Date().toISOString().slice(0, 7), statementSaving: false
  },
  onLoad(options) {
    this.pendingFocusId = options?.focusId ? decodeURIComponent(options.focusId) : '';
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
        promotionSummary: (data.promotionSummary || []).slice(0, 4).map((item) => ({
          ...item,
          campaignAmountText: (Number(item.campaignAmountInCents || 0) / 100).toFixed(2),
          campaignDiscountText: (Number(item.campaignDiscountInCents || 0) / 100).toFixed(2)
        })),
        lowStockProducts: data.lowStockProducts || [],
        lowStockThreshold: data.lowStockThreshold || 10,
        orders,
        settlements: (data.settlements || []).slice(0, 5).map(decorateSettlement),
        payoutRequests: (data.payoutRequests || []).slice(0, 3).map(decoratePayoutRequest),
        slaAlerts: (data.slaAlerts || []).slice(0, 4).map(decorateSlaAlert),
        serviceScore: decorateServiceScore(data.serviceScore),
        scoreTrend: decorateScoreTrend(data.scoreTrend),
        latestRiskUrge: data.latestRiskUrge ? {
          ...data.latestRiskUrge,
          timeText: String(data.latestRiskUrge.createdAt || '').slice(5, 16).replace('T', ' ')
        } : null,
        riskTasks: (data.riskTasks || []).slice(0, 8).map((item) => ({
          ...item,
          urgeText: item.urged ? '平台已催办，请尽快回复' : '',
          dueText: item.dueAt ? String(item.dueAt).slice(5, 16).replace('T', ' ') : '',
          dueTone: item.dueAt && new Date(item.dueAt).getTime() < Date.now() ? 'warn' : 'todo'
        })),
        qualificationRenewals: (data.qualificationRenewals || []).slice(0, 5).map((item) => ({
          ...item,
          statusLabel: qualificationStatusLabels[item.status] || item.status,
          statusTone: qualificationStatusTones[item.status] || 'todo',
          timeText: String(item.updatedAt || item.createdAt).slice(5, 16).replace('T', ' '),
          reviewText: item.reviewNote || (item.status === 'PENDING_REVIEW' ? '平台核对通过后自动更新店铺资质' : '')
        })),
        scoreCases: (data.scoreCases || []).slice(0, 5).map((item) => {
          const countdown = rectifyCountdown(item.dueAt, item.status);
          return {
            ...item,
            statusLabel: scoreCaseStatusLabels[item.status] || item.status,
            statusTone: scoreCaseStatusTones[item.status] || 'todo',
            timeText: String(item.updatedAt || item.createdAt).slice(5, 16).replace('T', ' '),
            resultText: item.type === 'APPEAL' && item.appliedAdjustment ? `核定补分 +${item.appliedAdjustment}` : '',
            countdownText: countdown?.text || '',
            countdownTone: countdown?.tone || 'todo'
          };
        }),
        pendingPublishProducts: data.pendingPublishProducts || [],
        delistedProducts: (data.products || [])
          .filter((item) => ['LOW_QUALITY', 'SERVICE_RISK'].includes(item.autoDelistRule) && item.active === false)
          .map((item) => {
            const countdown = rectifyCountdown(item.complianceCase?.dueAt, item.complianceCase?.status);
            const watchUntilMs = item.watchUntil ? new Date(item.watchUntil).getTime() : 0;
            const watchOverdue = Boolean(watchUntilMs && watchUntilMs < Date.now());
            return {
              ...item,
              watchText: watchUntilMs
                ? `${watchOverdue ? '复核超时' : '复核截止'} ${String(item.watchUntil).slice(5, 16).replace('T', ' ')}`
                : '',
              watchTone: watchOverdue ? 'warn' : 'blue',
              evidenceText: item.autoDelistRule === 'SERVICE_RISK'
                ? `售后超时 ${item.autoDelistEvidence?.overdueAfterSaleCount || 0} 单，请先处理超时工单`
                : `低分评价 ${item.autoDelistEvidence?.lowRatingCount || 0} 条 · 均分 ${item.autoDelistEvidence?.averageRating || 0}`,
              statusText: item.complianceCase?.statusLabel || (item.autoDelistStatus === 'REVIEW_PENDING' ? '整改待平台复核' : item.autoDelistStatus === 'REVIEW_REJECTED' ? '整改未通过' : '待提交整改'),
              nextActionText: item.complianceCase?.status === 'SUBMITTED' || item.complianceCase?.status === 'REVIEWING'
                ? '平台审核中，无需重复提交'
                : item.autoDelistStatus === 'REVIEW_REJECTED' || item.complianceCase?.status === 'REJECTED'
                  ? '请补充整改凭证和措施后重新提交'
                  : '提交整改工单，平台 48 小时内复核',
              canResubmit: item.autoDelistStatus === 'REVIEW_REJECTED' || item.complianceCase?.status === 'REJECTED',
              countdownText: countdown?.text || '',
              countdownTone: countdown?.tone || 'todo'
            };
          }),
        watchingProducts: (data.watchingProducts || []).map((item) => {
          const watchUntilMs = item.watchUntil ? new Date(item.watchUntil).getTime() : 0;
          const watchOverdue = Boolean(watchUntilMs && watchUntilMs < Date.now());
          return {
            ...item,
            watchText: watchUntilMs
              ? `${watchOverdue ? '复核已过期' : '复核截止'} ${String(item.watchUntil).slice(5, 16).replace('T', ' ')}`
              : '',
            watchTone: watchOverdue ? 'warn' : 'blue',
            evidenceText: item.autoDelistRule === 'SERVICE_RISK'
              ? '触发履约超时风险'
              : '触发低质商品风控'
          };
        }),
        rectifyProductIndex: 0,
        showQualificationPanel: !data.merchant?.licenseExpireDate,
        payableText: (payableInCents / 100).toFixed(2),
        payoutMinimumText: (minimumInCents / 100).toFixed(2),
        canRequestPayout: Boolean(data.merchant?.settlementAccountReady) && !pendingRequest && payableInCents >= minimumInCents && payableInCents > 0,
        payoutHint: this.buildPayoutHint(data.merchant, settlementMetrics, payableInCents, minimumInCents),
        loading: false
      });
      if (this.pendingFocusId) {
        const focusValue = this.pendingFocusId;
        this.pendingFocusId = '';
        this.applyNotificationFocus(focusValue);
      }
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
  applyNotificationFocus(focusValue) {
    if (focusValue === 'merchant-qualification') {
      return wx.nextTick(() => {
        wx.pageScrollTo({ selector: '#merchant-qualification-card', offsetTop: 90, duration: 320 });
      });
    }
    if (focusValue === 'merchant-score') {
      return wx.nextTick(() => {
        wx.pageScrollTo({ selector: '#merchant-score-card', offsetTop: 90, duration: 320 });
      });
    }
    if (focusValue === 'merchant-payout') {
      return wx.nextTick(() => {
        wx.pageScrollTo({ selector: '#merchant-payout-card', offsetTop: 90, duration: 320 });
      });
    }
    if (focusValue.startsWith('merchant-delist-')) {
      const productId = focusValue.replace('merchant-delist-', '');
      const productIndex = this.data.delistedProducts.findIndex((item) => item.id === productId);
      if (productIndex >= 0) {
        this.setData({ scoreCaseType: 'RECTIFY', rectifyProductIndex: productIndex });
      }
      this.setData({ focusId: productId });
      return wx.nextTick(() => {
        wx.pageScrollTo({ selector: `#merchant-delist-${productId}`, offsetTop: 90, duration: 320 });
      });
    }
    if (focusValue && !focusValue.startsWith('merchant-')) {
      this.setData({ focusId: focusValue });
      return wx.nextTick(() => {
        wx.pageScrollTo({ selector: `#merchant-score-case-${focusValue}`, offsetTop: 90, duration: 320 });
      });
    }
    return undefined;
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
  refreshWorkbench() {
    wx.showToast({ title: '正在刷新', icon: 'loading', duration: 500 });
    this.load();
  },
  openQualificationPanel() {
    this.setData({ showQualificationPanel: true });
    wx.nextTick(() => {
      wx.pageScrollTo({ selector: '#merchant-qualification-card', offsetTop: 90, duration: 320 });
    });
  },
  toggleQualificationPanel() {
    this.setData({ showQualificationPanel: !this.data.showQualificationPanel });
  },
  goFinance() {
    wx.nextTick(() => {
      wx.pageScrollTo({ selector: '#merchant-payout-card', offsetTop: 90, duration: 320 });
    });
  },
  goRiskTask(event) {
    const { type, id } = event.currentTarget.dataset;
    const focusId = encodeURIComponent(id || '');
    if (!focusId) return;
    if (type === 'NEGATIVE_REVIEW') {
      return wx.navigateTo({ url: `/pages/merchant/reviews?focusId=${focusId}` });
    }
    if (type === 'LOW_STOCK') {
      return wx.navigateTo({ url: `/pages/merchant/products?focusId=${focusId}&filter=LOW` });
    }
    if (type === 'AUTO_DELIST') {
      const productIndex = this.data.delistedProducts.findIndex((item) => item.id === id);
      if (productIndex >= 0) {
        this.setData({ scoreCaseType: 'RECTIFY', rectifyProductIndex: productIndex });
      }
      this.setData({ focusId: id });
      wx.nextTick(() => {
        wx.pageScrollTo({ selector: `#merchant-delist-${id}`, offsetTop: 90, duration: 320 });
      });
      return;
    }
    if (type === 'SCORE_CASE') {
      this.setData({ focusId: id });
      wx.nextTick(() => {
        wx.pageScrollTo({ selector: `#merchant-score-case-${id}`, offsetTop: 90, duration: 320 });
      });
      return;
    }
    const filter = type === 'AFTER_SALE' ? '&filter=AFTER_SALE' : '';
    return wx.navigateTo({ url: `/pages/merchant/orders?focusId=${focusId}${filter}` });
  },
  openNotification(event) {
    const link = event.currentTarget.dataset.link;
    if (link) wx.navigateTo({ url: link });
  },
  setRenewalLicenseNo(event) {
    this.setData({ renewalLicenseNo: event.detail.value });
  },
  setRenewalNote(event) {
    this.setData({ renewalNote: event.detail.value });
  },
  setRenewalLicenseExpireDate(event) {
    this.setData({ renewalLicenseExpireDate: event.detail.value });
  },
  chooseQualificationImage() {
    if (this.data.uploadingRenewalEvidence) return;
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: ({ tempFiles = [] }) => {
        const file = tempFiles[0];
        if (!file) return;
        if ((file.size || 0) > 5 * 1024 * 1024) {
          wx.showToast({ title: '执照图片不能超过 5MB', icon: 'none' });
          return;
        }
        this.setData({ uploadingRenewalEvidence: true });
        wx.getFileSystemManager().readFile({
          filePath: file.tempFilePath,
          encoding: 'base64',
          success: ({ data }) => {
            const extension = String(file.tempFilePath || '').split('.').pop().toLowerCase();
            const mimeType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
            this.request('/api/uploads', { method: 'POST', data: { dataBase64: data, mimeType } })
              .then(({ data: upload }) => {
                this.setData({ renewalEvidence: [upload.url] });
                wx.showToast({ title: '执照已上传', icon: 'success' });
              })
              .catch((error) => wx.showToast({ title: error.message || '上传失败', icon: 'none' }))
              .finally(() => this.setData({ uploadingRenewalEvidence: false }));
          },
          fail: () => {
            this.setData({ uploadingRenewalEvidence: false });
            wx.showToast({ title: '读取照片失败', icon: 'none' });
          }
        });
      }
    });
  },
  previewQualificationImage() {
    const url = this.data.renewalEvidence[0];
    if (!url) return;
    wx.previewImage({ current: url, urls: [url] });
  },
  submitQualificationRenewal() {
    if (this.data.renewalSubmitting) return;
    if (!/^[0-9A-Z]{15,18}$/.test(this.data.renewalLicenseNo)) {
      wx.showToast({ title: '请填写正确执照编号', icon: 'none' });
      return;
    }
    if (!this.data.renewalEvidence.length) {
      wx.showToast({ title: '请上传新执照照片', icon: 'none' });
      return;
    }
    if (!this.data.renewalLicenseExpireDate) {
      wx.showToast({ title: '请选择新执照有效期', icon: 'none' });
      return;
    }
    this.setData({ renewalSubmitting: true });
    this.request('/api/merchant/qualification-renewals', {
      method: 'POST',
      data: {
        licenseNo: this.data.renewalLicenseNo,
        licenseUrl: this.data.renewalEvidence[0],
        licenseExpireDate: this.data.renewalLicenseExpireDate,
        note: this.data.renewalNote || '新营业执照已上传'
      }
    }).then(() => {
      wx.showToast({ title: '复审申请已提交', icon: 'success' });
      this.setData({ renewalLicenseExpireDate: '', renewalNote: '', renewalEvidence: [] });
      setTimeout(() => this.load(), 450);
    }).catch((error) => {
      wx.showModal({ title: '暂不能提交', content: error.message || '请稍后重试', showCancel: false });
    }).finally(() => this.setData({ renewalSubmitting: false }));
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
