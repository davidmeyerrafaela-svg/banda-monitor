"""
fetch_news.py — Obtiene noticias de RSS feeds y genera JSON
Se ejecuta diariamente via GitHub Actions
"""

import json
import re
import urllib.request
import urllib.error
from datetime import datetime
import os

RSS_FEEDS = [
    'https://feeds.bloomberg.com/markets/news.rss',
    'https://feeds.finance.yahoo.com/rss/2.0/headline',
]

def extract_tag(xml, tag):
    """Extrae contenido de una tag XML"""
    regex = f'<{tag}[^>]*>([\\s\\S]*?)</{tag}>'
    match = re.search(regex, xml, re.IGNORECASE)
    return match.group(1).strip() if match else ''

def html_decode(text):
    """Decodifica entidades HTML"""
    entities = {
        '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#039;': "'"
    }
    for ent, char in entities.items():
        text = text.replace(ent, char)
    text = re.sub(r'<[^>]*>', '', text)
    return text

def extract_source(url):
    """Extrae nombre de la fuente"""
    if not url:
        return 'Fuente Económica'
    if 'infobae' in url:
        return 'Infobae'
    if 'ambito' in url:
        return 'Ámbito Financiero'
    if 'cronista' in url:
        return 'El Cronista'
    return 'Fuente Económica'

def parse_rss(xml):
    """Parsea items de un feed RSS"""
    items = []
    item_regex = r'<item[^>]*>[\s\S]*?<\/item>'
    matches = re.findall(item_regex, xml)

    for item_xml in matches[:25]:
        try:
            title = extract_tag(item_xml, 'title')
            link = extract_tag(item_xml, 'link')
            pubdate = extract_tag(item_xml, 'pubDate')
            desc = extract_tag(item_xml, 'description')

            if title and len(title) > 10:
                items.append({
                    'title': html_decode(title),
                    'link': link or '#',
                    'pubDate': pubdate or datetime.now().isoformat(),
                    'summary': html_decode(desc or '')[:250],
                    'source': extract_source(link)
                })
        except Exception as e:
            print(f"[Error parsing item] {e}", flush=True)

    return items

def fetch_feed(url):
    """Obtiene un feed RSS"""
    try:
        req = urllib.request.Request(
            url,
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
        )
        with urllib.request.urlopen(req, timeout=8) as response:
            xml = response.read().decode('utf-8', errors='ignore')
            return parse_rss(xml)
    except Exception as e:
        print(f"[Error fetching {url}] {e}", flush=True)
        return []

def main():
    print(f"[fetch_news.py] Iniciando obtención de noticias a las {datetime.now()}", flush=True)

    all_items = []
    for feed in RSS_FEEDS:
        print(f"  Obteniendo: {feed}", flush=True)
        items = fetch_feed(feed)
        all_items.extend(items)
        print(f"    -> {len(items)} items obtenidos", flush=True)

    # Remover duplicados
    seen = set()
    unique = []
    for item in all_items:
        if item['title'] not in seen:
            seen.add(item['title'])
            unique.append(item)

    # Ordenar por fecha (más recientes primero)
    unique.sort(
        key=lambda x: datetime.fromisoformat(x['pubDate'].replace('Z', '+00:00')),
        reverse=True
    )

    # Guardar
    output = {
        'success': True,
        'results': unique[:50],
        'count': len(unique),
        'fetchedAt': datetime.now().isoformat()
    }

    output_path = os.path.join(os.path.dirname(__file__), 'data', 'news.json')
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"[fetch_news.py] Completado: {len(unique)} noticias únicas guardadas en {output_path}", flush=True)

if __name__ == '__main__':
    main()
