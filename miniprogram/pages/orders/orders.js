const { request, userId } = require('../../services/api');

const typeNames = { E_BIKE:'电瓶车', PHONE_PLAN:'电话卡', RECHARGE:'话费权益', BROADBAND:'宽带', PLATE:'校园牌照' };
const consultQuestions = {
  PHONE_PLAN: ['实名审核需要多久？','实名信息填错了怎么修改？','订单进度请帮忙查询'],
  RECHARGE: ['话费预计什么时候到账？','到账金额和订单不一致','请帮我核对到账进度'],
  BROADBAND: ['资格核验预计多久通过？','什么时候可以安排安装？','请帮我查询核验进度'],
  PLATE: ['还需要补充哪些材料？','办理进度请帮忙查询','办理完成后如何领牌？']
};
const consultPhones = { PHONE_PLAN:'15527111396', RECHARGE:'15527111396', BROADBAND:'15527111396', PLATE:'15527111396' };
const statusTones = {
  PAID:'blue', FULFILLING:'run', COMPLETED:'done', CANCELLED:'closed', AFTER_SALE:'warn',
  PENDING_REALNAME:'todo', ACTIVATED:'done', REJECTED:'closed',
  PENDING_CREDIT:'todo', CREDITED:'done',
  PENDING_VERIFY:'todo', APPROVED:'done',
  MATERIAL_PENDING:'todo', REVIEWING:'run'
};

function card(item) {
  const isEbike = item.type === 'E_BIKE';
  const type = item.type;
  const actions = [];
  if (type === 'E_BIKE') {
    if (!['COMPLETED','CANCELLED','AFTER_SALE'].includes(item.status)) actions.push({ key:'edit', text:'修改配送' });
    if (item.status !== 'CANCELLED') actions.push({ key:'collab', text:'联系商家', action:'NOTE' });
    if (!['COMPLETED','CANCELLED','AFTER_SALE'].includes(item.status)) actions.push({ key:'appeal', text:'平台协助', action:'APPEAL' });
    if (!['CANCELLED'].includes(item.status)) actions.push({ key:'aftersale', text:'申请售后' });
  }
  if (type === 'PHONE_PLAN') {
    if (item.status === 'PENDING_REALNAME') actions.push({ key:'consult', text:'实名咨询', business:'电话卡实名激活' });
    if (item.relatedIds.broadbandApplicationId) actions.push({ key:'filter', text:'查看宽带', filter:'BROADBAND' });
    else actions.push({ key:'action', text:'申请宽带', action:'APPLY_BROADBAND', disabled:item.status !== 'ACTIVATED', reason:'完成实名激活后可申请' });
  }
  if (type === 'RECHARGE') {
    actions.push({ key:'detail', text:'\u6743\u76ca\u8be6\u60c5', rechargeId:item.id });
    if (item.status === 'PENDING_CREDIT') actions.push({ key:'consult', text:'到账咨询', business:'话费到账确认' });
    if (item.relatedIds.phoneCardOrderId) actions.push({ key:'action', text:'激活电话卡', action:'ACTIVATE_CARD', disabled:item.status !== 'CREDITED', reason:'到账后可激活' });
  }
  if (type === 'BROADBAND') actions.push({ key:'consult', text:item.status === 'APPROVED' ? '预约安装' : '核验咨询', business:item.status === 'APPROVED' ? '宽带安装预约' : '宽带资格核验' });
  if (type === 'PLATE') actions.push({ key:'consult', text:item.status === 'MATERIAL_PENDING' ? '补充材料' : '办理咨询', business:'校园牌照辅助' });

  return {
    ...item,
    typeLabel: typeNames[type] || '服务',
    icon: type === 'E_BIKE' ? '车' : type === 'PHONE_PLAN' ? '卡' : type === 'RECHARGE' ? '充' : type === 'BROADBAND' ? '网' : '牌',
    tone: statusTones[item.status] || 'todo',
    timeText: (item.updatedAt || item.createdAt || '').slice(5,16).replace('T',' '),
    priceText: item.amountInCents ? `¥${(item.amountInCents / 100).toFixed(2)}` : '',
    statusLabel:item.statusLabel || '处理中',
    actions,
    merchantName:item.merchantName || '',
    nextStep:item.collaboration?.roleActions?.MERCHANT?.length ? '商家确认履约' : item.collaboration?.roleActions?.PLATFORM?.length ? '平台介入处理' : item.status === 'COMPLETED' ? '等待用户确认服务' : '等待履约更新',
    intervention:item.collaboration?.intervention?.status === 'REQUESTED',
    messages:(item.collaboration?.messages || []).slice(0,2)
  };
}

function buildSessionFrom(record) {
  return JSON.stringify({ scene:'ORDER_SUPPORT', type:record.type, orderId:record.id, orderNo:record.recordNo, status:record.status, title:record.title }).slice(0, 1024);
}

Page({
  data:{ active:'ALL', records:[], filtered:[], linkage:[], loading:true, consult:null },
  onShow(){ this.loadRecords(); },
  loadRecords(){
    request(`/api/my/orders?userId=${encodeURIComponent(userId())}`).then(({data})=>{
      const ebikes=(data.ebikeOrders||[]).map(order=>({
        id:order.id, recordNo:order.orderNo || order.id, type:'E_BIKE',
        title:order.items.map(item=>`${item.name}${item.quantity>1?` ×${item.quantity}`:''}`).join(' + '),
        status:order.status, amountInCents:order.totalInCents,
        relatedIds:order.plateApplicationId?{plateApplicationId:order.plateApplicationId}:{},
        merchantName:order.merchantName,
        collaboration:order.collaboration,
        createdAt:order.createdAt, updatedAt:order.updatedAt
      }));
      const records=[...ebikes,...(data.serviceRecords||[])].map(card).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
      this.setData({records,filtered:this.filterRecords(records,this.data.active),linkage:this.buildLinkage(data,records),loading:false});
    }).catch(error=>{
      this.setData({records:[],filtered:[],linkage:[],loading:false});
      wx.showToast({title:error.message||'订单加载失败',icon:'none'});
    });
  },
  filterRecords(records,active){return active==='ALL'?records:records.filter(item=>item.type===active)},
  buildLinkage(data,records){
    const links=[];
    const phonePlans=records.filter(item=>item.type==='PHONE_PLAN');
    const broadband=records.find(item=>item.type==='BROADBAND');
    if(phonePlans.some(item=>item.status==='ACTIVATED')&&!broadband) links.push({icon:'网',title:'双人宽带资格待申请',copy:'已激活电话卡后，可提交两人宽带核验。',view:'card'});
    if(records.some(item=>item.type==='RECHARGE'&&item.status==='CREDITED')&&phonePlans.some(item=>item.status==='PENDING_REALNAME')) links.push({icon:'卡',title:'话费已到账，可推进激活',copy:'客服确认后，把关联电话卡改为已激活。',view:'orders',filter:'RECHARGE'});
    const plate=records.find(item=>item.type==='PLATE'&&item.status==='MATERIAL_PENDING');
    if(plate) links.push({icon:'牌',title:'校园牌照待补材料',copy:'平台购车订单已自动关联免费上牌服务。',view:'orders',filter:'PLATE'});
    return links.slice(0,2);
  },
  setFilter(e){
    const active=e.currentTarget.dataset.type||'ALL';
    this.setData({active,filtered:this.filterRecords(this.data.records,active)});
  },
  goCard(){wx.navigateTo({url:'/pages/card/card'})},
  goShop(){wx.navigateTo({url:'/pages/scooters/scooters'})},
  goLinkage(e){
    const view=e.currentTarget.dataset.view;
    const filter=e.currentTarget.dataset.filter;
    if(view==='card')return wx.navigateTo({url:'/pages/card/card'});
    if(filter){this.setData({active:filter,filtered:this.filterRecords(this.data.records,filter)});return}
  },
  editOrder(e){wx.navigateTo({url:`/pages/edit-order/edit-order?id=${e.currentTarget.dataset.id}`})},
  afterSales(e){wx.navigateTo({url:`/pages/aftersales/aftersales?id=${e.currentTarget.dataset.id}`})},
  sendCollab(e){
    const {id,action,text}=e.currentTarget.dataset;
    wx.showModal({
      title: action === 'APPEAL' ? '提交平台协助' : '发送给商家',
      editable:true, placeholderText: action === 'APPEAL' ? '请说明需要平台协助的问题' : '请填写备注，例如明天上午配送',
      success:res=>{
        if(!res.confirm)return;
        request('/api/order-collab',{method:'POST',data:{role:'USER',userId:userId(),orderId:id,action,note:res.content||text||'用户留言'}}).then(()=>{
          wx.showToast({title:'已发送'});
          setTimeout(()=>this.loadRecords(),400);
        }).catch(error=>wx.showToast({title:error.message||'发送失败',icon:'none'}));
      }
    });
  },
  runAction(e){
    const {id,action}=e.currentTarget.dataset;
    if(!action)return;
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
      phone:consultPhones[record.type] || '15527111396',
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
    request('/api/order-collab',{method:'POST',data:{role:'USER',userId:userId(),orderId:consult.id,action:'NOTE',note:text}}).then(({data})=>{
      const updated=card(data);
      const records=this.data.records.map(item=>item.id===updated.id?updated:item);
      this.setData({records,filtered:this.filterRecords(records,this.data.active),consult:null});
      wx.showToast({title:'已提交咨询'});
    }).catch(error=>{
      this.setData({'consult.sending':''});
      wx.showToast({title:error.message||'发送失败',icon:'none'});
    });
  },
  callConsultPhone(){
    wx.makePhoneCall({phoneNumber:this.data.consult?.phone || '15527111396'});
  },
  goConsultForm(){
    const consult=this.data.consult;
    wx.navigateTo({url:`/pages/consult/consult?type=${encodeURIComponent(consult.business)}&interest=${encodeURIComponent(consult.interest)}`});
  },
  onContact(){ wx.showToast({title:'已进入客服会话'}); }
});
