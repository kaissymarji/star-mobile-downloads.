/* V200 Tech Community - online module, intentionally isolated from vehicle commands.
 * No secure server values, activation PINs or OEM diagnostic secrets belong here.
 * Requires configured Supabase Auth/RLS/Storage and Cloudflare Worker.
 */
(() => {
  'use strict';
  const cfg = window.V200_COMMUNITY_CONFIG || {};
  const $ = id => document.getElementById(id);
  const safe = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const isUuid = value => /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(String(value || ''));
  // The technician community depends on Supabase, not on the optional payment Worker.
  const configured = /^https:\/\/[a-z0-9.-]+\.supabase\.co\/?$/i.test(cfg.supabaseUrl || '') && /^(sb_publishable_|eyJ)/.test(cfg.supabasePublishableKey || '') && !!window.supabase?.createClient;
  const workerConfigured = /^https:\/\//.test(cfg.activationWorkerUrl || '');
  const allowedTypes = new Map([['png','image/png'],['jpg','image/jpeg'],['jpeg','image/jpeg'],['webp','image/webp'],['pdf','application/pdf'],['txt','text/plain'],['log','text/plain'],['csv','text/csv'],['json','application/json']]);
  const categories = ['General','BMW / MINI','Mercedes-Benz','VW / Audi','Ford / Lincoln','Toyota / Lexus','Nissan / Infiniti','EEPROM / ECU','OBD / Diagnostics'];
  const client = configured ? window.supabase.createClient(cfg.supabaseUrl.replace(/\/$/,''),cfg.supabasePublishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}}) : null;
  let me=null,profile=null,allPosts=[],allProfiles=new Map(),blocked=new Set(),currentPost=null,chatChannel=null,selectedTab='discussions',onlineUsers=0;
  let lastMessageAt=0, heartbeatTimer=null;
  function notice(msg,error=false){const node=$('message');node.hidden=false;node.textContent=msg;node.className=error?'error':'';node.scrollIntoView({block:'nearest'});}
  function fail(err,context){console.error(context,err);notice((context?context+': ':'')+(err?.message||String(err)),true);}
  function button(id,fn){const n=$(id);if(n)n.addEventListener('click',fn);}
  function submit(id,fn){$(id).addEventListener('submit',async e=>{e.preventDefault();try{await fn();}catch(err){fail(err,'Request failed');}});}
  const show = (id,value=true) => {$(id).hidden=!value;};
  function humanDate(t){const d=new Date(t);return Number.isNaN(d.getTime())?'—':d.toLocaleString();}
  function pickName(id){return allProfiles.get(id)?.handle||('Tech '+String(id||'').slice(0,8));}
  function escapeLike(q){return q.replace(/[\\%_]/g,s=>'\\'+s);}
  function sameUser(u){return !!me&&me.id===u;}
  function showTab(name){
    if(!['discussions','chat','account','admin'].includes(name))name='discussions';
    if(name==='admin'&&profile?.role!=='admin'&&profile?.role!=='moderator')name='account';
    selectedTab=name;
    document.querySelectorAll('.screen').forEach(n=>n.hidden=n.id!==name);
    document.querySelectorAll('[data-tab]').forEach(n=>n.classList.toggle('selected',n.dataset.tab===name));
    history.replaceState(null,'','#'+(name==='discussions'?'community':name));
    if(name==='discussions')loadPosts().catch(e=>fail(e,'Discussions'));
    if(name==='chat')loadChat().catch(e=>fail(e,'Chat'));
    if(name==='account' && me){
      if(workerConfigured)refreshEntitlement().catch(e=>fail(e,'Activation status'));
      else $('activationStatus').textContent='Paid activation is not configured yet. Technician login and chat remain available.';
    }
    if(name==='admin')loadAdmin().catch(e=>fail(e,'Admin'));
  }
  async function callWorker(route,options={}){
    if(!client)throw Error('Supabase is not connected. Check the public project URL and publishable key.');
    if(!workerConfigured)throw Error('Paid activation is not yet connected. Technician login and chat work without Cloudflare.');
    const {data:{session}}=await client.auth.getSession();
    if(!session?.access_token)throw Error('Sign in to your technician account first.');
    const url=cfg.activationWorkerUrl.replace(/\/$/,'')+route;
    const headers={'Authorization':'Bearer '+session.access_token,'Accept':'application/json'};
    if(options.body!==undefined)headers['Content-Type']='application/json';
    const response=await fetch(url,{method:options.method||'GET',headers,body:options.body===undefined?undefined:JSON.stringify(options.body),cache:'no-store'});
    const result=await response.json().catch(()=>({error:'Unexpected backend response'}));
    if(!response.ok)throw Error(result.error||('HTTP '+response.status));
    return result;
  }
  function deviceId(){
    const key='v200_tech_device_id_v1';let id=localStorage.getItem(key);
    if(!id){id=(window.crypto?.randomUUID?.()||('legacy-'+Date.now()+'-'+Math.random().toString(16).slice(2)));localStorage.setItem(key,id);}
    return id;
  }
  async function refreshProfiles(){
    if(!me)return;
    const {data,error}=await client.from('profiles').select('id,handle,display_name,bio,role,banned_until').limit(500);
    if(error)throw error;
    allProfiles=new Map((data||[]).map(p=>[p.id,p]));
    profile=allProfiles.get(me.id)||null;
    $('adminTab').hidden=!['admin','moderator'].includes(profile?.role);
    $('profileHandle').value=profile?.handle||'';
    $('profileName').value=profile?.display_name||'';
    $('profileBio').value=profile?.bio||'';
    await refreshBlocks();
  }
  async function refreshBlocks(){
    if(!me)return;
    const {data,error}=await client.from('blocks').select('blocked_id').eq('blocker_id',me.id);
    if(error)throw error;
    blocked=new Set((data||[]).map(x=>x.blocked_id));
  }
  async function applyAuth(session){
    me=session?.user||null;
    show('authArea',!me);show('signedIn',!!me);
    $('newTopic').disabled=!me;
    $('chatBody').disabled=!me;$('chatForm').querySelector('button').disabled=!me;
    if(me){
      $('accountEmail').textContent=me.email||'';
      $('welcome').textContent='Welcome back, technician';
      try{await refreshProfiles();await loadNotifications();await heartbeat();}
      catch(e){fail(e,'Account initialization');}
      if(heartbeatTimer)clearInterval(heartbeatTimer);
      heartbeatTimer=setInterval(()=>{if(!document.hidden)heartbeat().catch(()=>{});},60000);
      joinRealtime();
    }else{
      profile=null;allProfiles.clear();blocked.clear();
      if(chatChannel){client.removeChannel(chatChannel);chatChannel=null;}
      if(heartbeatTimer){clearInterval(heartbeatTimer);heartbeatTimer=null;}
      $('presence').classList.remove('live');$('presence').lastElementChild.textContent='Offline';
      $('communityOnline').textContent='—';$('adminTab').hidden=true;
      $('activationStatus').textContent=workerConfigured?'Sign in to check your payment.':'Paid activation is not configured yet; chat and accounts remain available.';
    }
    if(selectedTab==='admin'&&!me)showTab('account');
    else if(selectedTab==='discussions')await loadPosts();
    else if(selectedTab==='chat')await loadChat();
  }
  async function heartbeat(){if(!me||!workerConfigured)return;try{await callWorker('/api/activity',{method:'POST',body:{source:'community'}});}catch(e){console.warn('Activity metrics unavailable',e);}}
  async function joinRealtime(){
    if(!me)return;
    if(chatChannel){await client.removeChannel(chatChannel);chatChannel=null;}
    chatChannel=client.channel('tech-lobby-v1',{config:{private:true,presence:{key:me.id}}});
    chatChannel.on('presence',{event:'sync'},()=>{
      const present=chatChannel.presenceState();
      const users=new Set();
      Object.values(present).forEach(entries=>(entries||[]).forEach(p=>{if(p.user_id)users.add(p.user_id);}));
      onlineUsers=users.size;
      $('communityOnline').textContent=String(onlineUsers);
    });
    chatChannel.on('postgres_changes',{event:'INSERT',schema:'public',table:'chat_messages'},()=>{
      if(selectedTab==='chat')loadChat().catch(()=>{});
    });
    chatChannel.on('postgres_changes',{event:'INSERT',schema:'public',table:'comments'},()=>{
      if(currentPost&&!$('postDetail').hidden)loadReplies().catch(()=>{});
      loadNotifications().catch(()=>{});
    });
    chatChannel.subscribe(async status=>{
      const label=$('presence');
      if(status==='SUBSCRIBED'){
        label.classList.add('live');label.lastElementChild.textContent='Connected';
        try{await chatChannel.track({user_id:me.id,joined_at:new Date().toISOString()});}catch(e){console.warn('Presence registration failed',e);}
      }else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'||status==='CLOSED'){
        label.classList.remove('live');label.lastElementChild.textContent='Offline';$('communityOnline').textContent='—';
      }
    });
  }
  async function loadCategories(){
    if(!client)return;
    const {data,error}=await client.from('forum_categories').select('slug,name').order('sort_order');
    if(error)throw error;
    const list=(data||[]).length?data:categories.map((name,i)=>({slug:'category-'+i,name}));
    for(const id of ['categoryFilter','postCategory']){
      const select=$(id);select.textContent='';
      if(id==='categoryFilter'){let all=document.createElement('option');all.value='';all.textContent='All categories';select.append(all);}
      list.forEach(item=>{let n=document.createElement('option');n.value=item.slug;n.textContent=item.name;select.append(n);});
    }
  }
  async function loadPosts(){
    if(!client){$('postList').textContent='Community setup required.';return;}
    if(!me){$('postList').textContent='Sign in to view and participate in technician discussions.';return;}
    const {data,error}=await client.from('posts').select('id,author_id,category_slug,title,vehicle_context,body,created_at,updated_at').order('created_at',{ascending:false}).limit(100);
    if(error)throw error;
    allPosts=(data||[]).filter(p=>!blocked.has(p.author_id));renderPosts();
  }
  function renderPosts(){
    const term=$('searchPosts').value.trim().toLowerCase();const category=$('categoryFilter').value;
    const list=allPosts.filter(p=>(!category||p.category_slug===category)&&(!term||(p.title+' '+p.body+' '+p.vehicle_context).toLowerCase().includes(term)));
    const area=$('postList');area.innerHTML='';
    if(!list.length){area.textContent='No discussions match your search.';return;}
    for(const p of list){
      const card=document.createElement('article');card.className='post-card';card.tabIndex=0;
      card.innerHTML='<div class="post-meta"><span>'+safe(p.category_slug)+'</span><span>'+safe(pickName(p.author_id))+'</span><span>'+safe(humanDate(p.created_at))+'</span></div><h3>'+safe(p.title)+'</h3><p>'+safe((p.body||'').slice(0,230))+'</p>';
      card.addEventListener('click',()=>openPost(p));card.addEventListener('keydown',e=>{if(e.key==='Enter')openPost(p);});area.append(card);
    }
  }
  function contentAction(label,handler){const button=document.createElement('button');button.textContent=label;button.className='notice-btn';button.type='button';button.addEventListener('click',handler);return button;}
  async function reportTarget(type,id){
    if(!me)return notice('Sign in first.',true);
    const {error}=await client.from('reports').insert({reporter_id:me.id,target_type:type,target_id:id,reason:'User requested a moderator review.'});
    if(error)throw error;notice('Report submitted to moderators.');
  }
  async function blockUser(id){
    if(!me||sameUser(id))return;
    const {error}=await client.from('blocks').insert({blocker_id:me.id,blocked_id:id});
    if(error&&error.code!=='23505')throw error;
    blocked.add(id);currentPost=null;show('postDetail',false);show('postList',true);renderPosts();notice('Technician blocked from your view.');
  }
  async function openPost(p){
    currentPost=p;show('postForm',false);show('postList',false);show('postDetail',true);
    const box=$('postDetailBody');box.textContent='';
    const title=document.createElement('h2');title.textContent=p.title;box.append(title);
    const context=document.createElement('p');context.className='sub';context.textContent=p.vehicle_context||'';box.append(context);
    const author=document.createElement('p');author.className='fine';author.textContent=pickName(p.author_id)+' · '+humanDate(p.created_at);box.append(author);
    const body=document.createElement('p');body.style.whiteSpace='pre-wrap';body.style.overflowWrap='anywhere';body.textContent=p.body;box.append(body);
    const actions=document.createElement('div');actions.className='actions';
    actions.append(contentAction('Report',()=>reportTarget('post',p.id).catch(e=>fail(e,'Report'))));
    if(!sameUser(p.author_id))actions.append(contentAction('Block author',()=>blockUser(p.author_id).catch(e=>fail(e,'Block'))));
    if(['moderator','admin'].includes(profile?.role))actions.append(contentAction('Hide post',()=>moderate('post',p.id).catch(e=>fail(e,'Moderation'))));
    box.append(actions);
    await Promise.all([loadReplies(),loadAttachments()]);
  }
  async function loadReplies(){
    if(!me||!currentPost)return;
    const {data,error}=await client.from('comments').select('id,author_id,body,created_at').eq('post_id',currentPost.id).order('created_at',{ascending:true}).limit(200);
    if(error)throw error;
    const list=$('replyList');list.textContent='';
    for(const reply of (data||[]).filter(r=>!blocked.has(r.author_id))){
      const row=document.createElement('div');row.className='reply';
      const label=document.createElement('div');label.className='post-meta';label.textContent=pickName(reply.author_id)+' · '+humanDate(reply.created_at);row.append(label);
      const text=document.createElement('p');text.textContent=reply.body;row.append(text);
      const actions=document.createElement('div');actions.className='actions';
      actions.append(contentAction('Report',()=>reportTarget('comment',reply.id).catch(e=>fail(e,'Report'))));
      if(['admin','moderator'].includes(profile?.role))actions.append(contentAction('Hide',()=>moderate('comment',reply.id).catch(e=>fail(e,'Moderation'))));
      row.append(actions);list.append(row);
    }
    if(!list.children.length)list.textContent='No replies yet.';
  }
  async function loadChat(){
    if(!client){$('chatList').textContent='Community setup required.';return;}
    if(!me){$('chatList').textContent='Sign in to join the live technician chat.';return;}
    const {data,error}=await client.from('chat_messages').select('id,author_id,body,created_at').order('created_at',{ascending:false}).limit(80);
    if(error)throw error;
    const area=$('chatList');area.textContent='';
    for(const m of (data||[]).reverse().filter(x=>!blocked.has(x.author_id))){
      const box=document.createElement('div');box.className='chat-entry';
      const who=document.createElement('div');who.className='post-meta';who.textContent=pickName(m.author_id)+' · '+humanDate(m.created_at);box.append(who);
      const p=document.createElement('p');p.textContent=m.body;box.append(p);
      if(['admin','moderator'].includes(profile?.role))box.append(contentAction('Hide',()=>moderate('chat',m.id).catch(e=>fail(e,'Moderation'))));
      box.append(contentAction('Report',()=>reportTarget('chat',m.id).catch(e=>fail(e,'Report'))));
      area.append(box);
    }
    area.scrollTop=area.scrollHeight;
  }
  async function loadAttachments(){
    if(!currentPost)return;
    const {data,error}=await client.from('attachments').select('id,author_id,storage_path,filename,content_type,size_bytes,created_at').eq('post_id',currentPost.id).order('created_at',{ascending:false});
    if(error)throw error;
    const area=$('attachmentList');area.textContent='';
    for(const file of (data||[]).filter(f=>!blocked.has(f.author_id))){
      const row=document.createElement('div');row.className='attachment-row';
      const label=document.createElement('span');label.textContent=file.filename+' ('+Math.round(file.size_bytes/1024)+' KB)';row.append(label);
      row.append(contentAction('Open secure file',async()=>{
        try{const {data:signed,error:err}=await client.storage.from('tech-attachments').createSignedUrl(file.storage_path,60);if(err)throw err;window.location.href=signed.signedUrl;}
        catch(e){fail(e,'File access');}
      }));area.append(row);
    }
    if(!area.children.length)area.textContent='No shared attachments.';
  }
  async function upload(){
    if(!me||!currentPost)throw Error('Sign in and select a discussion first.');
    const file=$('attachment').files?.[0];if(!file)throw Error('Choose a file first.');
    const ext=(file.name.split('.').pop()||'').toLowerCase(),mime=allowedTypes.get(ext);
    if(!mime)throw Error('Unsupported file format. Executables, APKs, ZIPs, raw EEPROM dumps and firmware are not accepted.');
    if(file.size<1)throw Error('Cannot upload empty files.');
    if(file.size>5*1024*1024)throw Error('5 MB maximum per file.');
    if(['txt','log','csv','json'].includes(ext)){
      const text=await file.text();
      if(/\b[A-HJ-NPR-Z0-9]{17}\b/i.test(text)||/customer|address|phone\s*number/i.test(text)){
        throw Error('This file may contain a VIN or customer details. Redact them before uploading.');
      }
    }
    const path=me.id+'/'+crypto.randomUUID()+'.'+ext;
    const {error}=await client.storage.from('tech-attachments').upload(path,file,{contentType:mime,upsert:false,cacheControl:'3600'});
    if(error)throw error;
    const record=await client.from('attachments').insert({author_id:me.id,post_id:currentPost.id,storage_path:path,filename:file.name.slice(0,120),content_type:mime,size_bytes:file.size});
    if(record.error){await client.storage.from('tech-attachments').remove([path]);throw record.error;}
    $('attachment').value='';notice('Attachment uploaded securely.');await loadAttachments();
  }
  async function loadNotifications(){
    if(!me)return;
    const {data,error}=await client.from('notifications').select('id,kind,post_id,created_at,read_at').order('created_at',{ascending:false}).limit(30);
    if(error)throw error;
    const list=$('notifications');list.textContent='';
    const unread=(data||[]).filter(n=>!n.read_at).length;$('notifBadge').textContent=unread?'('+unread+' unread)':'';
    for(const note of data||[]){
      const row=document.createElement('div');row.className='attachment-row';const label=document.createElement('span');label.textContent=(note.kind==='reply'?'New reply to your discussion':'Community notification')+' · '+humanDate(note.created_at);row.append(label);
      if(!note.read_at)row.append(contentAction('Mark read',async()=>{const {error:err}=await client.from('notifications').update({read_at:new Date().toISOString()}).eq('id',note.id);if(err)fail(err,'Notification');else await loadNotifications();}));
      list.append(row);
    }
    if(!list.children.length)list.textContent='No notifications.';
  }
  async function refreshEntitlement(){
    if(!me)return;
    const result=await callWorker('/api/activation?device_id='+encodeURIComponent(deviceId()));
    $('activationStatus').textContent=result.active?'Payment verified. Your account is activated.':'No verified activation payment linked to this account yet.';
    show('payButton',!result.active);show('showLicense',!!result.active);show('licenseOutput',false);
  }
  async function showActivationCode(){
    const result=await callWorker('/api/activation?device_id='+encodeURIComponent(deviceId())+'&reveal=1');
    if(!result.active||!result.code)throw Error('No verified payment. Activation is unavailable.');
    $('licenseOutput').textContent=result.code;
    $('licenseOutput').hidden=false;
  }
  async function checkout(){
    const result=await callWorker('/api/checkout/start',{method:'POST',body:{}});
    if(!/^https:\/\/buy\.stripe\.com\//.test(result.checkoutUrl||''))throw Error('Unexpected checkout address; canceled.');
    // WebView launches the external browser; the website navigates to Stripe.
    window.location.href=result.checkoutUrl;
  }
  async function loadAdmin(){
    if(!me||!['admin','moderator'].includes(profile?.role))return;
    const metrics=await callWorker('/api/admin/metrics');
    $('adminStats').innerHTML=[['Signed-in today',metrics.activeToday],['Signed-in 30 days',metrics.active30Days],['Recent online',metrics.recentOnline],['Paid activations',metrics.paidActivations],['Open reports',metrics.openReports],['GitHub downloads',metrics.githubDownloads]].map(([n,v])=>'<div class="metric"><b>'+safe(v===null?'—':v)+'</b><small>'+safe(n)+'</small></div>').join('');
    const result=await callWorker('/api/admin/reports');
    const area=$('adminReports');area.textContent='';
    for(const x of result.reports||[]){
      const box=document.createElement('div');box.className='report';
      const info=document.createElement('div');info.innerHTML='<strong>'+safe(x.target_type)+' report</strong><p>'+safe(x.reason)+' · '+safe(humanDate(x.created_at))+'</p><p>Item: '+safe(x.target_id)+'</p>';box.append(info);
      const action=contentAction('Dismiss report',async()=>{try{await callWorker('/api/admin/report/resolve',{method:'POST',body:{id:x.id}});await loadAdmin();}catch(e){fail(e,'Resolve report');}});box.append(action);area.append(box);
    }
    if(!area.children.length)area.textContent='No open reports.';
  }
  async function moderate(type,id){
    await callWorker('/api/admin/moderate',{method:'POST',body:{type,id,hidden:true}});
    notice('Content hidden for community members.');
    if(selectedTab==='chat')await loadChat();else{show('postDetail',false);show('postList',true);await loadPosts();}
  }
  async function downloads(){
    try{
      const r=await fetch('https://api.github.com/repos/kaissymarji/star-mobile-downloads./releases?per_page=100');if(!r.ok)return;
      const rows=await r.json();const assets=rows.flatMap(x=>(x.assets||[]).filter(y=>/\.apk$/i.test(y.name)));
      $('communityDownloads').textContent=assets.reduce((n,x)=>n+(x.download_count||0),0).toLocaleString('en-US');
    }catch(e){console.warn('Download stats unavailable',e);}
  }
  function bindControls(){
    document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>showTab(b.dataset.tab)));
    button('openAccount',()=>showTab('account'));button('refreshPosts',()=>loadPosts().catch(e=>fail(e,'Refresh posts')));
    $('searchPosts').addEventListener('input',renderPosts);$('categoryFilter').addEventListener('change',renderPosts);
    button('newTopic',()=>{if(!me){showTab('account');notice('Sign in to post.');return;}show('postList',false);show('postDetail',false);show('postForm',true);});
    button('cancelPost',()=>{show('postForm',false);show('postList',true);});
    button('closePost',()=>{currentPost=null;show('postDetail',false);show('postList',true);});
    button('uploadAttachment',()=>upload().catch(e=>fail(e,'File upload')));
    button('refreshChat',()=>loadChat().catch(e=>fail(e,'Chat refresh')));
    button('signOut',async()=>{try{await client.auth.signOut();notice('Signed out.');showTab('account');}catch(e){fail(e,'Sign out');}});
    button('forgotPassword',async()=>{try{const email=$('signInEmail').value.trim();if(!email.includes('@'))throw Error('Enter your email address in the sign-in form.');await window.V200AuthActions.reset(client.auth,email,cfg.emailRedirectUrl);notice('If your account exists, a password-reset message was sent.');}catch(e){fail(e,'Password reset');}});
    button('payButton',()=>checkout().catch(e=>fail(e,'Checkout')));
    button('refreshLicense',()=>refreshEntitlement().catch(e=>fail(e,'Activation')));
    button('showLicense',()=>showActivationCode().catch(e=>fail(e,'Activation')));
    button('adminRefresh',()=>loadAdmin().catch(e=>fail(e,'Admin')));
    submit('signInForm',async()=>{await window.V200AuthActions.signIn(client.auth,$('signInEmail').value,$('signInPassword').value);notice('Signed in successfully.');});
    submit('signUpForm',async()=>{const data=await window.V200AuthActions.register(client.auth,$('signUpEmail').value,$('signUpPassword').value,cfg.emailRedirectUrl);notice(data.session?'Account created.':'Check your email to confirm your account before signing in.');});
    submit('recoveryForm',async()=>{await window.V200AuthActions.updatePassword(client.auth,$('recoveryPassword').value);show('recoveryForm',false);notice('Password updated.');});
    submit('profileForm',async()=>{if(!me)throw Error('Not signed in');const {error}=await client.from('profiles').update({handle:$('profileHandle').value.trim(),display_name:$('profileName').value.trim(),bio:$('profileBio').value.trim()}).eq('id',me.id);if(error)throw error;await refreshProfiles();notice('Profile saved.');});
    submit('postForm',async()=>{if(!me)throw Error('Sign in first.');const {error}=await client.from('posts').insert({author_id:me.id,category_slug:$('postCategory').value,title:$('postTitle').value.trim(),body:$('postBody').value.trim(),vehicle_context:$('postVehicle').value.trim()});if(error)throw error;$('postForm').reset();show('postForm',false);show('postList',true);await loadPosts();notice('Your discussion is live.');});
    submit('replyForm',async()=>{if(!me||!currentPost)throw Error('Choose a discussion.');const {error}=await client.from('comments').insert({post_id:currentPost.id,author_id:me.id,body:$('replyBody').value.trim()});if(error)throw error;$('replyBody').value='';await loadReplies();notice('Reply posted.');});
    submit('chatForm',async()=>{if(!me)throw Error('Sign in first.');const body=$('chatBody').value.trim();if(!body)throw Error('Message is empty.');if(Date.now()-lastMessageAt<2000)throw Error('Please allow two seconds between messages.');const {error}=await client.from('chat_messages').insert({author_id:me.id,body});if(error)throw error;lastMessageAt=Date.now();$('chatBody').value='';await loadChat();});
    submit('claimForm',async()=>{const id=$('claimSession').value.trim();if(!/^cs_(test|live)_[a-zA-Z0-9]{8,240}$/.test(id))throw Error('Enter a full Stripe Checkout Session ID.');await callWorker('/api/claim-previous',{method:'POST',body:{sessionId:id}});$('claimSession').value='';await refreshEntitlement();notice('Earlier payment verified and linked to your account.');});
  }
  async function init(){
    bindControls();downloads();
    const hash=location.hash.replace('#','');selectedTab=hash==='account'?'account':hash==='chat'?'chat':hash==='admin'?'admin':'discussions';
    if(!configured){show('unconfigured',true);show('authArea',false);$('postList').textContent='Online services are not configured. The scanner continues working offline.';showTab('discussions');return;}
    $('unconfigured').hidden=true;
    if(!workerConfigured){
      show('payButton',false);show('refreshLicense',false);show('showLicense',false);
      const claim=$('claimForm');if(claim)claim.hidden=true;
      $('activationStatus').textContent='Paid activation is not configured yet. Technician login and chat remain available.';
    }
    try{await loadCategories();}catch(e){fail(e,'Categories');}
    client.auth.onAuthStateChange((event,session)=>{
      if(event==='PASSWORD_RECOVERY'){show('recoveryForm',true);showTab('account');}
      // Do not await Supabase API calls inside onAuthStateChange; avoids auth-lock deadlocks.
      setTimeout(()=>applyAuth(session).catch(e=>fail(e,'Authentication')),0);
    });
    const {data:{session}}=await client.auth.getSession();await applyAuth(session);
    showTab(selectedTab);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden&&me){loadNotifications().catch(()=>{});heartbeat().catch(()=>{});}});
  }
  init().catch(err=>fail(err,'Community startup'));
})();
