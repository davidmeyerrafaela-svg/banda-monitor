"""
fetch_data.py — Descarga histórica del Dólar Referencia COM A 3500
Fuente: BCRA estadisticascambiarias/v1.0/Cotizaciones (codigoMoneda=REF)

Uso:
  python3 fetch_data.py              # Descarga todo (2020-hoy)
  python3 fetch_data.py --update     # Solo agrega días faltantes (incremental)
  python3 fetch_data.py --desde 2024-01-01  # Desde fecha específica

Guarda: data/bcra_a3500.json
"""

import argparse
import json
import os
import ssl
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta

# ── Config ────────────────────────────────────────────────────────────────────

OUTPUT_FILE        = os.path.join(os.path.dirname(__file__), "data", "bcra_a3500.json")
START_DEFAULT      = date(2020, 1, 1)
MAX_WORKERS        = 15       # hilos paralelos (no saturar la API)
RETRY_COUNT        = 3
RETRY_DELAY        = 1.5      # segundos entre reintentos
CODIGO_BNA         = "USD"    # Banco Nacion (fuente oficial Tetra Pak)
CODIGO_REF         = "REF"    # BCRA COM A 3500 (referencia secundaria)

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode    = ssl.CERT_NONE

# ── Fetch una fecha ───────────────────────────────────────────────────────────

def fetch_date(fecha_str: str):
    """
    Descarga el tipo de cambio BNA (Banco Nacion) y referencia BCRA para una fecha.
    Retorna {"date": "YYYY-MM-DD", "value": bna_float, "ref": bcra_float} o None.
    Fuente oficial Tetra Pak: Banco Nacion (USD). BCRA COM A 3500 (REF) como referencia.
    """
    url = f"https://api.bcra.gob.ar/estadisticascambiarias/v1.0/Cotizaciones?fecha={fecha_str}"
    for attempt in range(RETRY_COUNT):
        try:
            req = urllib.request.Request(
                url,
                headers={"Accept": "application/json", "User-Agent": "TetraPak-Monitor/1.0"}
            )
            with urllib.request.urlopen(req, timeout=12, context=SSL_CTX) as r:
                data = json.loads(r.read())

            detalle = data.get("results", {}).get("detalle", [])
            bna_val = None
            ref_val = None
            for item in detalle:
                codigo = item.get("codigoMoneda")
                val    = item.get("tipoCotizacion", 0)
                if codigo == CODIGO_BNA and val and val > 0:
                    bna_val = round(val, 4)
                elif codigo == CODIGO_REF and val and val > 0:
                    ref_val = round(val, 4)

            if bna_val is not None:
                record = {"date": fecha_str, "value": bna_val}
                if ref_val is not None:
                    record["ref"] = ref_val
                return record
            return None  # Fecha sin dato (feriado, fin de semana, etc.)

        except urllib.error.HTTPError as e:
            if e.code == 400:
                return None   # Fecha invalida / sin datos
            if attempt < RETRY_COUNT - 1:
                time.sleep(RETRY_DELAY)
        except Exception:
            if attempt < RETRY_COUNT - 1:
                time.sleep(RETRY_DELAY)
    return None

# ── Generar días hábiles candidatos ──────────────────────────────────────────

def business_days(start: date, end: date):
    """Genera fechas Lun-Vie en el rango (el BCRA filtra feriados internamente)."""
    days = []
    d = start
    while d <= end:
        if d.weekday() < 5:   # 0=Lun, 4=Vie
            days.append(d.strftime("%Y-%m-%d"))
        d += timedelta(days=1)
    return days

# ── Cargar / guardar caché ────────────────────────────────────────────────────

def load_cache():
    if not os.path.exists(OUTPUT_FILE):
        return {}
    with open(OUTPUT_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
    # Soporta formato viejo {date, value} y nuevo {date, value, ref}
    return {item["date"]: item for item in data}

def save_cache(cache: dict):
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    records = sorted(cache.values(), key=lambda x: x["date"])
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)
    return records

# ── Descarga paralela ─────────────────────────────────────────────────────────

def download_dates(dates_to_fetch: list, cache: dict):
    total   = len(dates_to_fetch)
    done    = 0
    fetched = 0

    print(f"Descargando {total} fechas con {MAX_WORKERS} hilos paralelos...")

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(fetch_date, d): d for d in dates_to_fetch}
        for future in as_completed(futures):
            result = future.result()
            done  += 1
            if result:
                cache[result["date"]] = result   # store full record {date, value, ref?}
                fetched += 1
            # Progreso cada 50 fechas
            if done % 50 == 0 or done == total:
                pct = done / total * 100
                bar = "#" * int(pct / 5) + "." * (20 - int(pct / 5))
                print(f"\r  [{bar}] {pct:5.1f}%  ({done}/{total}, {fetched} con dato)", end="", flush=True)

    print()
    return cache

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Descarga histórica USD Mayorista A3500")
    parser.add_argument("--update",  action="store_true", help="Solo actualizar días faltantes")
    parser.add_argument("--desde",   type=str,            help="Fecha inicio YYYY-MM-DD")
    args = parser.parse_args()

    today = date.today()

    # Cargar caché existente
    cache = load_cache()
    print(f"Caché existente: {len(cache)} registros")

    if args.update and cache:
        # Modo incremental: solo fechas posteriores al ultimo dato
        last_date = max(date.fromisoformat(d) for d in cache.keys())
        start     = last_date + timedelta(days=1)
        print(f"Modo incremental: desde {start} hasta {today}")
    else:
        start = date.fromisoformat(args.desde) if args.desde else START_DEFAULT
        print(f"Descarga completa: desde {start} hasta {today}")

    if start > today:
        print("No hay fechas nuevas que descargar.")
        return

    # Generar candidatos
    candidates = business_days(start, today)

    # Filtrar los ya descargados (si aplica)
    if args.update:
        candidates = [d for d in candidates if d not in cache]

    if not candidates:
        print("No hay fechas nuevas que descargar.")
    else:
        t0    = time.time()
        cache = download_dates(candidates, cache)
        elapsed = time.time() - t0
        print(f"Descarga completada en {elapsed:.1f}s")

    # Guardar
    records = save_cache(cache)
    print(f"OK Guardado: {OUTPUT_FILE}")
    print(f"  Total registros: {len(records)}")
    if records:
        print(f"  Rango: {records[0]['date']} -> {records[-1]['date']}")
        last = records[-1]
        ref_str = f" | REF={last['ref']:,.4f}" if 'ref' in last else ""
        print(f"  Ultimo valor: {last['date']} = BNA {last['value']:,.4f}{ref_str}")

if __name__ == "__main__":
    main()
