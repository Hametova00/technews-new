"use strict";
/*
  TechStream — сервер новостей (без зависимостей, нужен Node.js 18+).
  Запуск:  node server.js   →  откройте http://localhost:3000

  Что делает:
  1. Скачивает RSS/Atom-ленты (Habr, TechCrunch, The Verge, Ars Technica, Hacker News, Reddit…).
  2. Оставляет материалы за последние DAYS дней.
  3. Берёт настоящую картинку статьи (из ленты, из текста или из og:image страницы).
  4. Берёт фрагмент текста оригинала (не весь текст, а начало) и ссылку на источник.
  5. Определяет категорию по ключевым словам.
  6. Отдаёт всё странице по адресу /api/news (кэш 10 минут).
*/
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");

const PORT = +process.env.PORT || 3000;
const DAYS = 14;               // за сколько дней показывать новости
const TTL = 10 * 60 * 1000;    // как долго хранить результат в памяти
const PER_SOURCE = 40;         // не больше N свежих материалов с одного источника
const ENRICH_MAX = 80;         // сколько страниц открывать за картинкой/описанием
const MIN_SCORE = 3;           // порог «технологичности»: чем выше, тем строже отбор
const CACHE_FILE = path.join(__dirname, "news-cache.json");   // временное хранилище новостей (JSON)
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 TechStream/1.0";

const DEFAULT_FEEDS = [
  { id: "habr",  name: "Habr",            url: "https://habr.com/ru/rss/all/all/", kind: "rss" },
  { id: "tc",    name: "TechCrunch",      url: "https://techcrunch.com/feed/", kind: "rss" },
  { id: "verge", name: "The Verge",       url: "https://www.theverge.com/rss/index.xml", kind: "rss" },
  { id: "ars",   name: "Ars Technica",    url: "https://feeds.arstechnica.com/arstechnica/index", kind: "rss" },
  { id: "hn",    name: "Hacker News",     url: "https://hnrss.org/frontpage?points=100", kind: "discussion" },
  { id: "rtech", name: "Reddit r/technology",  url: "https://www.reddit.com/r/technology/top/.rss?t=week", kind: "discussion" },
  { id: "rprog", name: "Reddit r/programming", url: "https://www.reddit.com/r/programming/top/.rss?t=week", kind: "discussion" },
  { id: "rai",   name: "Reddit r/artificial",  url: "https://www.reddit.com/r/artificial/top/.rss?t=week", kind: "discussion" }
];

/* ---------- категории по ключевым словам ---------- */
const CAT_RULES = [
  ["Crypto",   /\b(bitcoin|btc|ethereum|crypto\w*|blockchain|stablecoin|nft|binance|coinbase)\b|биткоин|крипт|блокчейн/gi],
  ["Security", /\b(cyber\w*|infosec|information security|vulnerabilit\w*|exploit\w*|malware|ransomware|breach\w*|hack\w*|phishing|cve-\d+|zero-day|encryption|vpn|cyberattack)\b|уязвим|взлом|фишинг|кибер|утечк|шифрован/gi],
  ["Gaming",   /\b(game|games|gaming|gamer|playstation|xbox|nintendo|steam|console|esports)\b|игр[аыуо]|консол/gi],
  ["Science",  /\b(nasa|space|telescope|quantum|physics|astronom\w*|mars|moon|rocket|spacex|climate|biolog\w*|fusion|scientists?|research(ers)?)\b|космос|квант|астроном|учён|учен/gi],
  ["Mobile",   /\b(iphone|android|smartphones?|pixel|galaxy|ios|ipad|samsung|apple watch|wearable)\b|смартфон|айфон/gi],
  ["AI",       /\b(ai|llms?|gpt|openai|anthropic|claude|gemini|chatgpt|deepmind|copilot|machine learning|neural|generative|agents?)\b|нейро|искусственн|(^|[^а-яё])ии([^а-яё]|$)|языков\S* модел/gi],
  ["Hardware", /\b(chips?|cpu|gpu|nvidia|amd|intel|processors?|semiconductors?|batter(y|ies)|laptops?|raspberry|hardware|ssd|tsmc|robots?)\b|процессор|чип|видеокарт|ноутбук|железо/gi],
  ["Web",      /\b(javascript|typescript|css|html|react|vue|frontend|backend|web|browsers?|chrome|firefox|api|rust|python|golang|programming|developers?|open source|github|linux|kernel|database|devops|software)\b|разработ|программир|фронтенд|браузер/gi]
];
/* Общие «технологические» слова: нужны, чтобы пропустить новости, которые не попали ни в одну категорию выше
   (например, «Instagram добавил функцию»). */
const BROAD = /\b(tech|technology|software|hardware|apps?|startups?|internet|online|digital|cloud|servers?|computers?|computing|devices?|gadgets?|platforms?|algorithms?|automation|drones?|tesla|apple|google|microsoft|amazon|meta|facebook|instagram|whatsapp|telegram|tiktok|youtube|netflix|spotify|windows|macos|ubuntu|github|stack overflow|saas|5g|wi-?fi|bluetooth|usb|firmware|tablets?|headsets?|satellites?|streaming|social media|e-?commerce|fintech|privacy|chatbots?|electric vehicles?)\b|технолог|программ|разработ|софт|приложени|сервер|интернет|компьютер|гаджет|стартап|облачн|робот|цифров|алгоритм|мессенджер|соцсет/gi;
/* Темы, которые явно не про технологии (проверяются только в заголовке). */
const NON_TECH = /\b(elections?|senate|senators?|congress|republicans?|democrats?|trump|biden|putin|zelensky|war|ukraine|gaza|israel|nfl|nba|premier league|world cup|olympics?|celebrity|oscars?|box office|recipes?|horoscope|murder|shooting|stabbing|abortion|immigration|tariffs?|lawmakers?|supreme court|protests?|police|trial|verdict|royal family)\b|выбор(ы|ов)|президент|депутат|войн[аыуе]|футбол|хоккей|убийств|сериал|кинопрокат|гороскоп/i;
const hits = (re, s) => (s.match(re) || []).length;
function analyze(title, body) {
  const b = body.slice(0, 1500);
  let best = "Tech", bestScore = 0, total = 0, inTitle = 0;
  for (const [name, re] of CAT_RULES) {
    const t = hits(re, title), s = 3 * t + Math.min(5, hits(re, b));
    total += s; inTitle += t;
    if (s > bestScore) { bestScore = s; best = name; }
  }
  const bt = hits(BROAD, title);
  const score = total + 3 * bt + Math.min(5, hits(BROAD, b));
  return { category: best, score, titleHits: inTitle + bt };
}
/* Оставляем материал, только если он достаточно «технологический». Если в заголовке есть признак
   политики, спорта и т.п., нужно минимум два технологических слова в заголовке (например, «Trump… AI chips»). */
function isTech(a, title) {
  if (a.score < MIN_SCORE) return false;
  if (NON_TECH.test(title) && a.titleHits < 2) return false;
  return true;
}

/* ---------- мини-парсер XML ---------- */
const dec = s => s
  .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ""; } })
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ""; } })
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const unwrap = s => { const m = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/); return m ? m[1] : dec(s); };
function tag(xml, name) {
  const m = xml.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i"));
  return m ? unwrap(m[1]).trim() : "";
}
function attrs(xml, name) {
  const re = new RegExp("<" + name + "(\\s[^>]*?)?/?>", "gi"), out = []; let m;
  while ((m = re.exec(xml))) {
    const a = {};
    (m[1] || "").replace(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_, k, v1, v2) => { a[k.toLowerCase()] = dec(v1 !== undefined ? v1 : v2); return ""; });
    out.push(a);
  }
  return out;
}
function htmlToText(h) {
  return dec(String(h)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d|blockquote|tr)>/gi, "\n\n")
    .replace(/<[^>]+>/g, ""))
    .replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
const oneLine = s => htmlToText(s).replace(/\s+/g, " ");
function abs(u, base) { try { return new URL(u, base).href; } catch { return ""; } }

/* ---------- картинка из элемента ленты ---------- */
const IMG_EXT = /\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i;
const BAD_IMG = /pixel|spacer|1x1|emoji|feedburner|\/ads?\/|stats?\.|beacon|avatar|logo/i;
function pickImage(item, html, base) {
  for (const a of attrs(item, "media:content")) {
    if (a.url && ((a.type || "").startsWith("image") || a.medium === "image" || IMG_EXT.test(a.url))) return abs(a.url, base);
  }
  for (const a of attrs(item, "media:thumbnail")) if (a.url) return abs(a.url, base);
  for (const a of attrs(item, "enclosure")) if (a.url && ((a.type || "").startsWith("image") || IMG_EXT.test(a.url))) return abs(a.url, base);
  for (const a of attrs(item, "link")) if (a.rel === "enclosure" && a.href && (a.type || "").startsWith("image")) return abs(a.href, base);
  for (const t of html.match(/<img\b[^>]*>/gi) || []) {
    const m = t.match(/\b(?:data-src|src)=["']([^"']+)["']/i);
    if (!m || BAD_IMG.test(m[1])) continue;
    const w = t.match(/\bwidth=["']?(\d+)/i);
    if (w && +w[1] < 80) continue;
    const u = abs(m[1].startsWith("//") ? "https:" + m[1] : m[1], base);
    if (u) return u;
  }
  return "";
}

/* ---------- разбор одного материала ---------- */
function cut(s, n) {
  if (s.length <= n) return s;
  const c = s.slice(0, n), i = Math.max(c.lastIndexOf(". "), c.lastIndexOf("! "), c.lastIndexOf("? "));
  return i > n * 0.5 ? c.slice(0, i + 1) : c.replace(/\s+\S*$/, "") + "…";
}
function cleanText(t, f) {
  t = t.replace(/\s*The post [\s\S]*? appeared first on [\s\S]*$/i, "")
       .replace(/\s*Читать далее\s*$/i, "")
       .replace(/\[(?:…|&#8230;|\.\.\.)\]/g, "…");
  if (f.kind === "discussion") {
    t = t.replace(/submitted by\s+\/u\/\S+/gi, "").replace(/\[(link|comments)\]/gi, "").replace(/\s+\n/g, "\n").trim();
    if (/Article URL:|Comments URL:/i.test(t)) t = "";
  }
  return t.trim();
}
function parseItem(it, f) {
  const title = oneLine(tag(it, "title"));
  let link = tag(it, "link");
  if (!link) {
    const ls = attrs(it, "link");
    const l = ls.find(a => a.href && (!a.rel || a.rel === "alternate")) || ls.find(a => a.href);
    link = l ? l.href : "";
  }
  link = link.trim();
  if (!title || !/^https?:\/\//i.test(link)) return null;
  const ts = Date.parse(tag(it, "pubDate") || tag(it, "dc:date") || tag(it, "published") || tag(it, "updated"));
  if (!ts) return null;
  const html = tag(it, "content:encoded") || tag(it, "content") || tag(it, "description") || tag(it, "summary") || "";
  const text = cleanText(htmlToText(html), f);
  let tags = [
    ...(it.match(/<category(?:\s[^>]*)?>[\s\S]*?<\/category>/gi) || []).map(c => oneLine(unwrap(c.replace(/<\/?category[^>]*>/gi, "")))),
    ...(f.kind === "discussion" ? [] : attrs(it, "category").map(a => a.term).filter(Boolean))
  ];
  tags = [...new Set(tags)].filter(t => t.length >= 2 && t.length <= 24 && t.split(/\s+/).length <= 3 && !/^(uncategorized|news|разное)$/i.test(t)).slice(0, 3);
  return { title, link, ts: Math.min(ts, Date.now()), text, image: pickImage(it, html, link), tags, source: f.id, kind: f.kind || "rss" };
}

/* ---------- загрузка ---------- */
async function fetchFeed(f) {
  const r = await fetch(f.url, {
    headers: { "user-agent": UA, accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*" },
    redirect: "follow", signal: AbortSignal.timeout(12000)
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const xml = await r.text();
  const raw = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  if (!raw.length && !/<(rss|feed|rdf)/i.test(xml)) throw new Error("это не RSS/Atom");
  return raw.map(it => parseItem(it, f)).filter(Boolean);
}

const metaCache = new Map();
async function pageMeta(url) {
  if (metaCache.has(url)) return metaCache.get(url);
  const out = {};
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(6000) });
    if (r.ok && (r.headers.get("content-type") || "").includes("html")) {
      const t = (await r.text()).slice(0, 250000);
      for (const m of t.match(/<meta\b[^>]*>/gi) || []) {
        const k = ((m.match(/(?:property|name)=["']([^"']+)["']/i) || [])[1] || "").toLowerCase();
        const cm = m.match(/content=(?:"([^"]*)"|'([^']*)')/i);
        const c = cm ? (cm[1] !== undefined ? cm[1] : cm[2]) : "";
        if (!k || !c) continue;
        if (!out.image && (k === "og:image" || k === "og:image:secure_url" || k === "twitter:image")) out.image = abs(dec(c), url);
        if (!out.desc && (k === "og:description" || k === "twitter:description" || k === "description")) out.desc = dec(c).trim();
      }
    }
  } catch { /* страница недоступна — не страшно */ }
  metaCache.set(url, out);
  if (metaCache.size > 1500) metaCache.delete(metaCache.keys().next().value);
  return out;
}
async function pool(arr, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < arr.length) { const x = arr[i++]; try { await fn(x); } catch {} } }));
}

const cache = new Map();
async function getNews(feeds) {
  const key = JSON.stringify(feeds.map(f => [f.id, f.url]));
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.data;

  const results = await Promise.allSettled(feeds.map(fetchFeed));
  const errors = [], all = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") all.push(...r.value);
    else errors.push({ id: feeds[i].id, name: feeds[i].name, error: String((r.reason && r.reason.message) || r.reason) });
  });

  const since = Date.now() - DAYS * 864e5, seen = new Set(), cnt = {};
  const list = all
    .filter(x => x.ts >= since && !seen.has(x.link) && seen.add(x.link))
    .sort((a, b) => b.ts - a.ts)
    .filter(x => (cnt[x.source] = (cnt[x.source] || 0) + 1) <= PER_SOURCE)
    .slice(0, 160);

  if (!list.length) {                          // все источники упали — показываем прошлый результат
    if (hit) return hit.data;
    try { const old = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); old.errors = errors; old.stale = true; return old; } catch {}
  }

  const need = list.filter(x => (!x.image || x.text.length < 200) && !/(^|\.)reddit\.com$/i.test(new URL(x.link).hostname)).slice(0, ENRICH_MAX);
  await pool(need, 8, async x => {
    const m = await pageMeta(x.link);
    if (!x.image && m.image) x.image = m.image;
    if (x.text.length < 200 && m.desc && m.desc.length > x.text.length) x.text = m.desc;
  });

  const items = list.map(x => {
    const a = analyze(x.title, x.text);
    if (!isTech(a, x.title)) return null;      // не про технологии — пропускаем
    const paras = x.text.split(/\n{2,}/).map(p => p.replace(/\s+/g, " ").trim()).filter(Boolean);
    let content = "", total = 0;
    for (const p of paras) {
      if (total >= 900) break;
      const part = cut(p, 900 - total + 120);
      content += (content ? "\n\n" : "") + part; total += part.length;
    }
    const category = a.category;
    return {
      id: "n" + crypto.createHash("sha1").update(x.link).digest("hex").slice(0, 10),
      title: x.title,
      summary: cut(paras[0] || "", 220) || (x.kind === "discussion" ? "Обсуждение в сообществе — откройте оригинал." : ""),
      content: content || "Текст доступен на сайте источника.",
      link: x.link, source: x.source, category,
      tags: x.tags.length ? x.tags : [category],
      publishedAt: new Date(x.ts).toISOString(),
      image: x.image || "", kind: x.kind, real: true
    };
  }).filter(Boolean);

  const data = { items, errors, fetchedAt: new Date().toISOString(), days: DAYS };
  cache.set(key, { t: Date.now(), data });
  if (items.length) fs.writeFile(CACHE_FILE, JSON.stringify(data), () => {});   // временное хранилище: JSON-файл рядом с сервером
  return data;
}

function validFeeds(v) {
  if (!Array.isArray(v)) return null;
  return v.slice(0, 20).filter(f => f && typeof f.url === "string" && /^https?:\/\//i.test(f.url))
    .map(f => ({ id: String(f.id || f.url).slice(0, 40), name: String(f.name || new URL(f.url).hostname).slice(0, 60), url: f.url, kind: f.kind === "discussion" ? "discussion" : "rss" }));
}

/* ---------- HTTP ---------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
function pageFile() {
  const files = fs.readdirSync(__dirname).filter(f => /^(index|technews-new.*)\.html$/i.test(f));
  return files.find(f => /^index\.html$/i.test(f)) || files[0];
}
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/api/news") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    try {
      let feeds = null;
      try { feeds = validFeeds(JSON.parse(u.searchParams.get("feeds") || "null")); } catch {}
      if (u.searchParams.get("refresh")) cache.clear();
      res.end(JSON.stringify(await getNews(feeds || DEFAULT_FEEDS)));
    } catch (e) {
      res.statusCode = 500; res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  let file = u.pathname === "/" ? pageFile() : decodeURIComponent(u.pathname).replace(/^\/+/, "");
  const full = file ? path.join(__dirname, file) : "";
  if (!file || !full.startsWith(__dirname) || /server\.js$/i.test(full) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.statusCode = 404; res.end("Not found"); return;
  }
  res.setHeader("Content-Type", TYPES[path.extname(full).toLowerCase()] || "application/octet-stream");
  fs.createReadStream(full).pipe(res);
}).listen(PORT, "127.0.0.1", () => console.log("TechStream запущен: http://localhost:" + PORT + "  (остановить — Ctrl+C)"));
