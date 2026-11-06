// First-time bootstrap only. No Stripe, Supabase or license processing.
export default {
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
    if (request.method === "GET" && pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, configured: false, bootstrap: true }), { status: 200, headers });
    }
    return new Response(JSON.stringify({ error: "V200 activation setup is not complete; no payments or PINs are processed." }), { status: 503, headers });
  }
};
