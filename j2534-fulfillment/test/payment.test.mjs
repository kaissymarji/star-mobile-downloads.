import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePdt, verifiedPayment } from "../src/worker.mjs";
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
