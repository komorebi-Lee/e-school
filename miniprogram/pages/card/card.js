Page({
  data:{plans:[],rechargePromos:[],selectedPlan:0,activeSection:0,profileName:'',profilePhone:'',companionPhone:''},
  onLoad(){
    const profile=wx.getStorageSync('shishanUserProfile')||{};
    this.setData({profileName:profile.name||'',profilePhone:profile.phone||'',companionPhone:profile.companionPhone||''});
    this.loadCatalog();
  },
  loadCatalog(){
    const { request } = require('../../services/api');
    request('/api/products?category=PHONE_PLAN').then(({data})=>{
      const plans=(data||[]).filter(item=>item.active!==false).map(item=>({
        id:item.id,
        name:item.name,
        monthlyFee:Math.round((item.priceInCents||0)/100),
        data:item.description||'套餐详情以运营商确认为准',
        voice:'详情见套餐说明',
        badge:item.stock>0?'可办理':'已售罄'
      }));
      if(plans.length)this.setData({plans,selectedPlan:0});
    }).catch(()=>{});
    request('/api/recharge-promos').then(({data})=>{
      const rechargePromos=(data||[]).map(item=>({id:item.id,pay:item.pay,receive:item.receive,badge:item.badge||'限时优惠'}));
      if(rechargePromos.length)this.setData({rechargePromos});
    }).catch(()=>{});
  },
  choosePlan(e){this.setData({selectedPlan:Number(e.currentTarget.dataset.index)})},
  onReady(){this.measureSections()},
  measureSections(){const query=wx.createSelectorQuery();query.selectAll('.business-section').boundingClientRect();query.selectViewport().scrollOffset();query.exec(res=>{const scrollTop=(res[1]&&res[1].scrollTop)||0;this.sectionTops=(res[0]||[]).map(item=>item.top+scrollTop)})},
  onPageScroll(e){const tops=this.sectionTops||[];if(tops.length!==3)return;const marker=e.scrollTop+150;let active=0;if(marker>=tops[2])active=2;else if(marker>=tops[1])active=1;if(active!==this.data.activeSection)this.setData({activeSection:active})},
  jumpSection(e){const index=Number(e.currentTarget.dataset.index);this.setData({activeSection:index});const query=wx.createSelectorQuery();query.selectAll('.business-section').boundingClientRect();query.selectViewport().scrollOffset();query.exec(res=>{const sections=res[0]||[];const scrollTop=(res[1]&&res[1].scrollTop)||0;this.sectionTops=sections.map(item=>item.top+scrollTop);const target=sections[index];if(target)wx.pageScrollTo({scrollTop:Math.max(0,target.top+scrollTop-92),duration:280})})},
  setProfileName(e){this.setData({profileName:e.detail.value});this.saveProfile()},
  setProfilePhone(e){this.setData({profilePhone:e.detail.value});this.saveProfile()},
  setCompanionPhone(e){this.setData({companionPhone:e.detail.value});this.saveProfile()},
  saveProfile(){wx.setStorageSync('shishanUserProfile',{name:this.data.profileName.trim(),phone:this.data.profilePhone.trim(),companionPhone:this.data.companionPhone.trim()})},
  profileValid(){return this.data.profileName.trim()&&/^1\d{10}$/.test(this.data.profilePhone.trim())},
  submit(){
    const p=this.data.plans[this.data.selectedPlan];
    const { request, userId } = require('../../services/api');
    if(!this.profileValid())return wx.showModal({title:'补充办理信息',content:'请先填写办理人姓名和手机号',showCancel:false});
    const saved=this.currentProfile();
    request('/api/phone-card-orders',{method:'POST',header:{'Idempotency-Key':'tel-'+Date.now()+'-'+Math.random().toString(36).slice(2,8)},data:{customerName:saved.name,phone:saved.phone,planName:p.name,amountInCents:p.monthlyFee*100}})
      .then(({data})=>{wx.showToast({title:'电话卡订单已提交'});setTimeout(()=>wx.navigateTo({url:`/pages/consult/consult?type=${encodeURIComponent('电话卡实名激活')}&interest=${encodeURIComponent(`${p.name}（${data.id}）`)}`}),650)})
      .catch((error)=>{wx.showModal({title:'提交失败',content:error.message||'请稍后重试',showCancel:false})});
  },
  buyRecharge(e){
    const p=this.data.rechargePromos[Number(e.currentTarget.dataset.index)];
    const { request, userId } = require('../../services/api');
    if(!p)return wx.showToast({title:'暂无可办理套餐',icon:'none'});
    if(!this.profileValid())return wx.showModal({title:'补充办理信息',content:'请先填写办理人姓名和手机号',showCancel:false});
    if(this.creatingRecharge)return;
    this.creatingRecharge=true;
    const saved=this.currentProfile();
    request('/api/recharge-orders',{method:'POST',header:{'Idempotency-Key':'rech-'+Date.now()+'-'+Math.random().toString(36).slice(2,8)},data:{phone:saved.phone,paidInCents:p.pay*100,receiveInCents:p.receive*100}})
      .then(({data})=>{this.creatingRecharge=false;wx.navigateTo({url:'/pages/recharge/detail?promo='+encodeURIComponent(JSON.stringify({...p,phone:saved.phone}))+'&orderId='+encodeURIComponent(data.id)})})
      .catch((error)=>{this.creatingRecharge=false;wx.showModal({title:'提交失败',content:error.message||'请稍后重试',showCancel:false})});
  },
  setCompanionPhone(e){this.setData({companionPhone:e.detail.value})},
  applyBroadband(){
    const { request, userId } = require('../../services/api');
    if(!this.profileValid())return wx.showModal({title:'补充办理信息',content:'请先填写办理人姓名和手机号',showCancel:false});
    if(!/^1\d{10}$/.test(this.data.companionPhone.trim()))return wx.showToast({title:'请填写同伴手机号',icon:'none'});
    const saved=this.currentProfile();
    request('/api/broadband-applications',{method:'POST',data:{ownerPhone:saved.phone,companionPhone:this.data.companionPhone}})
      .then(()=>{wx.showToast({title:'宽带资格已提交'});setTimeout(()=>wx.navigateTo({url:'/pages/orders/orders'}),650)})
      .catch((error)=>{wx.showModal({title:'提交失败',content:error.message||'请稍后重试',showCancel:false})});
  },
  currentProfile(){
    const profile=wx.getStorageSync('shishanUserProfile')||{};
    return {name:profile.name||'',phone:profile.phone||''};
  }
});
