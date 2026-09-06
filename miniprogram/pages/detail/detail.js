const { request } = require('../../services/api');
const { getScooter } = require('../../services/store');

function normalizeProduct(product) {
  const description = product.description || '支持校内配送和校园牌照辅助。';
  const reviews = Array.isArray(product.reviews) ? product.reviews : [];
  const ratingSummary = product.ratingSummary || { average: 0, count: 0 };
  const relatedProducts = Array.isArray(product.relatedProducts) ? product.relatedProducts : [];
  // 可售库存 = 总库存 - 待支付订单占用，作为购买按钮与文案的唯一依据。
  const sellableStock = Number(product.availableStock !== undefined ? product.availableStock : product.stock || 0);
  const reservedStock = Number(product.reservedStock || 0);
  return {
    ...product,
    price: Math.round((product.priceInCents || 0) / 100),
    subtitle: description,
    badge: product.badge || '校园专享',
    range: product.range || (product.id === 'prod_ebike_rent_001' ? '70 km' : '45 km'),
    speed: product.speed || '25 km/h',
    policy: product.policy || '支持华中农业大学狮山校区校园牌照辅助申请。',
    service: product.service || ['校内配送', '平台购车牌照辅助', '售后专人跟进'],
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
      trustText: '来自平台核验的已购学生'
    },
    reviews: reviews.map((review) => ({
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
      { id: 'q1', question: '能送到宿舍楼下吗？', answer: '支持校内配送，可按你填写的校内地址送到楼下。' },
      { id: 'q2', question: '校园牌照怎么办理？', answer: '平台购车订单免费同步牌照辅助，支付后即可查看办理入口。' },
      { id: 'q3', question: '有售后保障吗？', answer: '订单支持在线协商、平台协助和售后工单，重点看车况与充电适配。' }
    ],
    sellableStock,
    stockText: sellableStock > 0 ? (sellableStock < 5 ? `仅剩 ${sellableStock} 件` : `库存 ${sellableStock}`) : '已售罄',
    stockHint: reservedStock > 0 && sellableStock > 0 ? `另有 ${reservedStock} 件待支付占用，付款后释放` : ''
  };
}

Page({
  data: { scooter: null, loading: true },
  onLoad(options) {
    request(`/api/products/${encodeURIComponent(options.id || '')}`).then(({ data }) => {
      this.setData({ scooter: normalizeProduct(data), loading: false });
    }).catch(() => {
      const cached = getScooter(options.id);
      if (cached) this.setData({ scooter: normalizeProduct(cached), loading: false });
      else { this.setData({ loading: false }); wx.showToast({ title: '商品加载失败', icon: 'none' }); }
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
