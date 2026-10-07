const { request } = require('../../services/api');
const loadState = require('../../utils/load-state');
const { isNotFoundError } = require('../../utils/request-error');

const categoryLabels = {
  E_BIKE_NEW: "电动车",
  PHONE_PLAN: "电话套餐",
  RECHARGE_PROMO: "话费权益",
  SERVICE: "服务"
};

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
    category: product.category || "",
    categoryText: categoryLabels[product.category] || "校园服务",
    sellableStock: stock
  };
}

Page({
  data: {
    store: null,
    products: [],
    filteredProducts: [],
    reviews: [],
    loading: true,
    // ★ 失败分流的两个标志（T49）。二者互斥：`storeNotFound` 只在**确定的 404** 时为真，
    //   `storefrontError` 只在**可重试的失败**（网络 / 5xx）时非空。
    //   初值必须是「都没失败」——否则首屏会闪一下错误占位。
    storefrontError: "",
    storeNotFound: false,
    query: "",
    activeCategory: "ALL",
    sortKey: "recommend",
    sortOptions: [
      { key: "recommend", text: "综合" },
      { key: "price", text: "价格" },
      { key: "sales", text: "销量" },
      { key: "rating", text: "评分" }
    ],
    categories: [{ key: "ALL", text: "全部" }]
  },
  onLoad(options) {
    this.storeId = (options && options.id) || '';
    this.loadStorefront();
  },
  /**
   * 加载店铺门面（店铺信息 + 在售商品 + 同学评价）。
   *
   * ★ 三态与失败分流（T49）：
   *   - **成功** → `store` / `products` / `reviews` 一起写入，两个失败标志清空；
   *   - **404**（`STOREFRONT_NOT_FOUND`）→ `storeNotFound = true`，展示**常驻**的
   *     「店铺不存在或未通过平台核准」；不给重试入口（重试一百次还是 404），
   *     也不弹 toast（toast 一两秒就消失，用户视线一挪开就看不到原因）；
   *   - **网络失败 / 5xx** → `storefrontError` 非空，展示**可重试**的错误占位，
   *     并且**不清空**任何已加载数据。
   *
   * ★ 为什么三个渲染点共用 `storefrontError` 一个标志：它们来自**同一个**端点，
   *   不存在「店铺取到了但商品没取到」的中间态。给三个点**各自**写上守卫
   *   （`store.wxml` 的 `:3` / `:63` / `:84`）是为了：(a) 每一个点都不再能落进空态；
   *   (b) 将来若把门面端点拆成三个，只需把标志改名，不必重新去找渲染点。
   *
   * 改造前这里是一句
   * `setData({ loading: false, store: null, products: [], reviews: [] })` ——
   * 一个 catch 同时把三个渲染点打进空态：店铺卡说「店铺不存在或未通过平台核准」、
   * 商品区说「这家店暂无在售商品」、评价区说「这家店暂无已购评价」。
   * 对一家**真实在营**的商家，这三句都是假陈述。
   */
  loadStorefront() {
    return request(`/api/merchants/${encodeURIComponent(this.storeId || '')}/storefront`).then(({ data }) => {
      const score = data.merchant?.serviceScore || null;
      const reviewSummary = data.reviewSummary || { count: 0, averageRating: 0, positiveRate: 0 };
      this.setData({
        loading: false,
        storefrontError: '',
        storeNotFound: false,
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
      const categoryKeys = [...new Set(this.data.products.map((item) => item.category).filter(Boolean))];
      this.setData({
        categories: [{ key: "ALL", text: "全部" }, ...categoryKeys.map((key) => ({ key, text: key }))]
      });
      this.applyFilters();
    }).catch((error) => {
      if (isNotFoundError(error)) {
        // 服务端把「从未存在」与「存在但未通过平台核准」合成同一个 404
        // （`app.js:5108`：`item.id === ... && item.status === 'APPROVED'` 一起过滤，
        // 实测 `merchant_002`（status=REVIEWING）与不存在的 id 返回**逐字节相同**的
        // `404 / STOREFRONT_NOT_FOUND / 店铺不存在或未通过平台核准`）。
        // 服务端既然不能区分，客户端就**不得暗示**确定是其中哪一种 ——
        // 所以这里原样保留那句「或」，只是把它挪到「确定是 404」的分支上。
        this.setData({ loading: false, storeNotFound: true, storefrontError: '' });
        return;
      }
      // 网络失败 / 5xx：重试有意义。**不清空** store / products / reviews ——
      // 旧数据比「假装没有数据」有用得多，而清空等于向用户断言「这里本来就没有东西」。
      this.setData({ loading: false, storefrontError: loadState.blockErrorText(error) });
    });
  },
  retryStorefront() {
    return this.loadStorefront();
  },
  onShareAppMessage() {
    const store = this.data.store;
    if (!store) return { title: "狮山智生活 · 校园好店", path: "/pages/home/home" };
    return {
      title: `${store.name} · 校内配送 · 狮山智生活`,
      path: `/pages/store/store?id=${encodeURIComponent(store.id)}`
    };
  },
  onShareTimeline() {
    const store = this.data.store;
    return { title: store ? `${store.name} · 狮山智生活` : "狮山智生活 · 校园好店" };
  },
  goProduct(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(id)}` });
  },
  setSearch(event) {
    this.setData({ query: event.detail.value.trim() });
    this.applyFilters();
  },
  setCategory(event) {
    this.setData({ activeCategory: event.currentTarget.dataset.key || "ALL" });
    this.applyFilters();
  },
  setSort(event) {
    this.setData({ sortKey: event.currentTarget.dataset.key || "recommend" });
    this.applyFilters();
  },
  applyFilters() {
    const { products, query, activeCategory, sortKey } = this.data;
    const keyword = query.toLowerCase();
    let filtered = products.filter((item) => (
      (activeCategory === "ALL" || item.category === activeCategory)
      && `${item.name} ${item.description} ${item.categoryText}`.toLowerCase().includes(keyword)
    ));
    const sorters = {
      price: (a, b) => Number(a.price) - Number(b.price),
      sales: (a, b) => Number(b.salesCount || 0) - Number(a.salesCount || 0),
      rating: (a, b) => Number(b.ratingSummary?.average || 0) - Number(a.ratingSummary?.average || 0)
    };
    if (sorters[sortKey]) filtered = filtered.sort(sorters[sortKey]);
    this.setData({ filteredProducts: filtered });
  },
  previewProductImage(event) {
    const url = event.currentTarget.dataset.url;
    if (!url) return;
    wx.previewImage({ current: url, urls: [url] });
  },
  previewReviewImages(event) {
    const urls = event.currentTarget.dataset.urls;
    const current = event.currentTarget.dataset.url;
    if (!Array.isArray(urls) || !urls.length) return;
    wx.previewImage({ current: current || urls[0], urls });
  }
});
