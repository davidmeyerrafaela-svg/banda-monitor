/**
 * api/news.js — Vercel Serverless Function
 * Obtiene noticias económicas argentinas de feeds RSS
 * Endpoint: GET /api/news
 */

const https = require('https');
const http = require('http');

// RSS feeds de fuentes económicas argentinas
const RSS_FEEDS = [
  'https://www.ambito.com/feed/economia',
  'https://www.infobae.com/feeds/rss/',
  'https://www.cronista.com/feed/',
  'https://www.lanacion.com.ar/economia/rss.xml'
];

// Parsear RSS simple (sin dependencias)
function parseRSSItems(xml) {
  const items = [];
  // Regex para extraer items <item>...</item>
  const itemRegex = /<item[^>]*>[\s\S]*?<\/item>/g;
  const matches = xml.match(itemRegex) || [];

  matches.forEach((itemXml) => {
    try {
      const title = extractTag(itemXml, 'title');
      const link = extractTag(itemXml, 'link');
      const pubDate = extractTag(itemXml, 'pubDate');
      const summary = extractTag(itemXml, 'description');
      const source = extractTag(itemXml, 'source');

      if (title) {
        items.push({
          title: htmlDecode(title),
          link,
          pubDate,
          summary: htmlDecode(summary || '').substring(0, 200),
          source: source || extractSource(link)
        });
      }
    } catch (e) {
      // Ignorar items que no parsean bien
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
  const entities = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#039;': "'",
    '&apos;': "'"
  };
  return text.replace(/&[a-z]+;/gi, (m) => entities[m] || m)
    .replace(/<[^>]*>/g, ''); // Remover tags HTML
}

function extractSource(url) {
  if (!url) return 'Fuente Económica';
  if (url.includes('infobae')) return 'Infobea';
  if (url.includes('ambito')) return 'Ámbito Financiero';
  if (url.includes('cronista')) return 'El Cronista';
  if (url.includes('lanacion')) return 'La Nación';
  return 'Fuente Económica';
}

// Fetch de un feed RSS
async function fetchFeed(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const request = protocol.get(url, { timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const items = parseRSSItems(data);
          resolve(items);
        } catch (e) {
          resolve([]);
        }
      });
    });
    request.on('error', () => resolve([]));
    request.on('timeout', () => {
      request.destroy();
      resolve([]);
    });
  });
}

// Handler principal
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'max-age=3600'); // Cache por 1 hora

  try {
    // Fetch todos los feeds en paralelo (con timeout)
    const promises = RSS_FEEDS.map((feed) =>
      Promise.race([
        fetchFeed(feed),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 10000)
        )
      ]).catch(() => [])
    );

    const results = await Promise.all(promises);
    const allItems = results.flat();

    // Filtrar duplicados por título
    const seen = new Set();
    const unique = allItems.filter((item) => {
      if (seen.has(item.title)) return false;
      seen.add(item.title);
      return true;
    });

    // Ordenar por fecha (más recientes primero)
    unique.sort((a, b) => {
      const dateA = new Date(a.pubDate || 0).getTime();
      const dateB = new Date(b.pubDate || 0).getTime();
      return dateB - dateA;
    });

    res.status(200).json({
      success: true,
      results: unique.slice(0, 50), // Máximo 50 noticias
      count: unique.length,
      fetchedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[News API] Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      results: [],
      fetchedAt: new Date().toISOString()
    });
  }
};
