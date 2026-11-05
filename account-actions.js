/* Pure, testable Supabase Auth operations. No password is saved by this script. */
(function(global){
  'use strict';
  function email(value){const v=String(value||'').trim();if(v.length>254||!/^\S+@\S+\.\S+$/.test(v))throw Error('Enter a valid email address.');return v;}
  function password(value){if(typeof value!=='string'||value.length<8||value.length>128)throw Error('Password must contain between 8 and 128 characters.');return value;}
  function redirect(value){const url=new URL(value);if(url.protocol!=='https:'||url.hostname!=='kaissymarji.github.io'||!url.pathname.endsWith('/community.html'))throw Error('Unapproved password recovery redirect');return url.href;}
  async function success(task){const {data,error}=await task();if(error)throw error;return data;}
  const actions={
    register(auth,address,pass,url){return success(()=>auth.signUp({email:email(address),password:password(pass),options:{emailRedirectTo:redirect(url)}}));},
    signIn(auth,address,pass){return success(()=>auth.signInWithPassword({email:email(address),password:password(pass)}));},
    reset(auth,address,url){return success(()=>auth.resetPasswordForEmail(email(address),{redirectTo:redirect(url)}));},
    updatePassword(auth,pass){return success(()=>auth.updateUser({password:password(pass)}));}
  };
  global.V200AuthActions=Object.freeze(actions);
})(typeof window!=='undefined'?window:globalThis);
