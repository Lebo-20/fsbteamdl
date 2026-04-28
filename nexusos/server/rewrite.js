const fs = require('fs');
let file = fs.readFileSync('c:/BOT TEAM DL/fsub_bot/nexusos/server/src/server.ts', 'utf8');

const startTag = '// --- GoodShort Routes ---';
const endTag = '// --- DramaWave Routes ---';

const start = file.indexOf(startTag);
const end = file.indexOf(endTag);

if (start === -1 || end === -1) {
  console.log('Could not find start or end tags.');
  process.exit(1);
}

const newGoodShortCode = `// --- GoodShort Routes ---
const goodshortBase = process.env.GOODSHORT_BASE_URL || 'https://goodshort.dramabos.my.id';
const goodshortToken = process.env.GOODSHORT_TOKEN || 'A8D6AB170F7B89F2182561D3B32F390D';

const gsCache = {
  videoKey: null as string | null,
  bookName: '',
  episodes: {} as Record<string, string>,
  lastFetch: {} as Record<string, number>
};
const CACHE_TTL = 24 * 60 * 60 * 1000;

async function fetchGoodshortBook(bookId: string, lang: string) {
  const now = Date.now();
  if (gsCache.lastFetch[bookId] && now - gsCache.lastFetch[bookId] < CACHE_TTL) return true;

  try {
    const url = \`\${goodshortBase}/rawurl/\${bookId}?lang=\${lang}&q=720p&code=\${goodshortToken}\`;
    const res = await axios.get(url, { timeout: 15000 });
    const data = res.data?.data;
    if (!data) return false;

    gsCache.videoKey = data.videoKey;
    gsCache.bookName = data.bookName || '';

    for (const ep of (data.episodes || [])) {
      if (ep.m3u8) gsCache.episodes[ep.id] = ep.m3u8;
    }

    gsCache.lastFetch[bookId] = now;
    console.log(\`[GoodShort Proxy] Loaded \${gsCache.bookName} — \${data.totalEpisode} eps, key: \${gsCache.videoKey?.slice(0,8)}...\`);
    return true;
  } catch (e: any) {
    console.error('[GoodShort Proxy] rawurl Error:', e.message);
    return false;
  }
}

app.get('/api/goodshort/home', async (req, res) => {
  const { page = 1, lang = 'in' } = req.query;
  const cacheKey = \`goodshort_home_\${page}_\${lang}\`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await axios.get(\`\${goodshortBase}/home\`, {
      params: { lang, channel: -1, page, size: 20 }
    });
    const blocks = response.data?.data?.records || [];
    let list: any[] = [];
    for (const b of blocks) {
      if (Array.isArray(b.items)) list = list.concat(b.items);
    }
    const mapped = list.map((d: any) => ({
      id: d.bookId,
      title: d.bookName,
      poster: d.coverWap || d.coverPlays || d.cover,
      episodes: d.chapterCount || d.totalChapter || d.lastChapterId || 0,
      likes: d.viewCount || d.likeNum || '0',
      platform: 'GOODSHORT'
    }));
    const result = { dramas: mapped, platform: 'GOODSHORT' };
    setCache(cacheKey, result);
    res.json(result);
  } catch (error: any) {
    console.error('GoodShort Home error:', error.message);
    res.json({ dramas: [], platform: 'GOODSHORT', error: error.message });
  }
});

app.get('/api/goodshort/search', async (req, res) => {
  const { q = '', lang = 'in', page = 1 } = req.query;
  const cacheKey = \`goodshort_search_\${q}_\${page}_\${lang}\`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await axios.get(\`\${goodshortBase}/search\`, {
      params: { lang, q, page, size: 15, code: goodshortToken }
    });
    const list = response.data?.data?.searchResult?.records || response.data?.data?.list || [];
    const mapped = list.map((d: any) => ({
      id: d.bookId,
      title: d.bookName,
      poster: d.coverWap || d.coverPlays || d.cover,
      episodes: d.chapterCount || d.totalChapter || d.lastChapterId || 0,
      likes: d.viewCount || d.likeNum || '0',
      platform: 'GOODSHORT'
    }));
    const result = { dramas: mapped, platform: 'GOODSHORT' };
    setCache(cacheKey, result);
    res.json(result);
  } catch (error: any) {
    console.error('GoodShort Search error:', error.message);
    res.json({ dramas: [], platform: 'GOODSHORT', error: error.message });
  }
});

app.get('/api/goodshort/episodes/:id', async (req, res) => {
  const { id } = req.params;
  const { lang = 'in' } = req.query;
  try {
    const response = await axios.get(\`\${goodshortBase}/chapters/\${id}\`, {
      params: { lang, code: goodshortToken }
    });
    const data = response.data?.data;
    const chapters = data?.chapterList || data?.list || data || [];
    
    if (!Array.isArray(chapters) || chapters.length === 0) {
      return res.json({ data: { list: [], series: {} }, platform: 'GOODSHORT' });
    }
    
    const list = chapters.map((c: any) => ({
      id: c.chapterId || c.id,
      number: parseInt(c.chapterId || c.id),
      title: c.chapterName || c.name || \`Episode \${c.chapterId || c.id}\`
    }));
    
    const series = { id, title: '', poster: '', episodes: list.length };
    res.json({ data: { list, series }, platform: 'GOODSHORT' });
  } catch (error: any) {
    console.error('GoodShort Episodes error:', error.message);
    res.json({ data: { list: [], series: {} }, platform: 'GOODSHORT', error: error.message });
  }
});

app.get('/api/goodshort/stream/:id/:ep', async (req, res) => {
  const { id, ep } = req.params;
  try {
    const reqHost = req.get('host');
    const proxyM3u8Url = \`http://\${reqHost}/api/goodshort/proxy/m3u8/\${ep}?bookId=\${id}\`;
    res.json({ data: { url: proxyM3u8Url }, platform: 'GOODSHORT' });
  } catch (error: any) {
    console.error('GoodShort Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'GOODSHORT', error: error.message });
  }
});

app.get('/api/goodshort/subtitle/:id/:ep', async (req, res) => {
  res.json({ data: { list: [] }, platform: 'GOODSHORT' });
});

app.get('/api/goodshort/proxy/m3u8/:chapterId', async (req, res) => {
  const chapterId = req.params.chapterId;
  const bookId = req.query.bookId as string;
  const lang = (req.query.lang as string) || 'in';

  if (!gsCache.episodes[chapterId] && bookId) {
    const ok = await fetchGoodshortBook(bookId, lang);
    if (!ok) return res.status(500).send('Failed to fetch book data');
  }

  const m3u8Url = gsCache.episodes[chapterId];
  if (!m3u8Url) return res.status(404).send('Episode not found.');

  try {
    const r = await axios.get(m3u8Url, {
      headers: { 'User-Agent': 'okhttp/4.10.0' },
      timeout: 10000,
      responseType: 'text',
    });

    const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/'));
    let content = r.data;

    if (gsCache.videoKey) {
      content = content.replace(
        /URI="local:\\/\\/[^"]*"/g,
        \`URI="data:text/plain;base64,\${gsCache.videoKey}"\`
      );
    }

    const reqHost = req.get('host');
    const lines = content.split('\\n').map((line: string) => {
      const stripped = line.trim();
      if (stripped && !stripped.startsWith('#') && stripped.endsWith('.ts')) {
        const tsUrl = baseUrl + '/' + stripped;
        return \`http://\${reqHost}/api/goodshort/proxy/ts?url=\${encodeURIComponent(tsUrl)}\`;
      }
      return line;
    });

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(lines.join('\\n'));
  } catch (e: any) {
    console.error('[GoodShort Proxy m3u8] Error:', e.message);
    res.status(502).send('Failed to fetch m3u8 from CDN');
  }
});

app.get('/api/goodshort/proxy/ts', async (req, res) => {
  const tsUrl = req.query.url as string;
  if (!tsUrl) return res.status(400).send('Missing url parameter');

  try {
    const r = await axios.get(tsUrl, {
      headers: { 'User-Agent': 'okhttp/4.10.0' },
      responseType: 'stream',
      timeout: 15000,
    });

    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Access-Control-Allow-Origin', '*');
    r.data.pipe(res);
  } catch (e: any) {
    console.error('[GoodShort Proxy ts] Error:', e.message);
    res.status(502).send('Failed to fetch segment');
  }
});

`;

file = file.substring(0, start) + newGoodShortCode + file.substring(end);
fs.writeFileSync('c:/BOT TEAM DL/fsub_bot/nexusos/server/src/server.ts', file);
console.log('Successfully replaced GoodShort routes.');
