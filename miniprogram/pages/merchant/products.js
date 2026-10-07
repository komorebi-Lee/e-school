const { request: apiRequest } = require('../../services/api');
const upload = require('../../utils/upload');
const loadState = require('../../utils/load-state');

const categories = [
  { value: 'E_BIKE_NEW', label: '电动车整车' },
  { value: 'DIGITAL', label: '数码配件' },
  { value: 'FOOD', label: '食品生鲜' },
  { value: 'SERVICE', label: '生活服务' }
];

const categoryLabels = { E_BIKE_NEW:'电动车整车', DIGITAL:'数码配件', FOOD:'食品生鲜', SERVICE:'生活服务' };

const emptyForm = { name: '', categoryIndex: 0, price: '', stock: '', description: '', imageUrl: '', active: true, salePrice: '', saleStartDate: '', saleStartTime: '00:00', saleEndDate: '', saleEndTime: '23:59' };
const stockMovementTypeLabels = {
  INITIAL: '初始化入库',
  ADJUST_IN: '补货入库',
  ADJUST_OUT: '库存调整',
  RESERVE: '下单预占',
  RELEASE: '取消释放',
  CONSUME: '支付扣减',
  RESTORE: '售后回补'
};
const stockMovementTones = {
  INITIAL: 'blue', ADJUST_IN: 'done', ADJUST_OUT: 'warn',
  RESERVE: 'blue', RELEASE: 'warn', CONSUME: 'blue', RESTORE: 'done'
};
const stockMovementFilters = [
  { key: 'ALL', label: '全部' },
  { key: 'STOCK_IN', label: '入库' },
  { key: 'STOCK_OUT', label: '调整' },
  { key: 'ORDER', label: '订单' },
  { key: 'RESTORE', label: '售后' }
];

Page({
  data: {
    categories, products: [], filtered: [], metrics: null, lowStockThreshold: 10, query: '', filter: 'ALL', focusId: '',
    filters: [
      { key:'ALL', label:'全部' },
      { key:'LOW', label:'低库存' },
      { key:'OFF', label:'已下架' }
    ],
    form: emptyForm, editId: '', loading: true,
    stockMovements: [], stockMovementFilters, stockMovementFilter: 'ALL',
    // ★ 两个块的失败状态（T49），**互相独立**：一个块失败不能让另一个块也进错误态。
    productsError: '', stockMovementsError: '',
    // ★ `stockMovementsLoaded`（T50）：区分「**还没取到**」与「取到了、但确实为空」。
    //   没有它，库存流水的空态只被 `!stockMovementsError` 守着，而它的初值是空串
    //   —— 于是**首屏那一次请求还没回来时**，页面已经渲染出「暂无库存流水」，
    //   而同一屏上商品块的「正在加载…」还在转。同一条假陈述的第三种触发时机
    //   （前两种是接口失败、以及改造前的清空数据）。
    //   ★ 为什么不能用 `!loading`：`loading` 是**商品块**的标志，而流水是
    //   **独立发起**的请求（见 `onLoad` 里那两行的注释），两者各自先后回来 ——
    //   拿商品块的标志去守流水的空态，只是把假陈述的窗口挪了个位置。
    //   ★ 成功与失败都要置 `true` —— 它回答的是「有没有得到答复」，不是「成不成功」。
    stockMovementsLoaded: false
  },
  onLoad(options = {}) {
    if (options.focusId) this.focusId = options.focusId;
    if (options.filter) this.setData({ filter: options.filter });
  },
  onShow() {
    this.load();
  },

  request(path, options = {}) {
    const token = wx.getStorageSync('campusGoMerchantToken');
    return apiRequest(path, { ...options, header: { authorization: `Bearer ${token}` } });
  },
  /**
   * 加载商品列表与库存流水。
   *
   * ★ 两个块**互相独立**（T49，对应 `utils/load-state.js` 的约定 3）：
   *   改造前 `loadStockMovements()` 被挂在 overview 请求的 `.then` 里，
   *   于是 overview 一挂，流水请求**根本不会发出**，`stockMovements` 停在 `[]`，
   *   页面同时渲染出两句假陈述：「没有匹配商品」+「暂无库存流水」。
   *   现在流水独立发起、独立记错，overview 失败不再牵连它。
   *
   * ★ 失败时**不清空** `products` / `filtered`，也不再弹
   *   「请重新进入商家工作台」的 toast —— 那句话与同屏的空态文案自相矛盾
   *   （一边说「没有匹配商品」，一边说「请重新进入」），而且它不提供任何可执行动作。
   *   改为可见、可重试的错误占位。
   */
  load() {
    this.loadStockMovements();
    this.request('/api/merchant/overview').then(({ data }) => {
      const products = (data.products || []).map((product) => {
        // 商家看到的“可售”已扣除待支付订单占用，补货判断以可售库存为准。
        const sellableStock = Number(product.availableStock !== undefined ? product.availableStock : product.stock || 0);
        const reservedStock = Number(product.reservedStock || 0);
        const lowStockThreshold = Number(data.lowStockThreshold ?? 10);
        return {
          ...product,
          categoryLabel: categoryLabels[product.category] || product.category,
          salesCount: Number(product.salesCount || 0),
          salesText: Number(product.salesCount || 0) > 0 ? `已售 ${Number(product.salesCount || 0)}` : '暂无销量',
          favoriteCount: Number(product.favoriteCount || 0),
          favoriteDemandText: product.favoriteDemandText || '暂无收藏需求',
          restockHint: product.restockHint || '',
          priceText: (Number(product.effectivePriceInCents ?? (product.priceInCents || 0)) / 100).toFixed(2),
          originalPriceText: product.promotion ? (Number(product.promotion.originalPriceInCents || 0) / 100).toFixed(2) : '',
          promotionText: product.promotion ? product.promotion.statusText : '',
          sellableStock,
          reservedStock,
          stockText: sellableStock === 0 ? '已售罄' : sellableStock <= lowStockThreshold ? `可售仅剩 ${sellableStock}` : `可售 ${sellableStock}`,
          stockDetailText: reservedStock > 0 ? `总库存 ${product.stock} · 待支付占用 ${reservedStock}` : `总库存 ${product.stock}`,
          hasImage: Boolean(product.imageUrl),
          autoDelisted: ['LOW_QUALITY', 'SERVICE_RISK'].includes(product.autoDelistRule) && !product.active,
          autoDelistText: product.autoDelistReason || '触发平台风控规则'
        };
      });
      this.setData({
        products,
        filtered: this.filterProducts(products, this.data.query, this.data.filter),
        metrics: data.metrics || null,
        lowStockThreshold: Number(data.lowStockThreshold ?? 10),
        loading: false,
        productsError: ''
      });
    }).then(() => {
      this.focusLoadedItem('merchant-product', this.data.products);
    }).catch((error) => {
      this.setData({ loading: false, productsError: loadState.blockErrorText(error) });
    });
  },
  retryProducts() { return this.load(); },
  loadStockMovements() {
    const movementType = this.data.stockMovementFilter;
    return this.request('/api/merchant/stock-movements?limit=50')
      .then(({ data }) => {
        // 得到了答复（哪怕答复是空列表）—— 从此才允许说「暂无库存流水」。
        this.setData({ stockMovements: this.decorateStockMovements(data || []), stockMovementsError: '', stockMovementsLoaded: true });
        return data;
      })
      .catch((error) => this.setData({
        stockMovementsError: loadState.blockErrorText(error),
        // ★ 失败也算「得到了答复」：此后由 `!stockMovementsError` 决定说不说空态，
        //   不再需要 `stockMovementsLoaded` 兜着「还没问过」这一种状态。
        stockMovementsLoaded: true
      }));
  },
  retryStockMovements() { return this.loadStockMovements(); },
  setStockMovementFilter(event) {
    const filter = event.currentTarget.dataset.key || 'ALL';
    if (filter === this.data.stockMovementFilter) return;
    this.setData({ stockMovementFilter: filter });
    this.loadStockMovements();
  },
  decorateStockMovements(items) {
    const group = this.data.stockMovementFilter;
    const merchantName = this.data.merchant?.name || '商家';
    return (items || [])
      .filter((item) => {
        if (group === 'STOCK_IN') return ['INITIAL', 'ADJUST_IN'].includes(item.movementType);
        if (group === 'STOCK_OUT') return item.movementType === 'ADJUST_OUT';
        if (group === 'ORDER') return ['RESERVE', 'RELEASE', 'CONSUME'].includes(item.movementType);
        if (group === 'RESTORE') return item.movementType === 'RESTORE';
        return true;
      })
      .map((item) => ({
        ...item,
        typeLabel: stockMovementTypeLabels[item.movementType] || item.movementType,
        typeTone: stockMovementTones[item.movementType] || 'blue',
        stockText: `${Number(item.stockBefore || 0)} → ${Number(item.stockAfter || 0)}`,
        reservedText: `${Number(item.reservedBefore || 0)} → ${Number(item.reservedAfter || 0)}`,
        operatorText: item.operator === 'ORDER_FLOW' ? '订单流程' : item.operator === 'ADMIN' ? '平台' : merchantName,
        timeText: String(item.createdAt || '').slice(5, 16).replace('T', ' ')
      }));
  },
  focusLoadedItem(prefix, items) {
    const focusId = this.focusId;
    if (!focusId || !(items || []).some((item) => item.id === focusId)) return;
    this.setData({ focusId });
    wx.nextTick(() => {
      wx.pageScrollTo({ selector: `#${prefix}-${focusId}`, offsetTop: 80, duration: 300 });
    });
  },
  setSearch(event) {
    const query = event.detail.value.trim();
    this.setData({ query, filtered: this.filterProducts(this.data.products, query, this.data.filter) });
  },
  setFilter(event) {
    const filter = event.currentTarget.dataset.key || 'ALL';
    this.setData({ filter, filtered: this.filterProducts(this.data.products, this.data.query, filter) });
  },
  filterProducts(products, query, filter) {
    const keyword = String(query || '').toLowerCase();
    return products.filter((product) => `${product.name} ${product.description}`.toLowerCase().includes(keyword)).filter((product) => {
      if (filter === 'LOW') return product.sellableStock <= (this.data.lowStockThreshold || 10);
      if (filter === 'OFF') return !product.active;
      return true;
    });
  },
  restock(event) {
    const product = this.data.products.find((item) => item.id === event.currentTarget.dataset.id);
    if (!product) return;
    wx.showModal({
      title: '快捷补货',
      editable: true,
      placeholderText: `请输入为“${product.name}”增加的库存数量`,
      success: (result) => {
        if (!result.confirm) return;
        const quantity = Number(result.content);
        if (!Number.isInteger(quantity) || quantity <= 0) {
          return wx.showToast({ title: '请输入大于 0 的整数', icon: 'none' });
        }
        this.request(`/api/merchant/products/${product.id}`, { method:'POST', data:{ stock: product.stock + quantity } }).then(() => {
          wx.showToast({ title: '库存已更新' });
          this.load();
        }).catch((error) => wx.showToast({ title: error.message || '补货失败', icon: 'none' }));
      }
    });
  },
  setField(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: event.detail.value });
  },
  setActive(event) {
    this.setData({ 'form.active': event.detail.value });
  },
  setCategory(event) {
    this.setData({ 'form.categoryIndex': Number(event.detail.value) });
  },
  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: ({ tempFiles }) => {
        const file = tempFiles && tempFiles[0];
        if (!file) return;
        // 读图失败时 `showLoading` 尚未调用，此时若调 `hideLoading` 会把别人的
        // loading 关掉 —— 改造前也只在真正发请求后才 hideLoading，这里保持同一约定。
        let readDone = false;
        upload.readImagePayload(file)
          .then((payload) => {
            readDone = true;
            wx.showLoading({ title: '上传中' });
            return apiRequest('/api/uploads', { method: 'POST', data: payload });
          })
          .then(({ data: result }) => {
            wx.hideLoading();
            this.setData({ 'form.imageUrl': result.url });
            wx.showToast({ title: '图片已上传', icon: 'success' });
          })
          .catch((error) => {
            if (readDone) wx.hideLoading();
            wx.showToast({ title: readDone ? (error.message || '图片上传失败') : '图片读取失败', icon: 'none' });
          });
      }
    });
  },
  removeImage() {
    this.setData({ 'form.imageUrl': '' });
  },
  select(event) {
    const item = this.data.products.find((product) => product.id === event.currentTarget.dataset.id);
    if (!item) return;
    this.setData({
      editId: item.id,
      form: {
        name: item.name,
        categoryIndex: Math.max(0, this.data.categories.findIndex((category) => category.value === item.category)),
        price: String(item.priceInCents / 100),
        salePrice: item.salePriceInCents ? String(item.salePriceInCents / 100) : '',
        saleStartDate: String(item.saleStartsAt || '').slice(0, 10),
        saleStartTime: String(item.saleStartsAt || '').slice(11, 16) || '00:00',
        saleEndDate: String(item.saleEndsAt || '').slice(0, 10),
        saleEndTime: String(item.saleEndsAt || '').slice(11, 16) || '23:59',
        stock: String(item.stock),
        description: item.description,
        imageUrl: item.imageUrl || '',
        active: item.active
      }
    });
  },
  reset() {
    this.setData({ editId: '', form: emptyForm });
  },
  submit() {
    const { name, categoryIndex, price, stock, description, imageUrl, active, salePrice, saleStartDate, saleStartTime, saleEndDate, saleEndTime } = this.data.form;
    const category = this.data.categories[categoryIndex];
    if (!name || !category || !price || stock === '') return wx.showToast({ title: '请完整填写商品信息', icon: 'none' });
    const payload = {
      name,
      category: category.value,
      description: description || '暂无简介',
      imageUrl,
      priceInCents: Math.round(Number(price) * 100),
      stock: Number(stock),
      active
    };
    if (salePrice) {
      if (!saleStartDate || !saleEndDate) return wx.showToast({ title: '请选择特价起止日期', icon: 'none' });
      payload.salePriceInCents = Math.round(Number(salePrice) * 100);
      payload.saleStartsAt = new Date(`${saleStartDate}T${saleStartTime || '00:00'}:00`).toISOString();
      payload.saleEndsAt = new Date(`${saleEndDate}T${saleEndTime || '23:59'}:00`).toISOString();
    }
    const path = this.data.editId ? `/api/merchant/products/${this.data.editId}` : '/api/merchant/products';
    this.request(path, { method: 'POST', data: payload }).then(() => {
      wx.showToast({ title: this.data.editId ? '商品已保存' : '商品已上架' });
      this.reset();
      this.load();
    }).catch((error) => wx.showToast({ title: error.message || '保存失败', icon: 'none' }));
  },
  toggle(event) {
    const { id, active } = event.currentTarget.dataset;
    this.request(`/api/merchant/products/${id}`, { method: 'POST', data: { active: !active } }).then(() => this.load()).catch((error) => wx.showToast({ title: error.message || '操作失败', icon: 'none' }));
  }
});
