const { request } = require('../../services/api');
const { FALLBACK_SERVICE_CONTACT, loadBusinessConfig } = require('../../services/business');
const { payPaymentOrder } = require('../../services/payment');
const loadState = require('../../utils/load-state');

Page({
  // ★ `serviceContact` 的初值是**空串**，不是硬编码号码：本页 `onLoad` 后立即可渲染，
  //   而配置是异步回来的。若写死号码，管理员改号后用户会先看到**已过期**的号。
  //   `plate.wxml` 的咨询按钮对本字段做了 `wx:if`，未取到配置时不展示号码。
  data:{source:'platform',vehicleModel:'',name:'',studentNo:'',phone:'',eligibleOrders:[],selectedOrderIndex:0,serviceFee:49,statusBlock:loadState.initialBlock(),charging:{eligible:false,stateLabel:'',detail:''},submitting:false,serviceContact:''},
  onShow(){this.loadOrders();this.loadStatus();this.loadCharging()},
  onLoad(){
    // 配置加载：`loadBusinessConfig` 内部已用缓存/默认值兜底、永不 reject，
    // 失败也不影响可见内容（服务费回落到默认值，联系电话保持空值、不展示），故显式忽略。
    loadBusinessConfig().then((config) => this.setData({
      serviceFee: Number(config.externalPlateFee ?? 49),
      serviceContact: config.servicePhone || config.serviceWechat || ''
    })).catch(loadState.ignoreSilently);
  },
  loadOrders(){
    request('/api/my/orders').then(({data})=>{
      const ebikeOrders=(data?.ebikeOrders||[])
        .filter(order=>!['CANCELLED','PENDING_PAYMENT'].includes(order.status)&&order.items&&order.items.length);
      this.setData({
        eligibleOrders:ebikeOrders.map(order=>({
          ...order,
          productName:(order.items||[]).map(item=>`${item.name}${Number(item.quantity)>1?` ×${item.quantity}`:''}`).join(' + ')
        }))
      });
    }).catch(()=>this.setData({eligibleOrders:[]}));
  },
  loadStatus(){
    // ★ 加载类：改造前失败时静默，`status` 停在 null，页面会把「没取到」
    // 渲染成「你还没申请」—— 用户可能因此重复提交。改为三态（失败不清空 + 可见错误 + 重试）。
    return loadState.loadBlock({
      setData:(patch)=>this.setData(patch),
      stateKey:'statusBlock',
      prev:this.data.statusBlock,
      loader:()=>request('/api/service-records').then(({data})=>{
        const plate=(data?.serviceRecords||[]).find(item=>item.type==='PLATE');
        return plate?{id:plate.id,state:plate.statusLabel,vehicleModel:plate.title,name:'',fee:plate.amountInCents/100}:null;
      })
    });
  },
  retryStatus(){return this.loadStatus()},
  loadCharging(){
    request('/api/my/charging-eligibility').then(({data})=>{
      this.setData({charging:{eligible:data.eligible===true,stateLabel:data.stateLabel||'',detail:data.detail||''}});
    }).catch(()=>{
      // 失败时给出可见提示，避免页面停留在空白状态误导用户。
      this.setData({charging:{eligible:false,stateLabel:'暂不可查',detail:'充电资格暂时无法获取，请稍后重试'}});
    });
  },
  chooseSource(e){this.setData({source:e.currentTarget.dataset.source})},
  chooseOrder(e){this.setData({selectedOrderIndex:Number(e.detail.value)})},
  setVehicleModel(e){this.setData({vehicleModel:e.detail.value})},
  setName(e){this.setData({name:e.detail.value})},
  setStudentNo(e){this.setData({studentNo:e.detail.value})},
  setPhone(e){this.setData({phone:e.detail.value})},
  submit(){
    const {source,name,studentNo,phone,vehicleModel,eligibleOrders,selectedOrderIndex}=this.data;
    if(!name.trim()||!studentNo.trim()||!/^1\d{10}$/.test(phone.trim()))return wx.showToast({title:'请填写姓名、学号和手机号',icon:'none'});
    const order=eligibleOrders[selectedOrderIndex];
    if(source==='platform'&&!order)return wx.showToast({title:'请先完成购车订单',icon:'none'});
    if(source==='external'&&!vehicleModel.trim())return wx.showToast({title:'请填写车辆型号',icon:'none'});
    if(this.data.submitting)return;
    this.setData({submitting:true});
    request('/api/plate-applications',{method:'POST',data:{customerName:name.trim(),customerPhone:phone.trim(),studentNo:studentNo.trim(),vehicleModel:source==='platform'?order.productName:vehicleModel.trim(),orderId:source==='platform'?order.id:''}})
      .then((result)=>{
        if(source!=='external'||!result.paymentOrder||!result.paymentOrder.id){
          wx.showModal({title:'申请已提交',content:'平台购车免费牌照辅助已创建，请按客服指引补齐材料。',showCancel:false,success:()=>{this.setData({submitting:false,vehicleModel:''});this.loadStatus()}});
          return;
        }
        return payPaymentOrder(result.paymentOrder).then(()=>{
          wx.showModal({title:'支付成功',content:`自带车服务费 ¥${this.data.serviceFee} 已支付，请按客服指引补充材料。`,showCancel:false,success:()=>{this.setData({submitting:false,vehicleModel:''});this.loadStatus()}});
        });
      })
      .catch(error=>{this.setData({submitting:false});wx.showToast({title:error.message||'提交失败',icon:'none'})});
  },
  // 用户已明确要打电话：用兜底常量（其既定角色），而不是拨一个空号。
  callService(){wx.makePhoneCall({phoneNumber:this.data.serviceContact || FALLBACK_SERVICE_CONTACT})}
});
