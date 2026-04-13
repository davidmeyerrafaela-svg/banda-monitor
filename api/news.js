/**
 * api/news.js — Vercel Serverless Function
 * Obtiene noticias económicas argentinas de feeds RSS
 * Endpoint: GET /api/news
 */

const RSS_FEEDS = [
  'https://www.infobae.com/feeds/rss/',
  'https://www.ambito.com/feed/economia',
];

// Parsear RSS simple
function parseRSSItems(xml) {
  const items = [];
  const itemRegex = /<item[^>]*>[\s\S]*?<\/item>/g;
  const matches = xml.match(itemRegex) || [];

  matches.slice(0, 25).forEach((itemXml) => {
    try {
      const title = extractTag(itemXml, 'title');
      const link = extractTag(itemXml, 'link');
      const pubDate = extractTag(itemXml, 'pubDate');
      const desc = extractTag(itemXml, 'description');

      if (title && title.length > 10) {
        items.push({
          title: htmlDecode(title),
          link: link || '#',
          pubDate: pubDate || new Date().toISOString(),
          summary: htmlDecode(desc || '').substring(0, 250),
          source: extractSource(link)
        });
      }
    } catch (e) {
      // Skip
    }
  });

  return items;
}

function extractTag(xml, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : '';
}

function htmlDecode(text) {
  const map = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#039;': "'"
  };
  return text.replace(/&[a-z]+;/gi, (m) => map[m] || m).replace(/<[^>]*>/g, '');
}

function extractSource(url) {
  if (!url) return 'Fuente';
  if (url.includes('infobae')) return 'Infobae';
  if (url.includes('ambito')) return 'Ámbito';
  if (url.includes('cronista')) return 'Cronista';
  return 'Fuente Económica';
}

async function fetchFeed(url) {
  try {
    const res = await fetch(url, {
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) return [];
    const text = await res.text();
    return parseRSSItems(text);
  } catch (e) {
    console.error(`[RSS] Error fetching ${url}:`, e.message);
    return [];
  }
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'max-age=1800');

  try {
    const results = await Promise.all(
      RSS_FEEDS.map(feed => fetchFeed(feed))
    );

    const allItems = results.flat();
    const seen = new Set();
    const unique = allItems.filter(item => {
      if (seen.has(item.title)) return false;
      seen.add(item.title);
      return true;
    });

    unique.sort((a, b) =>
      new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime()
    );

    res.status(200).json({
      success: true,
      results: unique.slice(0, 30),
      count: unique.length,
      fetchedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[News API]', error);
    res.status(500).json({
      success: false,
      error: error.message,
      results: [],
      fetchedAt: new Date().toISOString()
    });
  }
};
