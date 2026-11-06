/** Guest-first Auto Scan trial endpoints.
 * Database calls use the existing server-only service role and HMAC secret.
 * A mobile Android ID is best-effort device recognition, NOT hardware attestation.
 */
export async function guestTrialRoute(request,env,ctx){
 const {authenticate,adminRest,reply,parseJson,fetcher,findPaid,required,httpError,
  deviceHash,validDeviceId,safeTrialDecision,origin}=ctx;
 const path=new URL(request.url).pathname;
 if(request.method!=='POST')throw httpError(405,'Method not allowed');
 if(path!=='/api/trial/guest/authorize'&&path!=='/api/trial/guest/start')throw httpError(404,'Unknown trial endpoint');
 const data=await parseJson(request,1024);
 if(!validDeviceId(data.deviceId))throw httpError(400,'Invalid device ID');
 required(env,['ACTIVATION_HMAC_KEY','SUPABASE_SECRET_KEY']);
 const hash=await deviceHash(env.ACTIVATION_HMAC_KEY,data.deviceId);
 if(path.endsWith('/authorize')){
  if(typeof data.autoScan!=='boolean')throw httpError(400,'autoScan must be boolean');
  // Paid status ALWAYS comes from the existing verified-purchases table, not
  // from a client claim, copied PIN or public Stripe success redirect.
  if(request.headers.get('Authorization')){
   const user=await authenticate(request,env,fetcher);
   if(await findPaid(env,user.id,fetcher))return reply({permitted:true,mode:'paid',state:'paid'},200,origin);
  }
  const raw=await adminRest(env,'POST','rpc/v200_guest_trial_preflight',
    {p_hash:hash,p_auto_scan:data.autoScan},{},fetcher);
  const decision=safeTrialDecision(raw);
  return reply({permitted:decision.permitted===true,mode:decision.permitted?'trial':'none',state:decision.state},200,origin);
 }
 const raw=await adminRest(env,'POST','rpc/v200_guest_trial_start',
   {p_hash:hash},{},fetcher);
 const decision=safeTrialDecision(raw);
 return reply({started:decision.started===true,state:decision.state},200,origin);
}
