import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePdt, verifiedPayment, pdt } from "../src/worker.mjs";
const tx="12ABC345DE6789FGH";
const env={PAYPAL_MERCHANT_ID:"EXPECTED_MERCHANT",PAYPAL_ITEM_NAME:"J2534 July 2024",PAYPAL_ITEM_NUMBER:"J2534-JULY-2024"};
const payment={txn_id:tx,payment_status:"Completed",mc_currency:"USD",mc_gross:"100.00",receiver_id:env.PAYPAL_MERCHANT_ID,item_name:env.PAYPAL_ITEM_NAME,item_number:env.PAYPAL_ITEM_NUMBER,quantity:"1",payer_email:"buyer@example.com"};
test("only completed correct product and payee",()=>assert.equal(verifiedPayment(payment,tx,env),true));
for (const [k,v] of Object.entries({payment_status:"Pending",mc_currency:"EUR",mc_gross:"25.00",receiver_id:"OTHER",item_name:"FRM3 & JLR BCM Repair",item_number:"OTHER",quantity:"2",payer_email:"",txn_id:"OTHER"})){
  test("reject "+k,()=>assert.equal(verifiedPayment({...payment,[k]:v},tx,env),false));
}
test("decode PDT and reject unsuccessful or ambiguous responses",()=>{
  assert.deepEqual(parsePdt("SUCCESS\nitem_name=J2534+July+2024\na=x%40example.com\n"),{item_name:"J2534 July 2024",a:"x@example.com"});
  assert.equal(parsePdt("FAIL\n"),null);
  assert.equal(parsePdt("SUCCESS\na=1\na=2"),null);
});

test("malformed PDT percent escapes are rejected without throwing",()=>{
  for(const body of ["SUCCESS\na=%", "SUCCESS\n%ZZ=value", "SUCCESS\na=%E0%A4", null]) {
    assert.equal(parsePdt(body),null);
  }
});

for(const key of ["PAYPAL_MERCHANT_ID","PAYPAL_ITEM_NAME"]) {
  for(const value of [undefined,"","   "]) {
    test("missing or empty "+key+" cannot match missing payment identity: "+String(value),()=>{
      const data={...payment};
      const field=key==="PAYPAL_MERCHANT_ID"?"receiver_id":"item_name";
      data[field]=value;
      assert.equal(verifiedPayment(data,tx,{...env,[key]:value}),false);
    });
  }
}

test("PDT sends the exact transaction to the trusted gateway without following redirects",async()=>{
  let calls=0;
  const result=await pdt(tx,{PAYPAL_PDT_TOKEN:"test-token"},async(url,options)=>{
    calls++;
    assert.equal(url,"https://www.paypal.com/cgi-bin/webscr");
    assert.equal(options.method,"POST");
    assert.equal(options.redirect,"manual");
    assert.equal(options.headers["Content-Type"],"application/x-www-form-urlencoded");
    assert.deepEqual(Object.fromEntries(options.body),{cmd:"_notify-synch",tx,at:"test-token"});
    return new Response("SUCCESS\ntxn_id="+tx+"\npayment_status=Completed\n",{status:200});
  });
  assert.equal(calls,1);
  assert.deepEqual(result,{txn_id:tx,payment_status:"Completed"});
});

for(const status of [301,302,303,307,308]) {
  test("PDT redirect "+status+" fails closed without a second request",async()=>{
    let calls=0;
    await assert.rejects(pdt(tx,{PAYPAL_PDT_TOKEN:"test-token"},async(_url,options)=>{
      calls++;
      assert.equal(options.redirect,"manual");
      return new Response(null,{status,headers:{Location:"https://untrusted.example/collect"}});
    }),/Unexpected PayPal redirect/);
    assert.equal(calls,1);
  });
}

test("PDT requires an HTTP 200 SUCCESS response",async()=>{
  for(const status of [201,400,500]) {
    await assert.rejects(pdt(tx,{PAYPAL_PDT_TOKEN:"test-token"},async()=>new Response("SUCCESS\n",{status})),/PayPal unavailable/);
  }
  assert.equal(await pdt(tx,{PAYPAL_PDT_TOKEN:"test-token"},async()=>new Response("FAIL\n",{status:200})),null);
});

test("invalid PDT configuration makes no network request",async()=>{
  let calls=0;
  const fetcher=async()=>{calls++;throw Error("must not request");};
  for(const token of [undefined,"","   "]) {
    await assert.rejects(pdt(tx,{PAYPAL_PDT_TOKEN:token},fetcher),/Invalid PayPal verification configuration/);
  }
  await assert.rejects(pdt("invalid-tx",{PAYPAL_PDT_TOKEN:"test-token"},fetcher),/Invalid PayPal verification configuration/);
  assert.equal(calls,0);
});

