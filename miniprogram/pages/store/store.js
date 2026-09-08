const { request } = require('../../services/api');

function decorateStoreReview(review) {
  return {
    id: review.id,
    rating: Number(review.rating) || 0,
    stars: '★★★★★'.slice(0, Math.max(0, Math.min(5, Number(review.rating) || 0))),
    content: review.content || '',
    images: Array.isArray(review.images) ? review.images.slice(0, 3) : [],
    customerName: review.customerName || '匿名同学',
    college: review.college || '',
    productName: review.productName || '平台商品',
    timeText: String(review.createdAt || '').slice(0, 10),
    reply: review.reply || null
  };
}

function decorateProduct(product) {
  const stock = Number(product.availableStock ?? (product.stock || 0));
  return {
    id: product.id,
    name: product.name,
    description: product.description || '',
    imageUrl: product.imageUrl || '',
    icon: product.icon || '车',
    color: product.color || '#eaf0ff',
    price: ((Number(product.effectivePriceInCents ?? (product.priceInCents || 0))) / 100).toFixed(2),
    originalPrice: product.promotion?.originalPriceInCents
      ? (Number(product.promotion.originalPriceInCents) / 100).toFixed(2) : '',
    promoText: product.promotion?.statusText || '',
    stockText: stock > 0 ? (stock < 5 ? `仅剩 ${stock} 件` : `库存 ${stock}`) : '已售罄',
    salesText: Number(product.salesCount || 0) > 0 ? `已售 ${product.salesCount}` : '新品上架',
    ratingText: product.ratingSummary?.count ? Number(product.ratingSummary.average || 0).toFixed(1) : '新',
    sellableStock: stock
  };
}

Page({
  data: { store: null, products: [], reviews: [], loading: true },
  onLoad(options) {
    request(`/api/merchants/${encodeURIComponent(options.id || '')}/storefront`).then(({ data }) => {
      const score = data.merchant?.serviceScore || null;
      const reviewSummary = data.reviewSummary || { count: 0, averageRating: 0, positiveRate: 0 };
      this.setData({
        loading: false,
        store: {
          ...data.merchant,
          scoreText: score ? String(score.score) : '待评估',
          gradeText: score ? score.gradeLabel || '平台已核验' : '平台已核验',
          scoreToneClass: score ? (score.stage === 'NORMAL' ? 'good' : score.stage === 'LIMITED' ? 'watch' : 'risk') : 'new',
          scoreNote: score ? (score.stage === 'NORMAL' ? '履约与售后达标' : score.stage === 'LIMITED' ? '平台已限流整改' : '平台已暂停上新') : '新商家已完成平台核准',
          statsText: `${data.productCount || 0} 件在售 · 已售 ${data.totalSalesCount || 0}`,
          responseText: `校内配送 ${data.deliveryResponseHours || 24} 小时内响应`,
          reviewText: reviewSummary.count
            ? `${reviewSummary.count} 条已购评价 · 均分 ${Number(reviewSummary.averageRating || 0).toFixed(1)}`
            : '暂无已购评价',
          positiveRateText: reviewSummary.count
            ? `好评率 ${Math.round(Number(reviewSummary.positiveRate || 0) * 100)}%`
            : '等待首条评价'
        },
        products: (data.products || []).map(decorateProduct),
        reviews: (data.reviews || []).map(decorateStoreReview)
      });
    }).catch((error) => {
      this.setData({ loading: false, store: null, products: [], reviews: [] });
      wx.showToast({ title: error.message || '店铺加载失败', icon: 'none' });
    });
  },
  goProduct(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(id)}` });
  }
});
