const CATEGORIES = ['browser', 'bot', 'automated', 'suspicious', 'unknown'];
const SCANNERS = /sqlmap|nikto|nuclei|masscan|zgrab|acunetix|netsparker|nessus/i;
const BOTS = /googlebot|bingbot|duckduckbot|yandexbot|baiduspider|applebot|semrushbot|ahrefsbot|petalbot|mj12bot|dotbot|bytespider|gptbot|chatgpt-user|oai-searchbot|claudebot|claude-user|ccbot|facebookexternalhit|twitterbot|telegrambot|discordbot|whatsapp|linkedinbot|slackbot|crawler|spider|\bbot\b/i;
const AUTOMATION = /curl\b|wget\b|python[- /]|python-requests|httpx|aiohttp|go-http-client|postman|insomnia|java\b|httpclient|libwww|node\b|undici|headlesschrome|playwright|puppeteer|phantomjs|selenium|uptimerobot|pingdom|statuscake/i;
const BROWSER = /(?:Chrome|Firefox|Safari|Edg|OPR|Opera)\/[\d.]+/i;

function decodedPath(value) {
  let result = String(value || '/').split('?')[0].split('#')[0];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const decoded = decodeURIComponent(result);
      if (decoded === result) break;
      result = decoded;
    } catch (_) { break; }
  }
  return result.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 500);
}

function loggedPath(value) {
  return decodedPath(value)
    .replace(/(\/download\/)[^/]+/gi, '$1[token]')
    .replace(/(\/(?:api|admin)\/works\/|\/admin\/(?:files|categories)\/)\d+/gi, '$1[id]');
}

function requestType(pathname) {
  if (pathname === '/') return 'page';
  if (pathname.startsWith('/download/')) return 'download';
  if (pathname.startsWith('/api/')) return 'api';
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return 'admin';
  if (/^\/(css|js|vendor|covers)\//.test(pathname) || pathname === '/favicon.svg') return 'asset';
  return 'other';
}

function classify(event, activity = {}) {
  const path = decodedPath(event.path);
  const agent = event.userAgent || '';
  if (/(^|\/)\.{1,2}(?:\/|$)|(?:^|\/)(?:\.env(?:\.|\/|$)|\.git(?:\/|$)|wp-admin(?:\/|$)|wp-login\.php|xmlrpc\.php|phpmyadmin(?:\/|$)|cgi-bin(?:\/|$)|actuator(?:\/|$)|vendor\/phpunit)/i.test(path)) {
    return { category: 'suspicious', reason: 'Solicitud a una ruta privada, de otro CMS o de exploración de vulnerabilidades' };
  }
  if (SCANNERS.test(agent)) return { category: 'suspicious', reason: 'User-Agent declarado de una herramienta de escaneo' };
  if (event.status === 429) return { category: 'suspicious', reason: 'Se alcanzó un límite de solicitudes o de intentos de acceso' };
  if (activity.requests >= 120) return { category: 'suspicious', reason: 'Al menos 120 solicitudes desde esta IP en un minuto' };
  if (activity.failedLogins >= 5) return { category: 'suspicious', reason: 'Al menos 5 intentos de acceso fallidos desde esta IP en un minuto' };
  if (activity.notFound >= 15) return { category: 'suspicious', reason: 'Al menos 15 rutas no encontradas desde esta IP en un minuto' };
  if (['TRACE', 'CONNECT'].includes(event.method)) return { category: 'suspicious', reason: 'Método HTTP no utilizado por la biblioteca' };
  if (BOTS.test(agent)) return { category: 'bot', reason: 'El User-Agent declara un bot o rastreador; identidad no verificada' };
  if (AUTOMATION.test(agent)) return { category: 'automated', reason: 'User-Agent asociado a una herramienta HTTP, monitor o navegador automatizado' };
  if (BROWSER.test(agent) && (event.jsConfirmed || event.fetchMode || event.fetchDest || /text\/html/i.test(event.accept || ''))) {
    return {
      category: 'browser',
      reason: event.jsConfirmed ? 'Navegador con señal JavaScript vinculada a esta página; no acredita una persona' : 'User-Agent de navegador y cabeceras compatibles; estimación sin señal JavaScript'
    };
  }
  return { category: 'unknown', reason: agent ? 'Información insuficiente para estimar el origen del tráfico' : 'Solicitud sin User-Agent; no se presupone que sea un bot' };
}

module.exports = { CATEGORIES, classify, decodedPath, loggedPath, requestType };
