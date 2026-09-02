const { request, userId } = require('../../services/api');

const typeNames = { E_BIKE:'电瓶车', PHONE_PLAN:'电话卡', RECHARGE:'话费权益', BROADBAND:'宽带', PLATE:'校园牌照' };
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
    if (!['CANCELLED'].includes(item.status)) actions.push({ key:'aftersale', text:'申请售后' });
  }
  if (type === 'PHONE_PLAN') {
    if (item.status === 'PENDING_REALNAME') actions.push({ key:'consult', text:'实名咨询', business:'电话卡实名激活' });
    if (item.relatedIds.broadbandApplicationId) actions.push({ key:'filter', text:'查看宽带', filter:'BROADBAND' });
    else actions.push({ key:'action', text:'申请宽带', action:'APPLY_BROADBAND', disabled:item.status !== 'ACTIVATED', reason:'完成实名激活后可申请' });
  }
  if (type === 'RECHARGE') {
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
    actions
  };
}

Page({
  data:{ active:'ALL', records:[], filtered:[], linkage:[], loading:true },
  onShow(){ this.loadRecords(); },
  loadRecords(){
    request(`/api/my/orders?userId=${encodeURIComponent(userId())}`).then(({data})=>{
      const ebikes=(data.ebikeOrders||[]).map(order=>({
        id:order.id, recordNo:order.orderNo || order.id, type:'E_BIKE',
        title:order.items.map(item=>`${item.name}${item.quantity>1?` ×${item.quantity}`:''}`).join(' + '),
        status:order.status, amountInCents:order.totalInCents,
        relatedIds:order.plateApplicationId?{plateApplicationId:order.plateApplicationId}:{},
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
  runAction(e){
    const {id,action}=e.currentTarget.dataset;
    if(!action)return;
    request(`/api/service-records/${encodeURIComponent(id)}/actions`,{method:'POST',data:{userId:userId(),action}}).then(()=>{
      wx.showToast({title:'已更新'});
      setTimeout(()=>this.loadRecords(),400);
    }).catch(error=>wx.showToast({title:error.message||'操作失败',icon:'none'}));
  },
  runConsult(e){
    const {business,interest}=e.currentTarget.dataset;
    wx.navigateTo({url:`/pages/consult/consult?type=${encodeURIComponent(business)}&interest=${encodeURIComponent(interest||'')}`});
  }
});
