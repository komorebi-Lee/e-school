const { request, userId } = require('../../services/api');

Page({
  data:{source:'platform',vehicleModel:'',name:'',studentNo:'',phone:'',eligibleOrders:[],selectedOrderIndex:0,serviceFee:49,status:null,submitting:false},
  onShow(){this.loadOrders();this.loadStatus()},
  loadOrders(){
    request(`/api/orders?userId=${encodeURIComponent(userId())}`).then(({data})=>{
      const orders=(data||[]).filter(order=>order.status!=='CANCELLED'&&order.items&&order.items.length);
      this.setData({eligibleOrders:orders.map(order=>({...order,productName:order.items[0].name}))});
    }).catch(()=>this.setData({eligibleOrders:[]}));
  },
  loadStatus(){
    request(`/api/service-records?userId=${encodeURIComponent(userId())}`).then(({data})=>{
      const plate=(data||[]).find(item=>item.type==='PLATE');
      this.setData({status:plate?{id:plate.id,state:plate.statusLabel,vehicleModel:plate.title,name:'',fee:plate.amountInCents/100}:null});
    }).catch(()=>{});
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
    request('/api/plate-applications',{method:'POST',data:{userId:userId(),customerName:name.trim(),customerPhone:phone.trim(),vehicleModel:source==='platform'?order.productName:vehicleModel.trim(),orderId:source==='platform'?order.id:''}})
      .then(()=>{wx.showModal({title:'申请已提交',content:source==='platform'?'平台购车免费牌照辅助已创建，请按客服指引补齐材料。':'自带车服务已记录，客服将确认材料和服务费。',showCancel:false,success:()=>{this.setData({submitting:false,vehicleModel:''});this.loadStatus()}})})
      .catch(error=>{this.setData({submitting:false});wx.showToast({title:error.message||'提交失败',icon:'none'})});
  },
  callService(){wx.makePhoneCall({phoneNumber:'15527111396'})}
});
