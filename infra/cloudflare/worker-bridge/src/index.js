/**
 * Stable acceptance bridge from workers.dev to the private Health Credential
 * Hub origin through a Cloudflare Workers VPC service.
 *
 * Do not add request, response, cookie, or error logging here. Requests can
 * contain workforce credentials and sensitive document metadata.
 */
export default {
  async fetch(request, env) {
    const publicUrl = new URL(request.url);
    const upstreamUrl = new URL(request.url);
    upstreamUrl.protocol = "http:";
    upstreamUrl.hostname = "localhost";
    upstreamUrl.port = "3000";

    const headers = new Headers(request.headers);
    headers.set("x-forwarded-host", publicUrl.host);
    headers.set("x-forwarded-proto", "https");

    const upstreamRequest = new Request(upstreamUrl, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });

    try {
      return await env.HEALTH_APP.fetch(upstreamRequest);
    } catch {
      return new Response("Service temporarily unavailable", {
        status: 503,
        headers: {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
    }
  },
};
