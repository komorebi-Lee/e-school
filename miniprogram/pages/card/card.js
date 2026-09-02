Page({
  data:{plans:[{id:'plan-campus',name:'校园畅享卡',monthlyFee:29,data:'80GB校园流量',voice:'100分钟通话',badge:'学生常选'},{id:'plan-plus',name:'校园畅联卡',monthlyFee:39,data:'120GB校园流量',voice:'200分钟通话',badge:'流量推荐'},{id:'plan-basic',name:'校园轻享卡',monthlyFee:19,data:'40GB校园流量',voice:'50分钟通话',badge:'基础套餐'}],rechargePromos:[{id:'r150',pay:150,receive:200,badge:'多得50元'},{id:'r200',pay:200,receive:300,badge:'多得100元'}],selectedPlan:0,activeSection:0,profileName:'',profilePhone:'',companionPhone:''},
  onLoad(){
    const profile=wx.getStorageSync('shishanUserProfile')||{};
    this.setData({profileName:profile.name||'',profilePhone:profile.phone||'',companionPhone:profile.companionPhone||''});
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
    request('/api/phone-card-orders',{method:'POST',data:{userId:userId(),customerName:saved.name,phone:saved.phone,planName:p.name,amountInCents:p.monthlyFee*100}})
      .then(({data})=>{wx.showToast({title:'电话卡订单已提交'});setTimeout(()=>wx.navigateTo({url:`/pages/consult/consult?type=${encodeURIComponent('电话卡实名激活')}&interest=${encodeURIComponent(`${p.name}（${data.id}）`)}`}),650)})
      .catch((error)=>{if(error.message&&error.message.indexOf('userId')>-1){wx.navigateTo({url:`/pages/consult/consult?type=校园电话卡&interest=${encodeURIComponent(p.name)}`});return}wx.showModal({title:'请补充办理人',content:'需要姓名和手机号创建订单，是否前往填写？',confirmText:'去填写',cancelText:'取消',success:r=>{if(r.confirm)wx.navigateTo({url:`/pages/consult/consult?type=校园电话卡&interest=${encodeURIComponent(p.name)}`})}})});
  },
  buyRecharge(e){
    const p=this.data.rechargePromos[Number(e.currentTarget.dataset.index)];
    const { request, userId } = require('../../services/api');
    if(!this.profileValid())return wx.showModal({title:'补充办理信息',content:'请先填写办理人姓名和手机号',showCancel:false});
    const saved=this.currentProfile();
    request('/api/recharge-orders',{method:'POST',data:{userId:userId(),phone:saved.phone,paidInCents:p.pay*100,receiveInCents:p.receive*100}})
      .then(()=>{wx.showToast({title:'话费权益已提交'});setTimeout(()=>wx.navigateTo({url:`/pages/consult/consult?type=${encodeURIComponent('话费到账确认')}&interest=${encodeURIComponent(`充${p.pay}送${p.receive}`)}`}),650)})
      .catch(()=>wx.navigateTo({url:`/pages/consult/consult?type=${encodeURIComponent('话费权益')}&interest=${encodeURIComponent(`充${p.pay}送${p.receive}`)}`}));
  },
  setCompanionPhone(e){this.setData({companionPhone:e.detail.value})},
  applyBroadband(){
    const { request, userId } = require('../../services/api');
    if(!this.profileValid())return wx.showModal({title:'补充办理信息',content:'请先填写办理人姓名和手机号',showCancel:false});
    if(!/^1\d{10}$/.test(this.data.companionPhone.trim()))return wx.showToast({title:'请填写同伴手机号',icon:'none'});
    const saved=this.currentProfile();
    request('/api/broadband-applications',{method:'POST',data:{userId:userId(),ownerPhone:saved.phone,companionPhone:this.data.companionPhone}})
      .then(()=>{wx.showToast({title:'宽带资格已提交'});setTimeout(()=>wx.navigateTo({url:'/pages/orders/orders'}),650)})
      .catch(()=>wx.navigateTo({url:`/pages/consult/consult?type=${encodeURIComponent('宽带资格')}&interest=${encodeURIComponent('双人购卡宽带')}`}));
  },
  currentProfile(){
    const profile=wx.getStorageSync('shishanUserProfile')||{};
    return {name:profile.name||'',phone:profile.phone||''};
  }
});
