const { request, userId } = require('../../services/api');
const { payPaymentOrderById } = require('../../services/payment');
const { loadBusinessConfig } = require('../../services/business');
// 租赁订单展示层：进度条 / 应还倒计时 / 卡片文案 / 归还入口判定。
// 全部是纯函数，可被 test/miniapp-runtime.test.js 真实加载断言。
const rentalJourney = require('../../utils/rental-journey');
const loadState = require('../../utils/load-state');
// 待支付倒计时分级（文案 + 紧急判定）：纯函数，可被 test/miniapp-runtime.test.js 真实加载断言。
const format = require('../../utils/format');
// 订单卡片装饰层：`card(item)` 与其文案表已抽出，页面只负责「取数 → map(card) → setData」。
const orderCard = require('../../utils/order-card');

const consultQuestions = {
  PHONE_PLAN: ['实名审核需要多久？','实名信息填错了怎么修改？','订单进度请帮忙查询'],
  RECHARGE: ['话费预计什么时候到账？','到账金额和订单不一致','请帮我核对到账进度'],
  BROADBAND: ['资格核验预计多久通过？','什么时候可以安排安装？','请帮我查询核验进度'],
  PLATE: ['还需要补充哪些材料？','办理进度请帮忙查询','办理完成后如何领牌？']
};

// 待支付倒计时的刷新节奏：存在紧急订单（剩余 ≤5 分钟）时按秒走，否则按半分钟走。
// 秒级只在最后 5 分钟开启 —— 整页长期高频 `setData` 在订单多时开销可观。
const COUNTDOWN_INTERVAL_URGENT = 1000;
const COUNTDOWN_INTERVAL_IDLE = 30000;

function uploadReviewImage(file) {
  const extension = file.tempFilePath.split('.').pop().toLowerCase();
  const mimeType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: file.tempFilePath,
      encoding: 'base64',
      success: ({ data }) => resolve(data),
      fail: () => reject(new Error('图片读取失败'))
    });
  }).then((dataBase64) => request('/api/uploads', {
    method: 'POST',
    data: { dataBase64, mimeType }
  }).then(({ data }) => data.url));
}

function uploadPlateMaterial(file) {
  const extension = file.tempFilePath.split('.').pop().toLowerCase();
  const mimeType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: file.tempFilePath,
      encoding: 'base64',
      success: ({ data }) => resolve(data),
      fail: () => reject(new Error('材料图片读取失败'))
    });
  }).then((dataBase64) => request('/api/uploads', {
    method: 'POST',
    data: { dataBase64, mimeType }
  }).then(({ data }) => data.url));
}

function previewAfterSaleImages(event) {
  const urls = event.currentTarget.dataset.urls;
  const current = event.currentTarget.dataset.url;
  if (!Array.isArray(urls) || !urls.length) return;
  wx.previewImage({ current: current || urls[0], urls });
}

function buildSessionFrom(record) {
  return JSON.stringify({ scene:'ORDER_SUPPORT', type:record.type, orderId:record.id, orderNo:record.recordNo, status:record.status, title:record.title }).slice(0, 1024);
}

Page({
  data:{ active:'ALL', records:[], filtered:[], linkage:[], loading:true, consult:null, reviewing:false, serviceContact:'15527111396', responseHours:24, focusId:'', recordsError:'' },
  onShow(){
    const storedFocusId = wx.getStorageSync('campusGoOrderFocusId');
    if (storedFocusId) {
      this.focusId = storedFocusId;
      try { wx.removeStorageSync('campusGoOrderFocusId'); } catch (error) {}
    }
    // tabBar 页面无法携带 query，recordType 同样经 Storage 传入
    const storedRecordType = wx.getStorageSync('campusGoOrderFocusRecordType');
    if (storedRecordType) {
      this.focusRecordType = storedRecordType;
      try { wx.removeStorageSync('campusGoOrderFocusRecordType'); } catch (error) {}
    }
    this.loadRecords();
    this.startCountdownTimer();
  },
  onHide(){ this.stopCountdownTimer(); },
  onUnload(){ this.stopCountdownTimer(); },
  previewAfterSaleImages,
  onLoad(options = {}){
    if (options.focusId) this.focusId = options.focusId;
    if (options.recordType) this.focusRecordType = options.recordType;
    // 配置加载：`loadBusinessConfig` 内部已用缓存/默认值兜底、永不 reject，
    // 失败也不影响可见内容（客服电话/响应时长回落到默认值），故显式忽略。
    loadBusinessConfig().then((config) => this.setData({
      serviceContact: config.servicePhone || config.serviceWechat || '15527111396',
      responseHours: Number(config.leadResponseHours || 24)
    })).catch(loadState.ignoreSilently);
  },
  startCountdownTimer(){
    // 无条件重建：进入页面时先把可能还活着的那条定时器清掉，避免累积。
    this.rebuildCountdownTimer();
  },
  /**
   * 按「是否存在紧急订单」算出应有的刷新间隔。
   *
   * @returns {number} 毫秒间隔：存在紧急待支付单 → 1000，否则 → 30000。
   */
  countdownIntervalFor(){
    const records = this.data.records || [];
    return records.some((item) => item.status === 'PENDING_PAYMENT' && format.isPaymentUrgent(item.paymentExpiresAt))
      ? COUNTDOWN_INTERVAL_URGENT
      : COUNTDOWN_INTERVAL_IDLE;
  },
  /**
   * 重建倒计时定时器。
   *
   * ★ 必须先 `clearInterval` 再 `setInterval`：`setInterval` 不会顶掉旧定时器，
   * 直接叠加会让页面每重建一次就多一条走秒链 —— 而 `onHide` 只清得掉最后一条，
   * 其余会变成后台空转的定时器。
   */
  rebuildCountdownTimer(){
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    const interval = this.countdownIntervalFor();
    this.countdownInterval = interval;
    this.countdownTimer = setInterval(() => this.refreshCountdowns(), interval);
  },
  /**
   * 若定时器正在运行，按其应有的节奏重建它。
   *
   * 为什么不无条件重建：`loadRecords` 是异步的，而 `onHide` 会停表 ——
   * 页面隐藏后到达的加载结果不该把定时器重新拉起来（后台空转）。
   */
  syncCountdownTimer(){
    if (!this.countdownTimer) return;
    this.rebuildCountdownTimer();
  },
  stopCountdownTimer(){
    if (!this.countdownTimer) return;
    clearInterval(this.countdownTimer);
    this.countdownTimer = null;
  },
  refreshCountdowns(){
    const records = this.data.records || [];
    // 原来只服务「待支付订单」，没有待支付单时直接 return —— 租赁的应还倒计时因此
    // 永远不会刷新。改由纯函数统一裁决「是否还有需要走秒的记录」。
    if (!rentalJourney.shouldRefreshCountdown(records)) return;
    if (records.some((item) => item.status === 'PENDING_PAYMENT' && format.isPaymentExpired(item.paymentExpiresAt))) {
      this.loadRecords();
      return;
    }
    const now = new Date();
    const nextRecords = records.map((item) => {
      let next = item;
      if (item.status === 'PENDING_PAYMENT') {
        next = {
          ...next,
          countdownText: format.paymentCountdownText(item.paymentExpiresAt, now),
          countdownUrgent: format.isPaymentUrgent(item.paymentExpiresAt, now)
        };
      }
      if (item.rentalCountdownAt) {
        next = {
          ...next,
          rentalCountdownText: rentalJourney.rentalCountdownText(item.rentalCountdownAt, now),
          rentalOverdue: rentalJourney.isRentalOverdue(item.rentalCountdownAt, now)
        };
      }
      return next;
    });
    this.setData({ records: nextRecords, filtered: this.filterRecords(nextRecords, this.data.active) });
    // 节奏随紧迫度切换：进入 5 分钟以内改走秒级，脱离后回落半分钟。
    // 只在**档位真的变了**时重建，否则每秒都会 clear+set 一次。
    if (this.countdownTimer && this.countdownInterval !== this.countdownIntervalFor()) this.rebuildCountdownTimer();
  },
  loadRecords(){
    Promise.all([
      request('/api/my/orders'),
      request('/api/my/product-reviews')
    ]).then(([orderResponse, reviewResponse])=>{
      const orderData=orderResponse.data || {};
      const reviews=reviewResponse.data || [];
      const reviewedProductIds=reviews.map(review=>`${review.orderId}:${review.productId}`);
      const ebikes=(orderData.ebikeOrders||[]).map(order=>({
        id:order.id, recordNo:order.orderNo || order.id, type:'E_BIKE',
        title:order.items.map(item=>`${item.name}${item.quantity>1?` ×${item.quantity}`:''}`).join(' + '),
        status:order.status, amountInCents:order.totalInCents,
        // 租赁单：`type` 仍是 E_BIKE（交付码 / 履约 / 数量统计依赖它），
        // 额外透传 orderKind 与 rental，供进度条与文案按形态分流。
        orderKind:order.orderKind, rental:order.rental || null,
        paymentOrderId:order.paymentOrderId,
        paymentExpiresAt:order.paymentExpiresAt || '',
        fulfillment:order.fulfillment || {},
        deliveryCode:order.deliveryCode || '',
        items:order.items || [],
        reviewedProductIds:reviewedProductIds.filter(key=>key.startsWith(`${order.id}:`)).map(key=>key.split(':')[1]),
        merchantId:order.merchantId || (order.items||[])[0]?.merchantId || '',
        relatedIds:order.plateApplicationId?{plateApplicationId:order.plateApplicationId}:{},
        merchantName:order.merchantName,
        collaboration:order.collaboration,
        createdAt:order.createdAt, updatedAt:order.updatedAt
      }));
      const records=[...ebikes,...(orderData.serviceRecords||[])].map(orderCard.card).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
      const focusRecordType=this.focusRecordType;
      if (focusRecordType) this.focusRecordType='';
      const active=focusRecordType&&focusRecordType!==this.data.active?focusRecordType:this.data.active;
      this.setData({records,active,filtered:this.filterRecords(records,active),linkage:this.buildLinkage(orderData,records),loading:false,recordsError:''});
      this.focusLoadedRecord(records);
      // 数据到手后按真实紧迫度校准节奏（进入页面时 `records` 可能还是空的）。
      this.syncCountdownTimer();
    }).catch(error=>{
      // ★ 失败不清空：保留上一次的服务记录，把「失败」变成可见状态（错误占位 + 重试）。
      // 改造前这里 setData({records:[],filtered:[],linkage:[]}) —— 订单页会显示
      // 「还没有服务记录」，等于向用户断言「你确实没有订单」，而事实是「我们没取到」。
      // 只改本 catch：Promise.all / records 组装 / buildLinkage / focusLoadedRecord 一律未动。
      this.setData({loading:false, recordsError:loadState.blockErrorText(error)});
    });
  },
  retryRecords(){return this.loadRecords()},
  filterRecords(records,active){return active==='ALL'?records:records.filter(item=>item.type===active)},
  focusLoadedRecord(records){
    const focusId=this.focusId;
    if(!focusId||!(records||[]).some(record=>record.id===focusId)) return;
    this.setData({focusId});
    wx.nextTick(()=>{
      wx.pageScrollTo({selector:`#user-record-${focusId}`,offsetTop:80,duration:300});
    });
  },
  buildLinkage(data,records){
    const links=[];
    const overdueAfterSale=records.find(item=>item.afterSaleOverdue);
    if(overdueAfterSale) links.push({icon:'催',title:'售后已超时，平台正在催办',copy:'点击查看工单详情，如需进一步处理可申请平台协助。',view:'orders',filter:'E_BIKE',focusId:overdueAfterSale.id});
    const phonePlans=records.filter(item=>item.type==='PHONE_PLAN');
    const broadband=records.find(item=>item.type==='BROADBAND');
    if(phonePlans.some(item=>item.status==='ACTIVATED')&&!broadband) links.push({icon:'网',title:'双人宽带资格待申请',copy:'已激活电话卡后，可提交两人宽带核验。',view:'card'});
    const paidRecharge=records.find(item=>item.type==='RECHARGE'&&['PENDING_CREDIT','CREDITED'].includes(item.status));
    if(paidRecharge&&phonePlans.some(item=>item.status==='PENDING_REALNAME')) links.push({icon:'卡',title:'话费已支付，可推进激活',copy:'点击激活关联的校园电话卡。',view:'orders',filter:'RECHARGE',focusId:paidRecharge.id});
    const plate=records.find(item=>item.type==='PLATE'&&item.status==='MATERIAL_PENDING');
    if(plate) links.push({icon:'牌',title:'校园牌照待补材料',copy:'平台购车订单已自动关联免费上牌服务。',view:'orders',filter:'PLATE',focusId:plate.id});
    return links.slice(0,3);
  },
  setFilter(e){
    const active=e.currentTarget.dataset.type||'ALL';
    this.setData({active,filtered:this.filterRecords(this.data.records,active)});
  },
  goCard(){wx.navigateTo({url:'/pages/card/card'})},
  goShop(){wx.navigateTo({url:'/pages/scooters/scooters'})},
  buyAgain(e){
    const productId=e.currentTarget.dataset.productId;
    if(!productId)return;
    wx.navigateTo({url:`/pages/checkout/checkout?id=${encodeURIComponent(productId)}`});
  },
  goStore(e){
    const merchantId=e.currentTarget.dataset.merchantId;
    if(!merchantId)return wx.showToast({title:'这笔订单暂无店铺主页',icon:'none'});
    wx.navigateTo({url:`/pages/store/store?id=${encodeURIComponent(merchantId)}`});
  },
  copyDeliveryCode(e){
    const code=e.currentTarget.dataset.code;
    if(!code)return;
    wx.setClipboardData({data:code,success:()=>wx.showToast({title:'已复制',icon:'success'})});
  },
  goLinkage(e){
    const view=e.currentTarget.dataset.view;
    const filter=e.currentTarget.dataset.filter;
    const focusId=e.currentTarget.dataset.focusId;
    if(view==='card')return wx.navigateTo({url:'/pages/card/card'});
    if(filter){
      this.focusId=focusId;
      this.setData({active:filter,filtered:this.filterRecords(this.data.records,filter),focusId});
      wx.nextTick(()=>this.focusLoadedRecord(this.data.records));
      return;
    }
  },
  editOrder(e){wx.navigateTo({url:`/pages/edit-order/edit-order?id=${e.currentTarget.dataset.id}`})},
  afterSales(e){wx.navigateTo({url:`/pages/aftersales/aftersales?id=${e.currentTarget.dataset.id}`})},
  openReview(e){
    if(this.data.reviewing)return;
    const record=this.data.records.find(item=>item.id===e.currentTarget.dataset.id);
    const productId=e.currentTarget.dataset.productId;
    if(!record||!productId)return;
    wx.showActionSheet({
      alertText:'为这次服务评分',
      itemList:['★ 非常不满意','★★ 不满意','★★★ 一般','★★★★ 满意','★★★★★ 非常满意'],
      success:({tapIndex})=>{
        const rating=5-tapIndex;
        wx.showModal({
          title:'发布已购评价',
          editable:true,
          placeholderText:'请分享真实使用体验，例如车况、配送和服务响应',
          success:res=>{
            if(!res.confirm)return;
            const content=(res.content||'').trim();
            if(!content)return wx.showToast({title:'请填写评价内容',icon:'none'});
            this.setData({reviewing:true});
            wx.chooseMedia({
              count: 3,
              mediaType: ['image'],
              sourceType: ['album', 'camera'],
              success: ({ tempFiles }) => Promise.all(tempFiles.map(file => uploadReviewImage(file)))
                .then(images => request('/api/product-reviews', { method:'POST', data:{ orderId:record.id, productId, rating, content, images } }))
                .then(() => {
                  this.setData({reviewing:false});
                  wx.showToast({title:'评价已发布',icon:'success'});
                  setTimeout(()=>this.loadRecords(),400);
                })
                .catch(error => {
                  this.setData({reviewing:false});
                  wx.showToast({title:error.message||'评价发布失败',icon:'none'});
                }),
              fail: () => {
                request('/api/product-reviews',{method:'POST',data:{orderId:record.id,productId,rating,content}}).then(()=>{
                  this.setData({reviewing:false});
                  wx.showToast({title:'评价已发布',icon:'success'});
                  setTimeout(()=>this.loadRecords(),400);
                }).catch(error=>{
                  this.setData({reviewing:false});
                  wx.showToast({title:error.message||'评价发布失败',icon:'none'});
                });
              }
            });
          }
        });
      }
    });
  },
  runPayment(e){
    const id=e.currentTarget.dataset.id;
    if(!id||this.data.submitting) return;
    const order=(this.data.records||[]).find(record=>record.id===id);
    if (order && format.isPaymentExpired(order.paymentExpiresAt)) {
      wx.showToast({ title: '支付已超时，正在刷新订单', icon: 'none' });
      this.loadRecords();
      return;
    }
    this.setData({submitting:true});
    this.runOrderPayment(order?.paymentOrderId)
      .then(()=>{wx.showToast({title:'支付成功',icon:'success'});this.loadRecords();})
      .catch(error=>wx.showToast({title:error.message||'支付失败',icon:'none'}))
      .finally(()=>this.setData({submitting:false}));
  },
  runOrderPayment(paymentOrderId){
    if(!paymentOrderId) return Promise.reject(new Error('支付单不存在'));
    return payPaymentOrderById(paymentOrderId);
  },
  cancelOrder(e){
    const id=e.currentTarget.dataset.id;
    if(!id) return;
    wx.showModal({title:'取消订单',content:'确定取消这笔待支付订单吗？',success:({confirm})=>{
      if(!confirm) return;
      const order=(this.data.records||[]).find(record=>record.id===id);
      const url=order?.paymentOrderId?`/api/payment-orders/${encodeURIComponent(order.paymentOrderId)}/cancel`:`/api/orders/${encodeURIComponent(id)}/cancel`;
      request(url,{method:'POST'})
        .then(()=>{wx.showToast({title:'已取消',icon:'success'});this.loadRecords();})
        .catch(error=>wx.showToast({title:error.message||'取消失败',icon:'none'}));
    }});
  },
  uploadMaterials(e){
    const id=e.currentTarget.dataset.id;
    if(!id)return;
    const record=this.data.records.find(item=>item.id===id);
    if(record && record.status!=='MATERIAL_PENDING' && record.status!=='REVIEWING')return wx.showToast({title:'当前状态暂不能上传',icon:'none'});
    wx.chooseMedia({
      count:9,
      mediaType:['image'],
      sourceType:['album','camera'],
      success:({tempFiles})=>{
        if(!tempFiles?.length)return;
        wx.showLoading({title:'上传中'});
        Promise.all(tempFiles.map(file=>uploadPlateMaterial(file)))
          .then(images=>request(`/api/plate-applications/${encodeURIComponent(id)}/materials`,{method:'POST',data:{images}}))
          .then(()=>{
            wx.hideLoading();
            wx.showToast({title:'材料已提交',icon:'success'});
            setTimeout(()=>this.loadRecords(),500);
          })
          .catch(error=>{
            wx.hideLoading();
            wx.showToast({title:error.message||'上传失败',icon:'none'});
          });
      }
    });
  },
  /**
   * 申请归还（租赁）。
   *
   * 复用订单协同接口：用户侧动作的鉴权与通知链路这里都已具备，无需新开端点。
   * 服务端在 `/api/order-collab` 内对 `RETURN_REQUEST` 做了状态机守卫
   * （仅 RENTING → RETURN_REQUESTED），非法状态返回 409，前端原样提示即可。
   */
  requestReturn(e){
    const id=e.currentTarget.dataset.id;
    if(!id) return;
    const record=(this.data.records||[]).find(item=>item.id===id);
    if(!rentalJourney.canRequestReturn(record)) return wx.showToast({title:'当前状态不能申请归还',icon:'none'});
    wx.showModal({
      title:'申请归还',
      content:'确认归还这台车吗？商家核验通过后，押金将原路退回。',
      success:({confirm})=>{
        if(!confirm) return;
        request('/api/order-collab',{method:'POST',data:{role:'USER',orderId:id,action:'RETURN_REQUEST',note:'用户申请归还'}})
          .then(()=>{
            wx.showToast({title:'已提交归还申请',icon:'success'});
            setTimeout(()=>this.loadRecords(),400);
          })
          .catch(error=>wx.showToast({title:error.message||'申请失败',icon:'none'}));
      }
    });
  },
  sendCollab(e){
    const {id,action,text}=e.currentTarget.dataset;
    wx.showModal({
      title: action === 'APPEAL' ? '提交平台协助' : '发送给商家',
      editable:true, placeholderText: action === 'APPEAL' ? '请说明需要平台协助的问题' : '请填写备注，例如明天上午配送',
      success:res=>{
        if(!res.confirm)return;
        request('/api/order-collab',{method:'POST',data:{role:'USER',orderId:id,action,note:res.content||text||'用户留言'}}).then(()=>{
          wx.showToast({title:'已发送'});
          setTimeout(()=>this.loadRecords(),400);
        }).catch(error=>wx.showToast({title:error.message||'发送失败',icon:'none'}));
      }
    });
  },
  runAction(e){
    const {id,action}=e.currentTarget.dataset;
    if(!action)return;
    if(action==='APPLY_BROADBAND'){
      wx.showModal({
        title:'申请双人宽带',
        editable:true,
        placeholderText:'请填写同伴的校园电话卡手机号',
        success:res=>{
          const companionPhone=(res.content||'').trim();
          if(!res.confirm)return;
          request(`/api/service-records/${encodeURIComponent(id)}/actions`,{method:'POST',data:{userId:userId(),action,companionPhone}}).then(()=>{
            wx.showToast({title:'宽带资格已提交'});
            setTimeout(()=>this.loadRecords(),400);
          }).catch(error=>wx.showToast({title:error.message||'操作失败',icon:'none'}));
        }
      });
      return;
    }
    request(`/api/service-records/${encodeURIComponent(id)}/actions`,{method:'POST',data:{userId:userId(),action}}).then(()=>{
      wx.showToast({title:'已更新'});
      setTimeout(()=>this.loadRecords(),400);
    }).catch(error=>wx.showToast({title:error.message||'操作失败',icon:'none'}));
  },
  goRechargeDetail(e){
    const id=e.currentTarget.dataset.rechargeId;
    if(!id)return;
    wx.navigateTo({ url:'/pages/recharge/detail?orderId='+encodeURIComponent(id) });
  },
  runConsult(e){
    const record=this.data.records.find(item=>item.id===e.currentTarget.dataset.id);
    if(!record)return;
    const business=e.currentTarget.dataset.business || '订单咨询';
    const interest=e.currentTarget.dataset.interest || record.title;
    this.setData({consult:{
      id:record.id, type:record.type, business, interest, title:record.title, recordNo:record.recordNo,
      status:record.status, statusLabel:record.statusLabel || record.status,
      questions:consultQuestions[record.type] || ['请帮我查询订单进度'],
      phone:this.data.serviceContact || '15527111396',
      sessionFrom:buildSessionFrom(record),
      summary:[`订单：${record.title}`,`编号：${record.recordNo}`,`状态：${record.statusLabel || record.status}`].join('\n'),
      sending:''
    }});
  },
  closeConsult(){ this.setData({consult:null}); },
  keepConsultOpen(){},
  sendConsultQuestion(e){ this.createConsultNote(e.currentTarget.dataset.question); },
  describeConsult(){
    wx.showModal({
      title:'补充说明', editable:true, placeholderText:'请描述具体问题，例如办理时间、手机号或异常信息',
      success:res=>{ if(res.confirm && res.content) this.createConsultNote(res.content.trim()); }
    });
  },
  createConsultNote(text){
    const consult=this.data.consult;
    if(!consult || consult.sending)return;
    this.setData({'consult.sending':text});
    request('/api/order-collab',{method:'POST',data:{role:'USER',orderId:consult.id,action:'NOTE',note:text}}).then(({data})=>{
      const updated=orderCard.card(data);
      const records=this.data.records.map(item=>item.id===updated.id?updated:item);
      this.setData({records,filtered:this.filterRecords(records,this.data.active),consult:null});
      wx.showToast({title:'已提交咨询'});
    }).catch(error=>{
      this.setData({'consult.sending':''});
      wx.showToast({title:error.message||'发送失败',icon:'none'});
    });
  },
  callConsultPhone(){
    wx.makePhoneCall({phoneNumber:this.data.consult?.phone || this.data.serviceContact || '15527111396'});
  },
  goConsultForm(){
    const consult=this.data.consult;
    wx.navigateTo({url:`/pages/consult/consult?type=${encodeURIComponent(consult.business)}&interest=${encodeURIComponent(consult.interest)}&sourceType=${encodeURIComponent(consult.type)}&sourceId=${encodeURIComponent(consult.id)}&sourceNo=${encodeURIComponent(consult.recordNo)}`});
  },
  onContact(){ wx.showToast({title:'已进入客服会话'}); }
});
