import path from "node:path";

export function fastApiObservedEndpoints(source: string): string[] {
  if (!looksLikeFastApiSource(source)) {
    return [];
  }
  const endpoints: string[] = [];
  const routePattern = /^\s*@[A-Za-z_][\w.]*\.(get|post|put|patch|delete|options|head)\(\s*["']([^"']+)["']/gm;
  for (const match of source.matchAll(routePattern)) {
    const method = (match[1] ?? "").toUpperCase();
    const route = match[2] ?? "";
    if (!method || !route.startsWith("/") || /\s/.test(route)) {
      continue;
    }
    endpoints.push(`${method} ${route}`);
    if (endpoints.length >= 100) {
      break;
    }
  }
  return uniqueObservedEndpoints(endpoints);
}

function looksLikeFastApiSource(source: string): boolean {
  return /\bfrom\s+fastapi\s+import\b|\bimport\s+fastapi\b|\bFastAPI\s*\(|\bAPIRouter\s*\(/.test(source);
}

export function flaskObservedEndpoints(source: string): string[] {
  if (!looksLikeFlaskSource(source)) {
    return [];
  }
  const endpoints: string[] = [];
  const methodRoutePattern = /^\s*@[A-Za-z_][\w.]*\.(get|post|put|patch|delete|options|head)\(\s*["']([^"']+)["']/gm;
  for (const match of source.matchAll(methodRoutePattern)) {
    const method = (match[1] ?? "").toUpperCase();
    const route = match[2] ?? "";
    if (!method || !route.startsWith("/") || /\s/.test(route)) {
      continue;
    }
    endpoints.push(`${method} ${route}`);
    if (endpoints.length >= 100) {
      break;
    }
  }

  const routePattern = /^\s*@[A-Za-z_][\w.]*\.route\(\s*["']([^"']+)["']([^)]*)\)/gm;
  for (const match of source.matchAll(routePattern)) {
    const route = match[1] ?? "";
    if (!route.startsWith("/") || /\s/.test(route)) {
      continue;
    }
    const methods = flaskRouteMethods(match[2] ?? "");
    for (const method of methods) {
      endpoints.push(`${method} ${route}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }
  return uniqueObservedEndpoints(endpoints);
}

function looksLikeFlaskSource(source: string): boolean {
  return /\bfrom\s+flask\s+import\b|\bimport\s+flask\b|\bFlask\s*\(|\bBlueprint\s*\(/.test(source);
}

function flaskRouteMethods(routeArgs: string): string[] {
  const methodsMatch = /\bmethods\s*=\s*\[([^\]]+)\]/.exec(routeArgs) ?? /\bmethods\s*=\s*\(([^)]*)\)/.exec(routeArgs);
  if (!methodsMatch) {
    return ["GET"];
  }
  const methods = [...(methodsMatch[1] ?? "").matchAll(/["']([A-Za-z]+)["']/g)]
    .map((match) => (match[1] ?? "").toUpperCase())
    .filter((method) => ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method));
  return methods.length ? [...new Set(methods)] : ["GET"];
}

export function fastifyObservedEndpoints(source: string): string[] {
  if (!looksLikeFastifySource(source)) {
    return [];
  }
  const endpoints: string[] = [];

  const directRoutePattern = /\b[A-Za-z_$][\w$]*\.(get|post|put|patch|delete|options|head|all)\s*\(\s*(["'`])([^"'`]+)\2/g;
  for (const match of source.matchAll(directRoutePattern)) {
    const method = (match[1] ?? "").toLowerCase();
    const route = fastifyRoutePath(match[3] ?? "");
    if (!method || !route) {
      continue;
    }
    if (method === "all") {
      for (const allMethod of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
        endpoints.push(`${allMethod} ${route}`);
      }
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
      continue;
    }
    endpoints.push(`${method.toUpperCase()} ${route}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  const routeMethodPattern = /\b[A-Za-z_$][\w$]*\.route\s*\(\s*\{([\s\S]{0,260}?)\}\s*\)/g;
  for (const match of source.matchAll(routeMethodPattern)) {
    const routeConfig = match[1] ?? "";
    const route = fastifyRoutePath(routeConfig);
    if (!route) {
      continue;
    }
    const methods = fastifyRouteMethods(routeConfig);
    for (const method of methods) {
      endpoints.push(`${method} ${route}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }

  return uniqueObservedEndpoints(endpoints);
}

function looksLikeFastifySource(source: string): boolean {
  return /\bfrom\s+fastify\s+import\b|\bimport\s+fastify\b|\bFastify\b|\bfastify\s*\(\s*\)/.test(source);
}

function fastifyRoutePath(routeConfig: string): string | null {
  if (routeConfig.startsWith("/") && !/\s/.test(routeConfig) && !routeConfig.includes("${") && !routeConfig.includes("`")) {
    return routeConfig;
  }
  const quotedPathMatch = /\b(?:url|path)\s*:\s*(["'`])([^"'`]+)\1/.exec(routeConfig);
  if (quotedPathMatch) {
    const normalized = quotedPathMatch[2] ?? "";
    if (!normalized || !normalized.startsWith("/") || /\s/.test(normalized) || normalized.includes("${") || normalized.includes("`")) {
      return null;
    }
    return normalized;
  }
  const backtickPathMatch = /\b(?:url|path)\s*:\s*`([^`]+)`/.exec(routeConfig);
  if (backtickPathMatch) {
    return null;
  }
  return null;
}

function fastifyRouteMethods(routeConfig: string): string[] {
  const methodMatch = /\b(?:method)\s*:\s*(\[[^\]]+\]|["'][A-Za-z]+["'])/.exec(routeConfig);
  if (!methodMatch) {
    return ["GET"];
  }
  const raw = methodMatch[1] ?? "";
  const methods = new Set<string>();
  for (const match of raw.matchAll(/["']([A-Za-z]+)["']/g)) {
    const method = (match[1] ?? "").toUpperCase();
    if (["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method)) {
      methods.add(method);
    }
  }
  return methods.size ? [...methods] : ["GET"];
}

export function starletteObservedEndpoints(source: string): string[] {
  if (!looksLikeStarletteSource(source)) {
    return [];
  }
  const endpoints: string[] = [];
  const routePattern = /\bRoute\(\s*["']([^"']+)["']([^)]*)\)/g;
  for (const match of source.matchAll(routePattern)) {
    const route = match[1] ?? "";
    if (!route.startsWith("/") || /\s/.test(route)) {
      continue;
    }
    const methods = pythonRouteMethods(match[2] ?? "");
    for (const method of methods) {
      endpoints.push(`${method} ${route}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }

  const addRoutePattern = /\.[A-Za-z_]*(?:add_route|add_api_route)\(\s*["']([^"']+)["']([^)]*)\)/g;
  for (const match of source.matchAll(addRoutePattern)) {
    const route = match[1] ?? "";
    if (!route.startsWith("/") || /\s/.test(route)) {
      continue;
    }
    const methods = pythonRouteMethods(match[2] ?? "");
    for (const method of methods) {
      endpoints.push(`${method} ${route}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }
  return uniqueObservedEndpoints(endpoints);
}

function looksLikeStarletteSource(source: string): boolean {
  return /\bfrom\s+starlette\b|\bimport\s+starlette\b|\bStarlette\s*\(|\bfrom\s+fastapi\s+import\b|\bFastAPI\s*\(/.test(source);
}

export function djangoObservedEndpoints(source: string): string[] {
  if (!looksLikeDjangoSource(source)) {
    return [];
  }
  const endpoints: string[] = [];
  const routePattern = /\b(?:path|re_path)\(\s*(?:r|R)?["']([^"']+)["']/g;
  for (const match of source.matchAll(routePattern)) {
    const route = djangoRoutePath(match[1] ?? "");
    if (!route) {
      continue;
    }
    endpoints.push(`${inferredStaticRouteMethod(route)} ${route}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }
  return uniqueObservedEndpoints(endpoints);
}

function looksLikeDjangoSource(source: string): boolean {
  return /\bfrom\s+django\.urls\s+import\b|\bimport\s+django\.urls\b|\burlpatterns\s*=|\bfrom\s+rest_framework\b|\bimport\s+rest_framework\b/.test(source);
}

function djangoRoutePath(route: string): string | null {
  let normalized = route.trim();
  if (!normalized || /\s/.test(normalized)) {
    return null;
  }
  normalized = normalized.replace(/^\^/, "").replace(/\$$/, "").replaceAll("\\/", "/");
  if (/[()[\]|?+*]/.test(normalized)) {
    return null;
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function expressObservedEndpoints(source: string): string[] {
  if (!looksLikeExpressSource(source)) {
    return [];
  }
  const endpoints: string[] = [];
  const directRoutePattern = /\b[A-Za-z_$][\w$]*\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*(["'`])([^"'`]+)\2/g;
  for (const match of source.matchAll(directRoutePattern)) {
    const method = (match[1] ?? "").toUpperCase();
    const route = expressRoutePath(match[3] ?? "");
    if (!method || !route) {
      continue;
    }
    endpoints.push(`${method} ${route}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  const routeChainPattern = /\b[A-Za-z_$][\w$]*\s*\.\s*route\s*\(\s*(["'`])([^"'`]+)\1\s*\)((?:\s*\.\s*(?:get|post|put|patch|delete|options|head)\s*\([^;]*)+)/g;
  for (const match of source.matchAll(routeChainPattern)) {
    const route = expressRoutePath(match[2] ?? "");
    if (!route) {
      continue;
    }
    for (const methodMatch of (match[3] ?? "").matchAll(/\.\s*(get|post|put|patch|delete|options|head)\s*\(/g)) {
      endpoints.push(`${(methodMatch[1] ?? "").toUpperCase()} ${route}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }

  return uniqueObservedEndpoints(endpoints);
}

function looksLikeExpressSource(source: string): boolean {
  return /\brequire\s*\(\s*["']express["']\s*\)|\bfrom\s+["']express["']|\bimport\s+express\b|\bexpress\s*\.\s*Router\s*\(|\bRouter\s*\(\s*\)/.test(source);
}

function expressRoutePath(route: string): string | null {
  const normalized = route.trim();
  if (!normalized.startsWith("/") || /\s/.test(normalized) || normalized.includes("${")) {
    return null;
  }
  return normalized;
}

export function koaObservedEndpoints(source: string): string[] {
  if (!looksLikeKoaSource(source)) {
    return [];
  }
  const endpoints: string[] = [];
  const directRoutePattern = /\b(?:[A-Za-z_$][\w$]*|app|router)\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*(["'`])([^"'`]+)\2/g;
  for (const match of source.matchAll(directRoutePattern)) {
    const method = (match[1] ?? "").toUpperCase();
    const route = expressRoutePath(match[3] ?? "");
    if (!method || !route) {
      continue;
    }
    endpoints.push(`${method} ${route}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  const routeChainPattern = /\b(?:[A-Za-z_$][\w$]*|app|router)\.route\s*\(\s*(["'`])([^"'`]+)\1[^)]*\)\s*((?:\.[a-z]+\s*\([^;]*)+)/g;
  for (const match of source.matchAll(routeChainPattern)) {
    const route = expressRoutePath(match[2] ?? "");
    if (!route) {
      continue;
    }
    const chainMethods = koaRouteChainMethods(match[3] ?? "");
    for (const method of chainMethods) {
      endpoints.push(`${method} ${route}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }

  return uniqueObservedEndpoints(endpoints);
}

function looksLikeKoaSource(source: string): boolean {
  return /\bfrom\s+["']koa["']|\bimport\s+Koa\b|\bnew\s+Koa\s*\(|\bfrom\s+["']@koa\/router["']|\bnew\s+Router\s*\(|\bkoa-router\b/.test(source);
}

function koaRouteChainMethods(routeChain: string): string[] {
  const methods = new Set<string>();
  for (const methodMatch of routeChain.matchAll(/\.\s*(get|post|put|patch|delete|options|head)\s*\(/g)) {
    methods.add((methodMatch[1] ?? "").toUpperCase());
  }
  return methods.size ? [...methods] : [];
}

export function honoObservedEndpoints(source: string): string[] {
  if (!looksLikeHonoSource(source)) {
    return [];
  }
  const endpoints: string[] = [];
  const directRoutePattern = /\b(?:[A-Za-z_$][\w$]*|app|router)\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*(["'`])([^"'`]+)\2/g;
  for (const match of source.matchAll(directRoutePattern)) {
    const method = (match[1] ?? "").toUpperCase();
    const route = expressRoutePath(match[3] ?? "");
    if (!method || !route) {
      continue;
    }
    endpoints.push(`${method} ${route}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  const onRoutePattern = /\b(?:[A-Za-z_$][\w$]*|app|router)\.on\s*\(\s*(\[[^\]]+\]|["'][A-Za-z]+["'])\s*,\s*(["'`])([^"'`]+)\2/g;
  for (const match of source.matchAll(onRoutePattern)) {
    const methods = honoRouteMethods(match[1] ?? "");
    const route = expressRoutePath(match[3] ?? "");
    if (!route) {
      continue;
    }
    for (const method of methods) {
      endpoints.push(`${method} ${route}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }

  return uniqueObservedEndpoints(endpoints);
}

function looksLikeHonoSource(source: string): boolean {
  return /\bfrom\s+["']hono["']|\bimport\s+\{\s*Hono\s*\}\s+from\s+["']hono["']|\bnew\s+Hono\s*\(/.test(source);
}

function honoRouteMethods(routeMethods: string): string[] {
  const methods = new Set<string>();
  for (const methodMatch of routeMethods.matchAll(/["']([A-Za-z]+)["']/g)) {
    const method = (methodMatch[1] ?? "").toUpperCase();
    if (["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method)) {
      methods.add(method);
    }
  }
  return methods.size ? [...methods] : ["GET"];
}

export function nestJsObservedEndpoints(source: string): string[] {
  if (!looksLikeNestJsSource(source)) {
    return [];
  }
  const endpoints: string[] = [];
  const routeMethodPattern = /@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(\s*(?:(["']([^"']+)["']|`([^`]+)`)(?:\s*,\s*[^)]*)?)?\s*\)/g;
  const controllerMatch = /@Controller\s*\(\s*(["']([^"']+)["']|`([^`]+)`)?\s*\)/.exec(source);
  const controller = nestJsPathFromMatch(controllerMatch);

  for (const match of source.matchAll(routeMethodPattern)) {
    const fullDecorator = (match[0] ?? "").trim();
    const methodNameMatch = /@(Get|Post|Put|Patch|Delete|Options|Head|All)/.exec(fullDecorator);
    const methodName = (methodNameMatch?.[1] ?? "").toUpperCase();
    const methods = methodName === "ALL" ? ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] : [methodName];
    const normalizedMethodPath = (match[3] ?? match[4] ?? "").trim();
    const route = nestJsRoutePath(normalizedMethodPath);
    if (!route) {
      continue;
    }
    const fullRoute = combineNestJsRoute(controller, route);
    if (!fullRoute) {
      continue;
    }
    for (const method of methods) {
      endpoints.push(`${method} ${fullRoute}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }
  return uniqueObservedEndpoints(endpoints);
}

function looksLikeNestJsSource(source: string): boolean {
  return /\bimport\s+\{[^}]*\b(?:Get|Post|Put|Patch|Delete|Options|Head|All|Controller|Module)\b[^}]*\}\s+from\s+["']@nestjs\/common["']|\b@Controller\b|\b@Get\b|\b@Post\b|\b@Put\b|\b@Patch\b|\b@Delete\b|\b@Options\b|\b@Head\b|\b@All\b/.test(source);
}

export function nextJsObservedEndpoints(source: string): string[] {
  if (!looksLikeNextJsSource(source)) {
    return [];
  }
  const methods = new Set<string>();
  for (const match of source.matchAll(/\bexport\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g)) {
    const method = (match[1] ?? "").toUpperCase();
    if (method) {
      methods.add(method);
    }
  }
  return methods.size ? [...methods] : [];
}

function looksLikeNextJsSource(source: string): boolean {
  return /\bfrom\s+["']next\/server["']|\bNextRequest\b|\bNextResponse\b|\bexport\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/.test(source);
}

export function isNextJsApiRouteCandidate(relativePath: string): boolean {
  return /^app\/(?:.*\/)?route\.(?:js|jsx|ts|tsx|mjs|cjs)$/.test(relativePath) || /^pages\/api\/.*\.(?:js|jsx|ts|tsx|mjs|cjs)$/.test(relativePath);
}

export function nextJsRoutePath(relativePath: string): string | null {
  const routePath = relativePath.replaceAll(path.sep, "/");
  if (/^app\/(?:.*\/)?route\.(?:js|jsx|ts|tsx|mjs|cjs)$/.test(routePath)) {
    const withoutPrefix = routePath.replace(/^app\//, "");
    const segments = withoutPrefix.split("/");
    segments.pop();
    return nextJsSegmentsToRoute(segments);
  }
  if (/^pages\/api\/.*\.(?:js|jsx|ts|tsx|mjs|cjs)$/.test(routePath)) {
    const withoutPrefix = routePath
      .replace(/^pages\/api\//, "")
      .replace(/\.(?:js|jsx|ts|tsx|mjs|cjs)$/, "");
    const segments = withoutPrefix.split("/");
    const routeSuffix = nextJsSegmentsToRoute(segments);
    if (!routeSuffix) {
      return null;
    }
    return routeSuffix === "/" ? "/api" : `/api${routeSuffix}`;
  }
  return null;
}

function nextJsSegmentsToRoute(segments: string[]): string | null {
  const filtered = segments.flatMap((segment) => {
    const normalized = nextJsNormalizeSegment(segment);
    if (!normalized) {
      return [];
    }
    return [normalized];
  });
  if (!filtered.length) {
    return "/";
  }
  const route = `/${filtered.join("/")}`;
  return route === "/index" ? "/" : route;
}

function nextJsNormalizeSegment(segment: string): string | null {
  if (!segment || segment === "index" || segment.startsWith(".") || segment === "") {
    return null;
  }
  const optionalCatchAll = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(segment);
  if (optionalCatchAll) {
    return `{${optionalCatchAll[1]}}`;
  }
  const catchAll = /^\[\.\.\.([^\]]+)\]$/.exec(segment);
  if (catchAll) {
    return `{${catchAll[1]}}`;
  }
  const dynamic = /^\[([^\]]+)\]$/.exec(segment);
  if (dynamic) {
    return `{${dynamic[1]}}`;
  }
  return segment;
}

export function legacyHttpObservedEndpoints(source: string): string[] {
  const endpoints: string[] = [
    ...legacyPythonObservedEndpoints(source),
    ...legacyNodeObservedEndpoints(source),
    ...legacyGoObservedEndpoints(source),
  ];
  return uniqueObservedEndpoints(endpoints);
}

function legacyPythonObservedEndpoints(source: string): string[] {
  if (!looksLikeLegacyPythonHttpSource(source)) {
    return [];
  }
  const endpoints = new Set<string>();
  const baseServerPattern = /\b(?:self|request)\.path(?:\s*===?\s*|\s*==\s*|\s*\.startswith\(\s*)(["'`])(\/[^"'`]+)\1/g;

  let currentHandlerMethod: string | null = null;
  for (const line of source.split(/\r?\n/)) {
    const handlerMatch = /\bdef\s+do_(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(/i.exec(line);
    if (handlerMatch) {
      currentHandlerMethod = (handlerMatch[1] ?? "").toUpperCase();
    } else if (/^\s*def\s+/.test(line)) {
      currentHandlerMethod = null;
    }
    for (const match of line.matchAll(baseServerPattern)) {
      const route = normalizeLegacyRoutePath(match[2] ?? "");
      if (!route) {
        continue;
      }
      if (currentHandlerMethod) {
        endpoints.add(`${currentHandlerMethod} ${route}`);
        continue;
      }
      endpoints.add(`GET ${route}`);
      endpoints.add(`POST ${route}`);
    }
  }

  return [...endpoints];
}

function legacyNodeObservedEndpoints(source: string): string[] {
  if (!looksLikeLegacyNodeHttpSource(source)) {
    return [];
  }
  const endpoints = new Set<string>();

  for (const match of source.matchAll(/\breq(?:uest)?\.(?:url|path)\s*(?:===|==)\s*(["'`])([\/][^"'`]+)\1/g)) {
    const route = normalizeLegacyRoutePath(match[2] ?? "");
    if (!route) {
      continue;
    }
    endpoints.add(`GET ${route}`);
  }

  for (const match of source.matchAll(/\breq(?:uest)?\.(?:url|path)\.startsWith\(\s*(["'`])([\/][^"'`]+)\1/g)) {
    const route = normalizeLegacyRoutePath(match[2] ?? "");
    if (!route) {
      continue;
    }
    endpoints.add(`GET ${route}`);
  }

  return [...endpoints];
}

function legacyGoObservedEndpoints(source: string): string[] {
  if (!looksLikeLegacyGoHttpSource(source)) {
    return [];
  }
  const endpoints = new Set<string>();
  for (const match of source.matchAll(/HandleFunc\s*\(\s*(["'])(\/[^"']+)\1\s*,/g)) {
    const route = normalizeLegacyRoutePath(match[2] ?? "");
    if (!route) {
      continue;
    }
    endpoints.add(`GET ${route}`);
  }
  for (const match of source.matchAll(/Handle\s*\(\s*(["'])(\/[^"']+)\1\s*,/g)) {
    const route = normalizeLegacyRoutePath(match[2] ?? "");
    if (!route) {
      continue;
    }
    endpoints.add(`GET ${route}`);
  }
  return [...endpoints];
}

function looksLikeLegacyPythonHttpSource(source: string): boolean {
  return /\bfrom\s+http\.server\s+import\b|\bimport\s+http\.server\b|\bfrom\s+wsgiref\.simple_server\s+import\b|\bmake_server\s*\(/.test(source);
}

function looksLikeLegacyNodeHttpSource(source: string): boolean {
  return /\brequire\s*\(\s*["']http["']\s*\)|\bimport\s+http\b|\bfrom\s+["']http["']/.test(source) && /\bcreateServer\s*\(/.test(source);
}

function looksLikeLegacyGoHttpSource(source: string): boolean {
  return /\bpackage\s+main\b/.test(source) && /\bimport[\s\S]*?net\/http\b/.test(source);
}

function normalizeLegacyRoutePath(route: string): string | null {
  const trimmed = route.trim();
  if (!trimmed.startsWith("/") || /\s/.test(trimmed) || trimmed.includes("${")) {
    return null;
  }
  return trimmed === "//" ? "/" : trimmed;
}

export function grpcObservedEndpoints(source: string): string[] {
  if (!looksLikeGrpcSource(source)) {
    return [];
  }
  const endpoints: string[] = [];
  for (const serviceMatch of grpcServiceBlocks(source)) {
    const serviceName = serviceMatch.serviceName;
    const serviceBody = serviceMatch.body;
    if (!serviceName || !serviceBody) {
      continue;
    }
    for (const rpcMatch of grpcRpcBlocks(serviceBody)) {
      const methodName = rpcMatch.methodName;
      const rpcBody = rpcMatch.body;
      const mappedEndpoints = grpcHttpMappedEndpoints(rpcBody, methodName);
      if (mappedEndpoints.length) {
        for (const endpoint of mappedEndpoints) {
          endpoints.push(endpoint);
          if (endpoints.length >= 100) {
            return uniqueObservedEndpoints(endpoints);
          }
        }
        continue;
      }
      endpoints.push(`POST /grpc/${serviceName}/${methodName}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }
  return uniqueObservedEndpoints(endpoints);
}

function grpcRpcBlocks(serviceBody: string): Array<{ methodName: string; body: string }> {
  const blocks: Array<{ methodName: string; body: string }> = [];
  const rpcPattern = /rpc\s+([A-Za-z_][\w]*)\s*\([^)]*\)\s*returns\s*\([^)]*\)\s*(\{|;)/g;
  for (const match of serviceBody.matchAll(rpcPattern)) {
    const methodName = (match[1] ?? "").trim();
    const terminator = match[2] ?? "";
    if (!methodName || match.index === undefined) {
      continue;
    }
    if (terminator === ";") {
      blocks.push({ methodName, body: ";" });
      continue;
    }
    const bodyStart = match.index + match[0].length;
    let depth = 1;
    let cursor = bodyStart;
    while (cursor < serviceBody.length && depth > 0) {
      const char = serviceBody[cursor];
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
      }
      cursor += 1;
    }
    if (depth === 0) {
      blocks.push({ methodName, body: serviceBody.slice(bodyStart - 1, cursor) });
    }
  }
  return blocks;
}

function grpcServiceBlocks(source: string): Array<{ serviceName: string; body: string }> {
  const blocks: Array<{ serviceName: string; body: string }> = [];
  const servicePattern = /service\s+([A-Za-z_][\w]*)\s*\{/g;
  for (const match of source.matchAll(servicePattern)) {
    const serviceName = (match[1] ?? "").trim();
    const bodyStart = match.index === undefined ? -1 : match.index + match[0].length;
    if (!serviceName || bodyStart < 0) {
      continue;
    }
    let depth = 1;
    let cursor = bodyStart;
    while (cursor < source.length && depth > 0) {
      const char = source[cursor];
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
      }
      cursor += 1;
    }
    if (depth === 0) {
      blocks.push({ serviceName, body: source.slice(bodyStart, cursor - 1) });
    }
  }
  return blocks;
}

function looksLikeGrpcSource(source: string): boolean {
  return /\bservice\s+[A-Za-z_][\w]*\s*\{/.test(source) && /\brpc\s+[A-Za-z_][\w]*\s*\([^)]+\)\s*returns\s*\([^)]+\)/.test(source);
}

function grpcHttpMappedEndpoints(rpcBody: string, fallbackMethodName: string): string[] {
  if (!rpcBody.includes("google.api.http")) {
    return [];
  }
  const httpBlocks = Array.from(rpcBody.matchAll(/option\s*\(\s*google\.api\.http\s*\)\s*=\s*\{([\s\S]*?)\}\s*;/g));
  if (!httpBlocks.length) {
    return [];
  }

  const endpoints: string[] = [];
  for (const block of httpBlocks) {
    const blockBody = block[1] ?? "";
    const mapped = grpcHttpBlockEndpoints(blockBody);
    for (const endpoint of mapped) {
      endpoints.push(endpoint);
    }
  }
  if (!endpoints.length && /option\s*\(\s*google\.api\.http/.test(rpcBody)) {
    const route = grpcHttpBodyToRoute(rpcBody);
    if (route) {
      const candidate = fallbackMethodName ? `/grpc/${fallbackMethodName}` : "/grpc";
      const normalizedRoute = route === "/" ? candidate : route;
      endpoints.push(`POST ${normalizedRoute}`);
    }
  }
  return endpoints;
}

function grpcHttpBlockEndpoints(blockBody: string): string[] {
  const endpoints: string[] = [];
  const methodMap: Record<string, string[]> = {
    get: ["GET"],
    put: ["PUT"],
    post: ["POST"],
    patch: ["PATCH"],
    delete: ["DELETE"],
    options: ["OPTIONS"],
    head: ["HEAD"],
  };
  for (const [methodName, methods] of Object.entries(methodMap)) {
    const rawPath = grpcHttpBodyMethodPath(blockBody, methodName);
    if (!rawPath) {
      continue;
    }
    const normalizedPath = grpcHttpPath(rawPath);
    if (!normalizedPath) {
      continue;
    }
    for (const method of methods) {
      endpoints.push(`${method} ${normalizedPath}`);
    }
  }
  return endpoints;
}

function grpcHttpBodyMethodPath(blockBody: string, methodName: string): string | null {
  const methodBlock = new RegExp(`\\b${methodName}\\s*:\\s*["']([^"']+)["']`, "i").exec(blockBody);
  if (!methodBlock) {
    return null;
  }
  const raw = (methodBlock[1] ?? "").trim();
  if (!raw || !raw.startsWith("/")) {
    return null;
  }
  return raw;
}

function grpcHttpBodyToRoute(source: string): string | null {
  const anyHttp = /google\.api\.http/.exec(source);
  if (!anyHttp) {
    return null;
  }
  const methodPath = /(?:get|post|put|patch|delete|options|head)\s*:\s*["']([^"']+)["']/i.exec(source);
  return grpcHttpPath(methodPath?.[1] ?? "") ?? null;
}

function grpcHttpPath(rawPath: string): string | null {
  if (!rawPath || /\s/.test(rawPath)) {
    return null;
  }
  const normalized = rawPath
    .replace(/\{([A-Za-z_][A-Za-z0-9_]*)=[^}]+\}/g, "{$1}")
    .replace(/\\\//g, "/")
    .replace(/\/\/+/g, "/");
  return normalized.startsWith("/") ? normalized : null;
}

function nestJsPathFromMatch(match: RegExpMatchArray | null): string {
  if (!match) {
    return "";
  }
  const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
  if (!raw) {
    return "";
  }
  return nestJsPath(raw, true);
}

function nestJsRoutePath(rawPath: string): string | null {
  if (!rawPath) {
    return "/";
  }
  const normalized = rawPath.trim();
  if (!normalized || /\s/.test(normalized) || normalized.includes("${")) {
    return null;
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function combineNestJsRoute(controllerPath: string, routePath: string): string | null {
  const normalizedController = nestJsPath(controllerPath, true);
  const normalizedRoute = nestJsPath(routePath);
  if (!normalizedRoute) {
    return null;
  }
  if (!normalizedController) {
    return normalizedRoute;
  }
  const trimmedRoute = normalizedRoute === "/" ? "" : normalizedRoute;
  return trimmedRoute ? `/${normalizedController}/${trimmedRoute.replace(/^\//, "")}` : `/${normalizedController}`;
}

function nestJsPath(rawPath: string, keepSlashless = false): string {
  const normalized = rawPath.trim().replace(/\/+$/g, "").replace(/^[`'"]|[`'"]$/g, "");
  if (!normalized || normalized.includes("${")) {
    return "";
  }
  if (keepSlashless) {
    return normalized;
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function goObservedEndpoints(source: string): string[] {
  if (!looksLikeGoWebSource(source)) {
    return [];
  }
  const endpoints: string[] = [];
  const directRoutePattern = /\.\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Get|Post|Put|Patch|Delete|Options|Head)\s*\(\s*(["`])([^"`]+)\2/g;
  for (const match of source.matchAll(directRoutePattern)) {
    const method = (match[1] ?? "").toUpperCase();
    const route = goRoutePath(match[3] ?? "");
    if (!method || !route) {
      continue;
    }
    endpoints.push(`${method} ${route}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  const muxRoutePattern = /\.\s*HandleFunc\s*\(\s*(["`])([^"`]+)\1[^\n;]*\)\s*\.\s*Methods\s*\(([^)]*)\)/g;
  for (const match of source.matchAll(muxRoutePattern)) {
    const route = goRoutePath(match[2] ?? "");
    if (!route) {
      continue;
    }
    const methods = goRouteMethods(match[3] ?? "");
    for (const method of methods) {
      endpoints.push(`${method} ${route}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }

  const handleFuncPattern = /(?:\bhttp\s*\.\s*|\.\s*)HandleFunc\s*\(\s*(["`])([^"`]+)\1/g;
  for (const match of source.matchAll(handleFuncPattern)) {
    const route = goRoutePath(match[2] ?? "");
    if (!route) {
      continue;
    }
    endpoints.push(`${inferredStaticRouteMethod(route)} ${route}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  return uniqueObservedEndpoints(endpoints);
}

function looksLikeGoWebSource(source: string): boolean {
  return /["`]net\/http["`]|["`]github\.com\/gin-gonic\/gin["`]|["`]github\.com\/labstack\/echo|["`]github\.com\/gofiber\/fiber|["`]github\.com\/go-chi\/chi|["`]github\.com\/gorilla\/mux/.test(source)
    || /\bgin\s*\.\s*Default\s*\(|\becho\s*\.\s*New\s*\(|\bfiber\s*\.\s*New\s*\(|\bchi\s*\.\s*NewRouter\s*\(|\bmux\s*\.\s*NewRouter\s*\(/.test(source);
}

function goRoutePath(route: string): string | null {
  const normalized = route.trim();
  if (!normalized.startsWith("/") || /\s/.test(normalized)) {
    return null;
  }
  return normalized;
}

function goRouteMethods(routeArgs: string): string[] {
  const methods = [...routeArgs.matchAll(/["`]([A-Za-z]+)["`]/g)]
    .map((match) => (match[1] ?? "").toUpperCase())
    .filter((method) => ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method));
  return methods.length ? [...new Set(methods)] : ["GET"];
}

export function rubyObservedEndpoints(source: string): string[] {
  if (!looksLikeRubyWebSource(source)) {
    return [];
  }
  const endpoints: string[] = [];
  const directRoutePattern = /^\s*(get|post|put|patch|delete|options|head)\s*(?:\(|\s)\s*(["'])([^"']+)\2/gim;
  for (const match of source.matchAll(directRoutePattern)) {
    const method = (match[1] ?? "").toUpperCase();
    const route = rubyRoutePath(match[3] ?? "");
    if (!method || !route) {
      continue;
    }
    endpoints.push(`${method} ${route}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  const matchRoutePattern = /^\s*match\s*(?:\(|\s)\s*(["'])([^"']+)\1([^\n]*)/gim;
  for (const match of source.matchAll(matchRoutePattern)) {
    const route = rubyRoutePath(match[2] ?? "");
    if (!route) {
      continue;
    }
    const methods = rubyRouteMethods(match[3] ?? "");
    for (const method of methods) {
      endpoints.push(`${method} ${route}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }

  const routeMethodPattern = /^\s*route\s+:?(get|post|put|patch|delete|options|head)\s*,\s*(["'])([^"']+)\2/gim;
  for (const match of source.matchAll(routeMethodPattern)) {
    const method = (match[1] ?? "").toUpperCase();
    const route = rubyRoutePath(match[3] ?? "");
    if (!method || !route) {
      continue;
    }
    endpoints.push(`${method} ${route}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  return uniqueObservedEndpoints(endpoints);
}

function looksLikeRubyWebSource(source: string): boolean {
  return /\bRails\.application\.routes\.draw\b|\bActionDispatch::Routing\b|\brequire\s+["']sinatra(?:\/base)?["']|\bSinatra::Base\b|<\s*Sinatra::Base\b|\bGrape::API\b/.test(source);
}

function rubyRoutePath(route: string): string | null {
  const normalized = route.trim();
  if (!normalized || /\s/.test(normalized) || normalized.includes("#{")) {
    return null;
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function rubyRouteMethods(routeArgs: string): string[] {
  const viaMatch = /\bvia:\s*(\[[^\]]+\]|%i\[[^\]]+\]|:[A-Za-z_]+|["'][A-Za-z]+["'])/.exec(routeArgs);
  if (!viaMatch) {
    return ["GET"];
  }
  const raw = (viaMatch[1] ?? "").trim();
  const methods = new Set<string>();
  const percentSymbolList = /^%i\[([^\]]+)\]$/.exec(raw);
  if (percentSymbolList) {
    for (const token of (percentSymbolList[1] ?? "").split(/\s+/)) {
      const method = token.toUpperCase();
      if (["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method)) {
        methods.add(method);
      }
    }
  }
  for (const match of raw.matchAll(/:([A-Za-z_]+)/g)) {
    const method = (match[1] ?? "").toUpperCase();
    if (["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method)) {
      methods.add(method);
    }
  }
  for (const match of raw.matchAll(/["']([A-Za-z]+)["']/g)) {
    const method = (match[1] ?? "").toUpperCase();
    if (["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method)) {
      methods.add(method);
    }
  }
  return methods.size ? [...methods] : ["GET"];
}

export function javaObservedEndpoints(source: string): string[] {
  if (!looksLikeJavaWebSource(source)) {
    return [];
  }
  const endpoints: string[] = [];
  const classPrefix = javaClassRoutePrefix(source);

  const directMappingPattern = /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\s*(?:\(\s*([^)]*)\))?/g;
  for (const match of source.matchAll(directMappingPattern)) {
    const method = javaMappingAnnotationMethod(match[1] ?? "");
    const route = javaRoutePath(match[2] ?? "");
    if (!method || !route) {
      continue;
    }
    endpoints.push(`${method} ${joinStaticRoutePaths(classPrefix, route)}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  const requestMappingPattern = /@RequestMapping\s*\(\s*([^)]*)\)/g;
  for (const match of source.matchAll(requestMappingPattern)) {
    const args = match[1] ?? "";
    const route = javaRoutePath(args);
    if (!route || javaAnnotationLooksClassScoped(source, match.index ?? 0)) {
      continue;
    }
    const methods = javaRouteMethods(args, route);
    for (const method of methods) {
      endpoints.push(`${method} ${joinStaticRoutePaths(classPrefix, route)}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }

  const jaxRsRoutePattern = /@(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b[\s\S]{0,240}?@Path\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(jaxRsRoutePattern)) {
    const method = (match[1] ?? "").toUpperCase();
    const route = javaRoutePath(match[2] ?? "");
    if (!method || !route) {
      continue;
    }
    endpoints.push(`${method} ${joinStaticRoutePaths(classPrefix, route)}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  return uniqueObservedEndpoints(endpoints);
}

function looksLikeJavaWebSource(source: string): boolean {
  return /\b(import\s+org\.springframework\.web\.bind\.annotation\.|@RestController\b|@Controller\b|@RequestMapping\b|@GetMapping\b|@PostMapping\b)/.test(source)
    || /\b(import\s+javax\.ws\.rs\.|import\s+jakarta\.ws\.rs\.|@Path\b|@GET\b|@POST\b)/.test(source);
}

function javaClassRoutePrefix(source: string): string {
  const springClassMatch = /@RequestMapping\s*\(\s*([^)]*)\)\s*(?:\r?\n\s*@\w+(?:\([^)]*\))?\s*){0,8}\s*(?:public\s+)?(?:abstract\s+)?(?:class|interface)\s+\w+/m.exec(source);
  if (springClassMatch) {
    return javaRoutePath(springClassMatch[1] ?? "") ?? "";
  }
  const jaxRsClassMatch = /@Path\s*\(\s*["']([^"']+)["']\s*\)\s*(?:\r?\n\s*@\w+(?:\([^)]*\))?\s*){0,8}\s*(?:public\s+)?(?:abstract\s+)?(?:class|interface)\s+\w+/m.exec(source);
  if (jaxRsClassMatch) {
    return javaRoutePath(jaxRsClassMatch[1] ?? "") ?? "";
  }
  return "";
}

function javaAnnotationLooksClassScoped(source: string, annotationIndex: number): boolean {
  const afterAnnotation = source.slice(annotationIndex, Math.min(source.length, annotationIndex + 400));
  return /^\s*@RequestMapping[^\n]*(?:\r?\n\s*@\w+(?:\([^)]*\))?\s*){0,8}\s*(?:public\s+)?(?:abstract\s+)?(?:class|interface)\s+\w+/m.test(afterAnnotation);
}

function javaMappingAnnotationMethod(annotation: string): string | null {
  const byAnnotation: Record<string, string> = {
    GetMapping: "GET",
    PostMapping: "POST",
    PutMapping: "PUT",
    PatchMapping: "PATCH",
    DeleteMapping: "DELETE",
  };
  return byAnnotation[annotation] ?? null;
}

function javaRoutePath(routeArgs: string): string | null {
  const routeMatch = /(?:value|path)\s*=\s*["']([^"']+)["']/.exec(routeArgs)
    ?? /["']([^"']+)["']/.exec(routeArgs);
  const normalized = (routeMatch?.[1] ?? routeArgs).trim();
  if (!normalized || /\s/.test(normalized) || normalized.includes("${") || normalized.includes("+")) {
    return null;
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function javaRouteMethods(routeArgs: string, route: string): string[] {
  const methods = new Set<string>();
  for (const match of routeArgs.matchAll(/RequestMethod\s*\.\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g)) {
    methods.add((match[1] ?? "").toUpperCase());
  }
  return methods.size ? [...methods] : [inferredStaticRouteMethod(route)];
}

export function dotnetObservedEndpoints(source: string): string[] {
  if (!looksLikeDotnetWebSource(source)) {
    return [];
  }
  const endpoints: string[] = [];

  const minimalRoutePattern = /\.\s*Map(Get|Post|Put|Patch|Delete|Options|Head)\s*\(\s*(["'])([^"']+)\2/g;
  for (const match of source.matchAll(minimalRoutePattern)) {
    const method = dotnetMinimalApiMethod(match[1] ?? "");
    const route = dotnetRoutePath(match[3] ?? "");
    if (!method || !route) {
      continue;
    }
    endpoints.push(`${method} ${route}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  const mapMethodsPattern = /\.\s*MapMethods\s*\(\s*(["'])([^"']+)\1\s*,\s*(?:new\s*\[\]\s*)?\{([^}]+)\}/g;
  for (const match of source.matchAll(mapMethodsPattern)) {
    const route = dotnetRoutePath(match[2] ?? "");
    if (!route) {
      continue;
    }
    const methods = dotnetHttpMethods(match[3] ?? "");
    for (const method of methods) {
      endpoints.push(`${method} ${route}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }

  const classPrefix = dotnetClassRoutePrefix(source);
  const controllerRoutePattern = /\[(HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete|HttpOptions|HttpHead|Route)\s*(?:\(\s*([^\]]*?)\s*\))?\]\s*(?:\r?\n\s*\[[^\]]+\]\s*){0,8}\s*(?:public|private|protected|internal)\s+(?:async\s+)?[A-Za-z_][\w<>,\s?.]*(?:\s+|\s*\[\]\s*)[A-Za-z_]\w*\s*\(/g;
  for (const match of source.matchAll(controllerRoutePattern)) {
    const annotation = match[1] ?? "";
    const route = dotnetRoutePathFromAttributeArgs(match[2] ?? "");
    if (route === null) {
      continue;
    }
    const method = dotnetAttributeMethod(annotation, route || classPrefix);
    if (!method) {
      continue;
    }
    endpoints.push(`${method} ${joinStaticRoutePaths(classPrefix, route)}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  return uniqueObservedEndpoints(endpoints);
}

function looksLikeDotnetWebSource(source: string): boolean {
  return /\bMicrosoft\.AspNetCore\b|\bWebApplication\.CreateBuilder\s*\(|\bMap(?:Get|Post|Put|Patch|Delete|Methods)\s*\(/.test(source)
    || /\[(?:ApiController|Route|HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete|HttpOptions|HttpHead)\b/.test(source);
}

function dotnetMinimalApiMethod(annotation: string): string | null {
  const byMethod: Record<string, string> = {
    Get: "GET",
    Post: "POST",
    Put: "PUT",
    Patch: "PATCH",
    Delete: "DELETE",
    Options: "OPTIONS",
    Head: "HEAD",
  };
  return byMethod[annotation] ?? null;
}

function dotnetAttributeMethod(annotation: string, route: string): string | null {
  const byAnnotation: Record<string, string> = {
    HttpGet: "GET",
    HttpPost: "POST",
    HttpPut: "PUT",
    HttpPatch: "PATCH",
    HttpDelete: "DELETE",
    HttpOptions: "OPTIONS",
    HttpHead: "HEAD",
  };
  return byAnnotation[annotation] ?? (annotation === "Route" ? inferredStaticRouteMethod(route) : null);
}

function dotnetClassRoutePrefix(source: string): string {
  const classRoutePattern = /\[Route\s*\(\s*(["'])([^"']+)\1\s*\)\]\s*(?:\r?\n\s*\[[^\]]+\]\s*){0,8}\s*(?:public\s+)?(?:partial\s+)?class\s+([A-Za-z_]\w*)/m;
  const match = classRoutePattern.exec(source);
  if (!match) {
    return "";
  }
  const controllerName = (match[3] ?? "").replace(/Controller$/, "");
  return dotnetRoutePath(match[2] ?? "", controllerName) ?? "";
}

function dotnetRoutePathFromAttributeArgs(routeArgs: string): string | null {
  const routeMatch = /["']([^"']*)["']/.exec(routeArgs);
  if (!routeMatch && routeArgs.trim()) {
    return null;
  }
  return dotnetRoutePath(routeMatch?.[1] ?? "");
}

function dotnetRoutePath(route: string, controllerName?: string): string | null {
  let normalized = route.trim();
  if (normalized.includes("$") || normalized.includes("+") || /\s/.test(normalized)) {
    return null;
  }
  const controllerSegment = controllerName ? controllerName.replace(/Controller$/, "").toLowerCase() : "controller";
  normalized = normalized
    .replaceAll("[controller]", controllerSegment)
    .replaceAll("[Controller]", controllerSegment)
    .replaceAll("[action]", "action")
    .replaceAll("[Action]", "action");
  return normalized.startsWith("/") || !normalized ? normalized : `/${normalized}`;
}

function dotnetHttpMethods(routeArgs: string): string[] {
  const methods = [...routeArgs.matchAll(/["']([A-Za-z]+)["']/g)]
    .map((match) => (match[1] ?? "").toUpperCase())
    .filter((method) => ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method));
  return methods.length ? [...new Set(methods)] : ["GET"];
}

export function phpObservedEndpoints(source: string): string[] {
  if (!looksLikePhpWebSource(source)) {
    return [];
  }
  const endpoints: string[] = [];

  const directRoutePattern = /\b(?:Route::|->)(get|post|put|patch|delete|options|head|any)\s*\(\s*(["'])([^"']+)\2/gim;
  for (const match of source.matchAll(directRoutePattern)) {
    const rawMethod = (match[1] ?? "").toLowerCase();
    const route = phpRoutePath(match[3] ?? "");
    if (!route) {
      continue;
    }
    const method = rawMethod === "any" ? inferredStaticRouteMethod(route) : rawMethod.toUpperCase();
    endpoints.push(`${method} ${route}`);
    if (endpoints.length >= 100) {
      return uniqueObservedEndpoints(endpoints);
    }
  }

  const methodListRoutePattern = /\b(?:Route::|->)(?:match|map)\s*\(\s*(\[[^\]]+\]|array\s*\([^)]*\))\s*,\s*(["'])([^"']+)\2/gim;
  for (const match of source.matchAll(methodListRoutePattern)) {
    const route = phpRoutePath(match[3] ?? "");
    if (!route) {
      continue;
    }
    for (const method of phpRouteMethods(match[1] ?? "")) {
      endpoints.push(`${method} ${route}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }

  const symfonyAttributePattern = /#\[Route\s*\(\s*(?:path\s*:\s*)?(["'])([^"']+)\1([\s\S]{0,240}?)\)\]\s*(?:\r?\n\s*#\[[^\]]+\]\s*){0,8}\s*(?:public|private|protected)?\s*function\b/gm;
  for (const match of source.matchAll(symfonyAttributePattern)) {
    const route = phpRoutePath(match[2] ?? "");
    if (!route) {
      continue;
    }
    const methods = phpRouteMethods(match[3] ?? "");
    for (const method of methods.length ? methods : [inferredStaticRouteMethod(route)]) {
      endpoints.push(`${method} ${route}`);
      if (endpoints.length >= 100) {
        return uniqueObservedEndpoints(endpoints);
      }
    }
  }

  return uniqueObservedEndpoints(endpoints);
}

function looksLikePhpWebSource(source: string): boolean {
  return /\bIlluminate\\Support\\Facades\\Route\b|\bRoute::(?:get|post|put|patch|delete|match|any|options|head)\s*\(/.test(source)
    || /->(?:get|post|put|patch|delete|map|any|options|head)\s*\(/.test(source)
    || /\bSlim\\Factory\\AppFactory\b|\bSymfony\\Component\\Routing\\Annotation\\Route\b|#\[Route\s*\(/.test(source);
}

function phpRoutePath(route: string): string | null {
  const normalized = route.trim();
  if (!normalized || /\s/.test(normalized) || normalized.includes("$") || normalized.includes(" . ")) {
    return null;
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function phpRouteMethods(routeArgs: string): string[] {
  const methods = new Set<string>();
  for (const match of routeArgs.matchAll(/["']([A-Za-z]+)["']/g)) {
    const method = (match[1] ?? "").toUpperCase();
    if (["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method)) {
      methods.add(method);
    }
  }
  for (const match of routeArgs.matchAll(/\bMETHOD_(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g)) {
    methods.add((match[1] ?? "").toUpperCase());
  }
  return [...methods];
}

function joinStaticRoutePaths(prefix: string, route: string): string {
  const cleanPrefix = prefix.trim();
  const cleanRoute = route.trim();
  if (!cleanPrefix || cleanPrefix === "/") {
    return cleanRoute || "/";
  }
  if (!cleanRoute || cleanRoute === "/") {
    return cleanPrefix.startsWith("/") ? cleanPrefix : `/${cleanPrefix}`;
  }
  return `${cleanPrefix.replace(/\/+$/, "")}/${cleanRoute.replace(/^\/+/, "")}`;
}

function inferredStaticRouteMethod(route: string): "GET" | "POST" {
  const lowerRoute = route.toLowerCase();
  if (/\/(?:predict|prediction|infer|inference|classify|score|evaluate|backtest|feedback|retraining)(?:\/|$)/.test(lowerRoute)) {
    return "POST";
  }
  return "GET";
}

function pythonRouteMethods(routeArgs: string): string[] {
  const methodsMatch = /\bmethods\s*=\s*\[([^\]]+)\]/.exec(routeArgs) ?? /\bmethods\s*=\s*\(([^)]*)\)/.exec(routeArgs) ?? /\bmethods\s*=\s*\{([^}]*)\}/.exec(routeArgs);
  if (!methodsMatch) {
    return ["GET"];
  }
  const methods = [...(methodsMatch[1] ?? "").matchAll(/["']([A-Za-z]+)["']/g)]
    .map((match) => (match[1] ?? "").toUpperCase())
    .filter((method) => ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method));
  return methods.length ? [...new Set(methods)] : ["GET"];
}

export function uniqueObservedEndpoints(endpoints: string[]): string[] {
  return [...new Set(endpoints.filter((endpoint) => /^[A-Z]+ \/[^\s]*$/.test(endpoint)))].slice(0, 100);
}
