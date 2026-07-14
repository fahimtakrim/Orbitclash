const MAX_PLAYERS = 6;

function isNavigationRequest(request) {
  if (request.method !== 'GET') return false;
  const accept = request.headers.get('accept') || '';
  return accept.includes('text/html');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return json({
        ok: true,
        service: 'orbitclash-multiplayer',
        transport: 'encrypted-webrtc-p2p',
        maxPlayers: MAX_PLAYERS,
      });
    }

    if (url.pathname === '/api/multiplayer') {
      return json({
        ok: false,
        error: 'Orbitclash rooms use encrypted WebRTC peer discovery.',
        transport: 'webrtc',
      }, 410);
    }

    if (!env?.ASSETS?.fetch) {
      return new Response('Orbitclash asset binding is unavailable.', { status: 500 });
    }

    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404 || !isNavigationRequest(request)) return assetResponse;

    const indexUrl = new URL('/', request.url);
    const indexRequest = new Request(indexUrl, { method: 'GET', headers: request.headers });
    return env.ASSETS.fetch(indexRequest);
  },
};
