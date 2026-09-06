const { request } = require('../../services/api');
const { getScooter } = require('../../services/store');
const { loadBusinessConfig } = require('../../services/business');

function normalizeProduct(product, config = {}, reviewFilter = 'ALL') {
  const description = product.description || '支持校内配送和校园牌照辅助。';
  const reviews = Array.isArray(product.reviews) ? product.reviews : [];
  const ratingSummary = product.ratingSummary || { average: 0, count: 0 };
  const relatedProducts = Array.isArray(product.relatedProducts) ? product.relatedProducts : [];
  // 可售库存 = 总库存 - 待支付订单占用，作为购买按钮与文案的唯一依据。
  const sellableStock = Number(product.availableStock !== undefined ? product.availableStock : product.stock || 0);
  const reservedStock = Number(product.reservedStock || 0);
  const deliveryHours = Number(config.deliveryResponseHours || 24);
  const plateHours = Number(config.plateResponseHours || 48);
  const afterSaleHours = Number(config.afterSaleResponseHours || 24);
  return {
    ...product,
    price: Math.round((product.priceInCents || 0) / 100),
    subtitle: description,
    badge: product.badge || '校园专享',
    range: product.range || (product.id === 'prod_ebike_rent_001' ? '70 km' : '45 km'),
    speed: product.speed || '25 km/h',
    policy: product.policy || '支持华中农业大学狮山校区校园牌照辅助申请。',
    service: product.service || ['校内配送', '平台购车牌照辅助', '售后专人跟进'],
    servicePromises: [
      { icon: '配', title: `${deliveryHours} 小时内响应`, detail: '确认校内配送安排' },
      { icon: '牌', title: `${plateHours} 小时内跟进`, detail: '平台购车免费辅助上牌' },
      { icon: '保', title: `${afterSaleHours} 小时内响应`, detail: '售后工单可请平台协助' }
    ],
    color: product.color || '#eaf0ff',
    icon: product.icon || '车',
    merchantName: product.merchantName || '平台自营',
    // 店铺服务分是平台已核验的履约结果，学生下单前应该看得到。
    merchantScoreCard: (() => {
      const score = product.merchantServiceScore;
      if (!score) return null;
      const stageNotes = {
        NORMAL: '履约与售后达标，平台正常展示',
        LIMITED: '平台已限流整改，下单前建议先咨询客服',
        RESTRICTED: '平台已暂停该店上新，下单前请联系客服确认'
      };
      return {
        score: score.score,
        gradeLabel: score.gradeLabel || '',
        stage: score.stage,
        stageLabel: score.stageLabel || '',
        toneClass: score.stage === 'NORMAL' ? 'good' : score.stage === 'LIMITED' ? 'watch' : 'risk',
        onTimeText: score.onTimeRate === null || score.onTimeRate === undefined ? '暂无完成订单' : `按时交付 ${score.onTimeRate}%`,
        reviewText: score.reviewCount ? `${score.reviewCount} 条已购评价 · 均分 ${Number(score.averageRating || 0).toFixed(1)}` : '暂无已购评价',
        noteText: stageNotes[score.stage] || ''
      };
    })(),
    review: {
      scoreText: ratingSummary.count ? ratingSummary.average.toFixed(1) : '新',
      count: ratingSummary.count || 0,
      countText: ratingSummary.count ? `${ratingSummary.count} 条校园订单评价` : '暂无已购订单评价',
      trustText: (() => {
        if (!ratingSummary.mediumNegativeCount) return '暂无中差评 · 已购核验';
        return `差评回复率 ${Math.round(Number(ratingSummary.lowReplyRate || 0) * 100)}% · 已购核验`;
      })()
    },
    reviewFilters: [
      { key: 'ALL', label: '全部', count: ratingSummary.count || 0 },
      { key: 'POSITIVE', label: '好评', count: ratingSummary.positiveCount || 0 },
      { key: 'MEDIUM', label: '中差评', count: ratingSummary.mediumNegativeCount || 0 },
      { key: 'REPLIED', label: '已回复', count: reviews.filter((review) => review.reply?.content).length }
    ],
    allReviews: reviews.map((review) => ({
      id: review.id,
      name: review.customerName || '匿名同学',
      initial: (review.customerName || '同').slice(0, 1),
      metaText: `${review.college || '华中农业大学'} · ${review.purchaseVerified ? '已购核验' : '未核验'} · ${String(review.createdAt || '').slice(0, 10)}`,
      stars: '★★★★★'.slice(0, Math.max(0, Math.min(5, Number(review.rating) || 0))),
      content: review.content || '',
      images: Array.isArray(review.images) ? review.images.slice(0, 3) : [],
      reply: review.reply ? {
        merchantName: review.reply.merchantName || '商家回复',
        content: review.reply.content || '',
        timeText: String(review.reply.repliedAt || '').slice(0, 10)
      } : null
    })),
    reviews: (() => {
      const decorated = reviews.map((review) => ({
        id: review.id,
        name: review.customerName || '匿名同学',
        initial: (review.customerName || '同').slice(0, 1),
        metaText: `${review.college || '华中农业大学'} · ${review.purchaseVerified ? '已购核验' : '未核验'} · ${String(review.createdAt || '').slice(0, 10)}`,
        stars: '★★★★★'.slice(0, Math.max(0, Math.min(5, Number(review.rating) || 0))),
        rating: Number(review.rating) || 0,
        content: review.content || '',
        images: Array.isArray(review.images) ? review.images.slice(0, 3) : [],
        replied: Boolean(review.reply?.content),
        reply: review.reply ? {
          merchantName: review.reply.merchantName || '商家回复',
          content: review.reply.content || '',
          timeText: String(review.reply.repliedAt || '').slice(0, 10)
        } : null
      }));
      if (reviewFilter === 'POSITIVE') return decorated.filter((review) => review.rating >= 4);
      if (reviewFilter === 'MEDIUM') return decorated.filter((review) => review.rating <= 3);
      if (reviewFilter === 'REPLIED') return decorated.filter((review) => review.replied);
      return decorated;
    })(),
    relatedProducts: relatedProducts.map((item) => ({
      id: item.id,
      name: item.name,
      subtitle: item.description,
      price: Math.round((item.priceInCents || 0) / 100),
      merchantName: item.merchantName || '平台自营',
      imageUrl: item.imageUrl || '',
      color: item.color || '#eaf0ff',
      icon: item.icon || '车',
      stockText: (() => {
        const relatedStock = Number(item.availableStock !== undefined ? item.availableStock : item.stock || 0);
        return relatedStock > 0 ? (relatedStock < 5 ? `仅剩 ${relatedStock} 件` : `库存 ${relatedStock}`) : '已售罄';
      })(),
      ratingText: item.ratingSummary?.count ? item.ratingSummary.average.toFixed(1) : '新'
    })),
    questions: [
      { id: 'q1', question: '能送到宿舍楼下吗？', answer: `支持校内配送，${deliveryHours} 小时内响应，可按你填写的校内地址送到楼下。` },
      { id: 'q2', question: '校园牌照怎么办理？', answer: `平台购车订单免费同步牌照辅助，${plateHours} 小时内跟进办理。` },
      { id: 'q3', question: '有售后保障吗？', answer: `支付后 ${afterSaleHours} 小时内响应，可在线协商、平台协助和提交售后工单。` }
    ],
    sellableStock,
    stockText: sellableStock > 0 ? (sellableStock < 5 ? `仅剩 ${sellableStock} 件` : `库存 ${sellableStock}`) : '已售罄',
    stockHint: reservedStock > 0 && sellableStock > 0 ? `另有 ${reservedStock} 件待支付占用，付款后释放` : ''
  };
}

Page({
  data: { scooter: null, config: null, reviewFilter: 'ALL', loading: true },
  onLoad(options) {
    loadBusinessConfig().then((config) => {
      this.setData({ config });
      if (this.rawProduct) this.setData({ scooter: normalizeProduct(this.rawProduct, config, this.data.reviewFilter) });
    });
    request(`/api/products/${encodeURIComponent(options.id || '')}`).then(({ data }) => {
      this.rawProduct = data;
      this.setData({ scooter: normalizeProduct(data, this.data.config || {}, this.data.reviewFilter), loading: false });
    }).catch(() => {
      const cached = getScooter(options.id);
      this.rawProduct = cached;
      if (cached) this.setData({ scooter: normalizeProduct(cached, this.data.config || {}, this.data.reviewFilter), loading: false });
      else { this.setData({ loading: false }); wx.showToast({ title: '商品加载失败', icon: 'none' }); }
    });
  },
  setReviewFilter(event) {
    const reviewFilter = event.currentTarget.dataset.key || 'ALL';
    if (!this.rawProduct) return;
    this.setData({
      reviewFilter,
      scooter: normalizeProduct(this.rawProduct, this.data.config || {}, reviewFilter)
    });
  },
  checkout() {
    if (Number(this.data.scooter.sellableStock || 0) <= 0) return wx.showToast({ title: '该车型暂无可售库存', icon: 'none' });
    wx.navigateTo({ url: `/pages/checkout/checkout?id=${encodeURIComponent(this.data.scooter.id)}` });
  },
  goRelated(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.redirectTo({ url: `/pages/detail/detail?id=${encodeURIComponent(id)}` });
  }
});
