"""
server_py.py — Proxy HTTP en Python puro (sin dependencias externas)
Equivalente funcional de server.js para entornos sin Node.js.

Uso: python3 server_py.py
Luego abrir: http://localhost:3000
"""

import json
import os
import re
import ssl
import sys
import threading
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime
from datetime import timezone
from socketserver import ThreadingMixIn
from http.server import HTTPServer, SimpleHTTPRequestHandler

PORT = 3000

# ── Feeds de noticias RSS ─────────────────────────────────────────────────

NEWS_FEEDS = [
    {"name": "Ámbito Economía",    "url": "https://www.ambito.com/rss/economia.xml"},
    {"name": "Infobae Economía",   "url": "https://www.infobae.com/economia/rss/"},
    {"name": "La Nación Economía", "url": "https://www.lanacion.com.ar/rss/economia.xml"},
    {"name": "El Cronista",        "url": "https://www.cronista.com/rss/finanzas-mercados.xml"},
    {"name": "iProfesional",       "url": "https://www.iprofesional.com/rss/finanzas.xml"},
]

# SSL context que acepta certificados (algunos feeds tienen certs problemáticos)
SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode    = ssl.CERT_NONE

def fetch_url(url, timeout=12):
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "TetraPak-Monitor/1.0", "Accept": "*/*"}
    )
    with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
        return r.read()

# ── Parseo RSS ────────────────────────────────────────────────────────────

def strip_tags(text):
    return re.sub(r"<[^>]+>", "", text or "").strip()

def parse_rss(xml_bytes, source_name):
    items = []
    try:
        root = ET.fromstring(xml_bytes)
        ns   = {"atom": "http://www.w3.org/2005/Atom"}

        # RSS 2.0
        for item in root.iter("item"):
            t = item.findtext("title",       default="")
            l = item.findtext("link",        default="")
            d = item.findtext("pubDate",     default="")
            s = item.findtext("description", default="")
            if not t:
                continue
            items.append({
                "source":  source_name,
                "title":   strip_tags(t)[:300],
                "link":    strip_tags(l),
                "pubDate": strip_tags(d),
                "summary": strip_tags(s)[:400],
            })

        # Atom
        if not items:
            for entry in root.findall("atom:entry", ns):
                t = entry.findtext("atom:title",   default="", namespaces=ns)
                d = entry.findtext("atom:updated",  default="", namespaces=ns)
                s = entry.findtext("atom:summary",  default="", namespaces=ns)
                link_el = entry.find("atom:link", ns)
                l = link_el.get("href", "") if link_el is not None else ""
                if not t:
                    continue
                items.append({
                    "source":  source_name,
                    "title":   strip_tags(t)[:300],
                    "link":    l,
                    "pubDate": strip_tags(d),
                    "summary": strip_tags(s)[:400],
                })
    except Exception as e:
        print(f"[RSS parse error {source_name}]: {e}")
    return items[:20]

# ── Handler HTTP ──────────────────────────────────────────────────────────

class ProxyHandler(SimpleHTTPRequestHandler):
    """Sirve archivos estáticos y proxea las rutas /api/*."""

    # Silenciar logs de acceso verbose
    def log_message(self, fmt, *args):
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {fmt % args}")

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]   # ignorar query string

        if path == "/api/bcra/local":
            self.handle_bcra_local()
        elif path == "/api/bcra/refresh":
            self.handle_bcra_refresh()
        elif path.startswith("/api/bcra/variables"):
            self.handle_bcra_variables()
        elif path.startswith("/api/bcra/serie/"):
            self.handle_bcra_serie(path)
        elif path == "/api/news":
            self.handle_news()
        else:
            # Archivos estáticos — SimpleHTTPRequestHandler los sirve
            super().do_GET()

    # ── BCRA: datos locales (archivo JSON cacheado) ───────────────────────

    def handle_bcra_local(self):
        """Sirve el archivo data/bcra_a3500.json generado por fetch_data.py."""
        local_file = os.path.join(os.path.dirname(__file__), "data", "bcra_a3500.json")
        if not os.path.exists(local_file):
            self.send_json({"error": "Archivo local no encontrado. Ejecutar: python3 fetch_data.py"}, 404)
            return
        with open(local_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        mtime = datetime.fromtimestamp(os.stat(local_file).st_mtime, tz=timezone.utc).isoformat()
        print(f"  Sirviendo cache local: {len(data)} registros")
        self.send_json({"results": data, "count": len(data), "lastModified": mtime})

    def handle_bcra_refresh(self):
        """Actualiza el cache local con dias faltantes desde la API del BCRA."""
        import subprocess, sys
        script = os.path.join(os.path.dirname(__file__), "fetch_data.py")
        print("  Ejecutando actualizacion incremental...")
        try:
            result = subprocess.run(
                [sys.executable, script, "--update"],
                capture_output=True, text=True, timeout=120
            )
            local_file = os.path.join(os.path.dirname(__file__), "data", "bcra_a3500.json")
            count = 0
            if os.path.exists(local_file):
                with open(local_file) as f:
                    count = len(json.load(f))
            self.send_json({"ok": True, "stdout": result.stdout, "count": count})
        except Exception as e:
            self.send_json({"ok": False, "error": str(e)}, 500)

    # ── BCRA: lista de variables ──────────────────────────────────────────

    def handle_bcra_variables(self):
        url = "https://api.bcra.gob.ar/estadisticas/v2.0/principalesvariables"
        print(f"  → BCRA variables: {url}")
        try:
            data = json.loads(fetch_url(url))
            self.send_json(data)
        except Exception as e:
            print(f"  ✗ Error: {e}")
            self.send_json({"error": str(e)}, 502)

    # ── BCRA: serie histórica ─────────────────────────────────────────────
    # Ruta: /api/bcra/serie/{idVariable}/{fechaDesde}/{fechaHasta}

    def handle_bcra_serie(self, path):
        m = re.match(r"/api/bcra/serie/(\d+)/(\d{4}-\d{2}-\d{2})/(\d{4}-\d{2}-\d{2})", path)
        if not m:
            self.send_json({"error": "Ruta inválida. Usar /api/bcra/serie/{id}/{YYYY-MM-DD}/{YYYY-MM-DD}"}, 400)
            return

        var_id, desde, hasta = m.group(1), m.group(2), m.group(3)
        url = f"https://api.bcra.gob.ar/estadisticas/v2.0/datosVariable/{var_id}/{desde}/{hasta}"
        print(f"  → BCRA serie {var_id}: {desde} → {hasta}")

        try:
            raw  = fetch_url(url, timeout=20)
            data = json.loads(raw)
            print(f"  ✓ {len(data.get('results', []))} registros")
            self.send_json(data)
        except Exception as e:
            print(f"  ✗ Error BCRA: {e}")
            self.send_json({"error": str(e)}, 502)

    # ── Noticias RSS ──────────────────────────────────────────────────────

    def handle_news(self):
        print("  → Fetching noticias RSS...")
        all_items = []
        for feed in NEWS_FEEDS:
            try:
                xml_bytes = fetch_url(feed["url"], timeout=8)
                items     = parse_rss(xml_bytes, feed["name"])
                all_items.extend(items)
                print(f"  ✓ {feed['name']}: {len(items)} items")
            except Exception as e:
                print(f"  ✗ {feed['name']}: {e}")

        self.send_json({
            "results":   all_items,
            "fetchedAt": datetime.now(timezone.utc).isoformat()
        })

# ── Main ──────────────────────────────────────────────────────────────────

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """Servidor HTTP con soporte multi-hilo para peticiones concurrentes."""
    daemon_threads = True

if __name__ == "__main__":
    # Cambiar al directorio del script para que los estáticos se sirvan bien
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    server = ThreadedHTTPServer(("0.0.0.0", PORT), ProxyHandler)
    print("=" * 55)
    print(f"  Tetra Pak Band Monitor — servidor Python")
    print(f"  http://localhost:{PORT}")
    print(f"  Ctrl+C para detener")
    print("=" * 55)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
        sys.exit(0)
