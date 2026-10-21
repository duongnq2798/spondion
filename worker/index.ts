import { handleApi } from './api.ts';
import type { MerchantEnv } from './api.ts';

interface Env extends MerchantEnv { ASSETS: { fetch(request: Request): Promise<Response> } }
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/') || path.startsWith('/v1/')) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
};
