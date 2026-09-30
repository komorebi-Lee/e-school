/**
 * 订单卡片装饰层（纯函数）。
 *
 * ## 为什么从 `orders.js` 抽出来
 *
 * 改造前 `orders.js` 里的 `card(item)` 有 110 行：它把服务端订单**翻译**成
 * 模板能直接渲染的字段（类型名 / 色调 / 进度条 / 售后面板 / 租赁面板 /
 * 平台处理结果 / 按钮组）。这段翻译逻辑是订单页最容易出错、也最需要回归
 * 保护的部分 —— 但它住在页面脚本里，而页面脚本顶层调用 `Page()`，Node 无法
 * 加载，页内分支只能做源码文本断言（文本断言连注释都能满足）。
 *
 * 抽成纯函数模块后，`card()` 的真实输出可以被 `test/miniapp-runtime.test.js`
 * 直接断言：部分退款、超时关闭、售后超时、租赁分流……全部有运行时覆盖。
 * `orders.js` 从此只负责「取数 → `map(card)` → `setData`」。
 *
 * ## 约定
 *
 * - **只读**：不访问 `wx` / `getApp` / `Page`，不修改入参。
 * - **缺省即售卖**：`orderKind` 缺失（存量订单）一律按售卖处理（见
 *   `rental-journey.js` 的 `isRentalOrder`）。
 * - **租赁分流单点**：进度条与文案是否走租赁，只由 `rental-journey.js` 决定，
 *   本模块不复制任何租赁判定。
 * - **文案表仍归本模块所有**：`ebikeJourney` / `afterSaleJourney` 由本模块持有
 *   并注入 `rental-journey.js` 的 `selectOrderJourney`，避免同一份售卖文案两处维护。
 */

const rentalJourney = require('./rental-journey');
const { paymentCountdownText, isPaymentUrgent } = require('./format');

/** 客服承诺响应时长的默认值（小时）；页面会用服务端配置覆盖。 */
const DEFAULT_RESPONSE_HOURS = 24;

/** 订单类型中文名。 */
const typeNames = { E_BIKE:'电瓶车', PHONE_PLAN:'电话卡', RECHARGE:'话费权益', BROADBAND:'宽带', PLATE:'校园牌照' };

/** 协同轨迹里的角色名。 */
const roleNames = { USER:'我', MERCHANT:'商家', PLATFORM:'平台' };

/** 售卖（电瓶车）订单进度条文案表。 */
const ebikeJourney = {
  PENDING_PAYMENT: [
    { title:'订单已创建', detail:'库存已为你预留', done:true },
    { title:'等待支付', detail:'超时后库存自动释放', done:false },
    { title:'商家确认履约', detail:'支付成功后开始', done:false },
    { title:'校内配送', detail:'凭交付码收车', done:false }
  ],
  PAID: [
    { title:'支付成功', detail:'免费校园牌照辅助已同步', done:true },
    { title:'等待商家确认', detail:'商家会确认配送安排', done:false },
    { title:'校内配送', detail:'确认地址和时段', done:false },
    { title:'交付核验', detail:'凭交付码收车', done:false }
  ],
  FULFILLING: [
    { title:'支付成功', detail:'车辆已进入履约', done:true },
    { title:'商家已接单', detail:'按约定时间配送', done:true },
    { title:'校内配送中', detail:'保持联系方式畅通', done:false },
    { title:'交付核验', detail:'向商家出示交付码', done:false }
  ],
  COMPLETED: [
    { title:'支付成功', detail:'订单已生效', done:true },
    { title:'商家履约', detail:'车辆已交付', done:true },
    { title:'交付核验', detail:'交付码已核验', done:true },
    { title:'服务评价', detail:'可分享真实使用体验', done:false }
  ],
  CANCELLED: [
    { title:'订单已取消', detail:'占用库存已释放', done:true },
    { title:'如已误操作', detail:'可重新下单', done:false }
  ],
  AFTER_SALE: [
    { title:'售后已开启', detail:'商家和平台可跟进', done:true },
    { title:'处理中', detail:'可补充问题照片和说明', done:false },
    { title:'处理完成', detail:'结果会同步到订单', done:false }
  ]
};

/** 售后进度条文案表（按售后工单状态取）。 */
const afterSaleJourney = {
  SUBMITTED: [
    { title:'售后已受理', detail:'商家和平台都能看到这单', done:true },
    { title:'等待处理', detail:'注意响应时限，可补充照片', done:false },
    { title:'处理完成', detail:'商家结论会同步到订单', done:false }
  ],
  REVIEWING: [
    { title:'售后已受理', detail:'商家已接收工单', done:true },
    { title:'处理中', detail:'可继续补充问题说明', done:true },
    { title:'处理完成', detail:'商家结论会同步到订单', done:false }
  ],
  CLOSED: [
    { title:'售后已受理', detail:'处理流程已启动', done:true },
    { title:'处理中', detail:'商家完成跟进', done:true },
    { title:'处理完成', detail:'可查看处理结果', done:true }
  ],
  REJECTED: [
    { title:'售后已受理', detail:'处理流程已启动', done:true },
    { title:'商家反馈', detail:'本次申请未通过', done:true },
    { title:'如仍有异议', detail:'可联系平台协助', done:false }
  ]
};

/** 订单状态 → 状态徽标色调（与 `.tone-*` 样式类一一对应）。 */
const statusTones = {
  PENDING_PAYMENT:'todo', PAID:'blue', FULFILLING:'run', COMPLETED:'done', CANCELLED:'closed', AFTER_SALE:'warn',
  PENDING_REALNAME:'todo', ACTIVATED:'done', REJECTED:'closed',
  PENDING_CREDIT:'todo', CREDITED:'done',
  PENDING_VERIFY:'todo', APPROVED:'done',
  MATERIAL_PENDING:'todo', REVIEWING:'run'
};

/**
 * 把时间格式化成「前缀 月/日 时:分」。
 *
 * @param {unknown} value 时间值。
 * @param {string} prefix 前缀，如 `'响应截止'`。
 * @returns {string} 文案；`value` 缺失或非法时返回空串。
 */
function formatDueText(value, prefix) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${prefix} ${date.toLocaleDateString()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * 装饰一条售后工单：补色调、截止文案、超时状态与状态标签。
 *
 * @param {object} record 售后工单。
 * @returns {object} 装饰后的工单（新对象，不改动入参）。
 */
function decorateAfterSale(record) {
  const tone = record.status === 'CLOSED' ? 'done' : record.status === 'REVIEWING' ? 'run' : 'todo';
  return {
    ...record,
    tone,
    responseDueText: formatDueText(record.responseDueAt, '响应截止'),
    resolutionDueText: formatDueText(record.resolutionDueAt, '处理截止'),
    isOverdue: Boolean(record.status !== 'CLOSED' && record.responseDueAt
      && new Date(record.responseDueAt).getTime() < Date.now()),
    overdueText: record.status !== 'CLOSED' && record.responseDueAt
      && new Date(record.responseDueAt).getTime() < Date.now()
      ? '已超过承诺响应时限，平台已加入催办' : '',
    statusLabel: record.statusLabel || { SUBMITTED:'待处理', REVIEWING:'处理中', CLOSED:'已完成', REJECTED:'未通过' }[record.status] || record.status
  };
}

/**
 * 租赁单的「下一步」文案。
 *
 * 绝不能出现「向商家出示交付码完成配送」这类售卖 / 配送措辞 ——
 * 租赁的真实流程是「取车 → 租期中 → 申请归还 → 归还完成」。
 *
 * @param {object} order 订单记录。
 * @returns {string} 下一步文案。
 */
function rentalNextStep(order) {
  const status = rentalJourney.rentalStatusOf(order);
  if (status === 'RETURNED') return '归还已完成，等待押金原路退回';
  if (status === 'RETURN_REQUESTED') return '已提交归还申请，等待商家核验';
  return '凭交付码到校内取车点取车，按租期归还';
}

/**
 * 把一条服务端订单翻译成模板可直接渲染的卡片数据。
 *
 * @param {object} item 服务端订单记录（已含 `type` / `status` / `orderKind` 等）。
 * @returns {object} 卡片数据（新对象，不改动入参）。
 */
function card(item) {
  const isEbike = item.type === 'E_BIKE';
  const type = item.type;
  // 租赁单沿用 `type: 'E_BIKE'`（交付码 / 履约 / 数量统计都依赖它），
  // 但进度条与文案必须按 `orderKind` 分流，否则租赁单会显示「校内配送 / 凭交付码收车」。
  const isRental = rentalJourney.isRentalOrder(item);
  const rentalCard = isRental ? rentalJourney.rentalCardText(item) : null;
  // 归还完成后不再展示应还倒计时：车与钱都已结清，倒计时只会制造无意义焦虑。
  const rentalDueAt = isRental && item.rental && item.rental.status !== 'RETURNED' ? (item.rental.dueAt || '') : '';
  const orderAfterSales = (item.afterSales || []).map(decorateAfterSale);
  const activeAfterSale = orderAfterSales.find(record => record.status !== 'CLOSED') || orderAfterSales[0] || null;
  const overdueAfterSale = orderAfterSales.find(record => record.isOverdue);
  const totalQuantity = isEbike ? (item.items || []).reduce((sum, orderItem) => sum + Number(orderItem.quantity || 0), 0) : 0;
  const refundedQuantity = Number(item.refundedQuantity || 0);
  const remainingQuantity = Math.max(0, totalQuantity - refundedQuantity);
  const isPartiallyRefunded = item.paymentStatus === 'PARTIALLY_REFUNDED'
    && refundedQuantity > 0 && remainingQuantity > 0;
  const refundAmountText = Number(item.partialRefundedInCents || 0) > 0
    ? ` · 已退 ¥${(Number(item.partialRefundedInCents) / 100).toFixed(2)}`
    : '';
  const actions = [];
  if (item.merchantId && type === 'E_BIKE') {
    actions.push({ key:'store', text:'进店', merchantId:item.merchantId });
  }
  if (item.status === 'PENDING_PAYMENT' && ['E_BIKE','PHONE_PLAN','RECHARGE','PLATE'].includes(type)) {
    actions.push({ key:'pay', text:'去支付' });
    actions.push({ key:'cancel', text:'取消订单' });
  }
  const fulfillment = isEbike ? (item.fulfillment || {}) : {};
  const reviewedProductIds = item.reviewedProductIds || [];
  if (type === 'E_BIKE') {
    if (item.status === 'COMPLETED') {
      const buyAgainProduct = (item.items || []).find((orderItem) => orderItem.productId);
      if (buyAgainProduct) {
        actions.push({ key:'buyAgain', text:'再次购买', productId:buyAgainProduct.productId });
      }
      (item.items || []).forEach((orderItem) => {
        if (!reviewedProductIds.includes(orderItem.productId)) {
          actions.push({ key:`review:${orderItem.productId}`, type:'review', text:`评价 ${orderItem.name}`, productId:orderItem.productId });
        }
      });
    }
    if (!['COMPLETED','CANCELLED','AFTER_SALE'].includes(item.status)) actions.push({ key:'edit', text:'修改配送' });
  if (item.status !== 'CANCELLED') actions.push({ key:'collab', text:'联系商家', action:'NOTE' });
    if (!['COMPLETED','CANCELLED','AFTER_SALE'].includes(item.status)) actions.push({ key:'appeal', text:'平台协助', action:'APPEAL' });
    if (!['CANCELLED'].includes(item.status)) actions.push({ key:'aftersale', text:item.status === 'AFTER_SALE' ? '售后详情' : '申请售后' });
  }
  if (type === 'PHONE_PLAN') {
    if (item.status === 'PENDING_REALNAME') actions.push({ key:'consult', text:'实名咨询', business:'电话卡实名激活' });
    if (item.relatedIds.broadbandApplicationId) actions.push({ key:'filter', text:'查看宽带', filter:'BROADBAND' });
    else actions.push({ key:'action', text:'申请宽带', action:'APPLY_BROADBAND', disabled:item.status !== 'ACTIVATED', reason:'完成实名激活后可申请' });
  }
  if (type === 'RECHARGE') {
    actions.push({ key:'detail', text:'\u6743\u76ca\u8be6\u60c5', rechargeId:item.id });
    if (item.status === 'PENDING_CREDIT') actions.push({ key:'consult', text:'到账咨询', business:'话费到账确认' });
    if (item.relatedIds.phoneCardOrderId) actions.push({ key:'action', text:'激活电话卡', action:'ACTIVATE_CARD', disabled:!['PENDING_CREDIT','CREDITED'].includes(item.status), reason:'支付后可激活' });
  }
  if (type === 'BROADBAND') actions.push({ key:'consult', text:item.status === 'APPROVED' ? '预约安装' : '核验咨询', business:item.status === 'APPROVED' ? '宽带安装预约' : '宽带资格核验' });
  if (type === 'PLATE' && item.status !== 'PENDING_PAYMENT') {
    actions.push({ key:'materials', text:`上传材料${item.materialCount ? ` (${item.materialCount}/9)` : ''}`, disabled:item.status !== 'MATERIAL_PENDING' && item.status !== 'REVIEWING' });
    actions.push({ key:'consult', text:'办理咨询', business:'校园牌照辅助' });
  }

  return {
    ...item,
    typeLabel: typeNames[type] || '服务',
    icon: type === 'E_BIKE' ? '车' : type === 'PHONE_PLAN' ? '卡' : type === 'RECHARGE' ? '充' : type === 'BROADBAND' ? '网' : '牌',
    tone: statusTones[item.status] || 'todo',
    timeText: (item.updatedAt || item.createdAt || '').slice(5,16).replace('T',' '),
    countdownText: item.status === 'PENDING_PAYMENT' ? paymentCountdownText(item.paymentExpiresAt) : '',
    // 紧急档（剩余 ≤5 分钟）由模板加 `countdown-urgent` 类做高亮；判定与文案同源。
    countdownUrgent: item.status === 'PENDING_PAYMENT' ? isPaymentUrgent(item.paymentExpiresAt) : false,
    deliveryCode: isEbike && !['PENDING_PAYMENT','CANCELLED'].includes(item.status) ? (item.deliveryCode || '') : '',
    priceText: item.amountInCents ? `¥${(item.amountInCents / 100).toFixed(2)}` : '',
    statusLabel: isPartiallyRefunded ? '部分退款' : (item.cancelReason === 'PAYMENT_TIMEOUT' ? '已超时关闭' : (item.statusLabel || '处理中')),
    statusNote: isPartiallyRefunded ? `已退 ${refundedQuantity} 件，剩余 ${remainingQuantity} 件继续履约${refundAmountText}`
      : (item.cancelReason === 'PAYMENT_TIMEOUT' ? '超过支付时限自动关闭，可重新下单' : ''),
    deliveryText: fulfillment.address ? `${fulfillment.date || '尽快配送'} · ${fulfillment.address}` : '',
    actions,
    merchantName:item.merchantName || '',
    messageStatus:item.collaboration?.unrepliedMessage
      ? `已提交留言，预计 ${DEFAULT_RESPONSE_HOURS} 小时内回复`
      : (item.collaboration?.messages || []).some(message => ['MERCHANT', 'PLATFORM'].includes(message.role) && message.text !== '订单已支付，等待商家确认履约。')
        ? '客服已回复'
        : '',
    afterSale: activeAfterSale,
    afterSaleOverdue: Boolean(overdueAfterSale),
    isRental,
    rentalPriceText: rentalCard ? rentalCard.priceText : '',
    rentalTermText: rentalCard ? rentalCard.termText : '',
    rentalDepositText: rentalCard ? rentalCard.depositText : '',
    rentalDueAtText: rentalCard ? rentalCard.dueAtText : '',
    rentalCountdownAt: rentalDueAt,
    rentalCountdownText: rentalDueAt ? rentalJourney.rentalCountdownText(rentalDueAt, new Date()) : '',
    rentalOverdue: rentalDueAt ? rentalJourney.isRentalOverdue(rentalDueAt, new Date()) : false,
    // 归还入口：仅租赁单且 `rental.status === 'RENTING'`（纯函数判定，可运行时断言）。
    canReturnRequest: rentalJourney.canRequestReturn(item),
    // 进度条的唯一选择点：租赁走租赁进度条，售卖仍走 ebikeJourney（回归不变）。
    journey: rentalJourney.selectOrderJourney({ order: item, isEbike, status: item.status, activeAfterSale, ebikeJourney, afterSaleJourney }),
    nextStep: isRental ? rentalNextStep(item) : isEbike && item.status === 'FULFILLING' ? '向商家出示交付码完成配送' : item.collaboration?.roleActions?.MERCHANT?.length ? '商家确认履约' : item.collaboration?.roleActions?.PLATFORM?.length ? '平台介入处理' : item.status === 'COMPLETED' ? '可评价本次服务' : '等待履约更新',
    intervention:item.collaboration?.intervention?.status === 'REQUESTED',
    platformResult:item.collaboration?.intervention?.status === 'RESOLVED' && item.collaboration?.intervention?.note
      ? {
        note: item.collaboration.intervention.note,
        timeText: String(item.collaboration.intervention.updatedAt || item.collaboration.intervention.createdAt || '').replace('T',' ').slice(5,16)
      }
      : null,
    messages:(item.collaboration?.messages || []).slice(0,2),
    timeline:(item.collaboration?.handoffs || []).slice(0,4).map((handoff, index) => ({
      id:index,
      roleLabel:roleNames[handoff.role] || '平台',
      note:handoff.note || '状态已更新',
      timeText:String(handoff.createdAt || '').replace('T',' ').slice(5,16)
    }))
  };
}

module.exports = {
  DEFAULT_RESPONSE_HOURS,
  typeNames,
  roleNames,
  ebikeJourney,
  afterSaleJourney,
  statusTones,
  formatDueText,
  decorateAfterSale,
  rentalNextStep,
  card
};
