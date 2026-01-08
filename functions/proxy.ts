const API_BASE_URL = "https://api.paugram.com/netease/";
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "accept-ranges", "content-length", "content-range", "etag", "last-modified", "expires"];

function createCorsHeaders(init?: Headers): Headers {
  const headers = new Headers();
  if (init) {
    for (const [key, value] of init.entries()) {
      if (SAFE_RESPONSE_HEADERS.includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }
  }
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  headers.set("Access-Control-Allow-Origin", "*");
  return headers;
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function isAllowedAudioHost(hostname: string): boolean {
  if (!hostname) return false;
  // 允许主流音乐平台的域名
  return (
    KUWO_HOST_PATTERN.test(hostname) || 
    hostname.includes("music.126.net") || 
    hostname.includes("qq.com") || 
    hostname.includes("myqcloud.com") || 
    hostname.includes("kugou.com") ||
    hostname.includes("migu.cn")
  );
}

function normalizeAudioUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (!isAllowedAudioHost(parsed.hostname)) {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    // 酷我音乐通常需要 http
    if (KUWO_HOST_PATTERN.test(parsed.hostname)) {
        parsed.protocol = "http:";
    }
    return parsed;
  } catch {
    return null;
  }
}

async function proxyAudio(targetUrl: string, request: Request): Promise<Response> {
  const normalized = normalizeAudioUrl(targetUrl);
  if (!normalized) {
    return new Response("Invalid target", { status: 400 });
  }

  const init: RequestInit = {
    method: request.method,
    headers: {
      "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
    },
  };

  if (KUWO_HOST_PATTERN.test(normalized.hostname)) {
      (init.headers as Record<string, string>)["Referer"] = "https://www.kuwo.cn/";
  }

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    (init.headers as Record<string, string>)["Range"] = rangeHeader;
  }

  const upstream = await fetch(normalized.toString(), init);
  
  // 复制原始响应头，但需要处理 CORS 和 Range
  const headers = new Headers();
  
  // 允许的原始头
  const allowedHeaders = [
    "content-type", 
    "content-length", 
    "content-range", 
    "accept-ranges", 
    "cache-control", 
    "expires", 
    "last-modified", 
    "etag"
  ];

  for (const [key, value] of upstream.headers.entries()) {
    if (allowedHeaders.includes(key.toLowerCase())) {
      headers.set(key, value);
    }
  }

  // 强制 CORS
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function generateAuth(server: string, type: string, id: string): Promise<string> {
  const secret = "token"; // Meting API 默认 token
  const message = `${server}${type}${id}`;
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(message);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", cryptoKey, messageData);
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function proxyApiRequest(url: URL, request: Request): Promise<Response> {
  const apiUrl = new URL(API_BASE_URL);
  
  const types = url.searchParams.get("types");
  const name = url.searchParams.get("name");
  const id = url.searchParams.get("id");
  
  if (types === "search") {
    // 保罗 API 使用 title 参数进行搜索
    apiUrl.searchParams.set("title", name || "");
  } else {
    // 获取详情、播放链接、歌词等均使用 id 参数
    apiUrl.searchParams.set("id", id || "");
  }

  const upstream = await fetch(apiUrl.toString(), {
    headers: {
      "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
      "Accept": "application/json",
    },
    redirect: "follow"
  });

  const headers = createCorsHeaders(upstream.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export async function onRequest({ request }: { request: Request }): Promise<Response> {
  if (request.method === "OPTIONS") {
    return handleOptions();
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("target");

  if (target) {
    return proxyAudio(target, request);
  }

  return proxyApiRequest(url, request);
}
