#!/usr/bin/env python3
"""
Servidor HTTP local simple para Banda Monitor.
Accesible desde cualquier dispositivo en la misma WiFi.

Uso:
  python servidor_local.py

Luego abre en el iPhone:
  http://TU_IP:8000/banda_monitor.html

Para saber tu IP:
  Windows: ipconfig
  Mac/Linux: ifconfig
  Busca "IPv4 Address" o algo similar (ej: 192.168.1.100)
"""

import http.server
import socketserver
import os
import socket
import sys

PORT = 8000

class MyHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Permitir acceso desde cualquier origen (CORS)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, format, *args):
        # Logging mejorado
        print(f"[{self.log_date_time_string()}] {format % args}")

def get_local_ip():
    """Obtiene la IP local de la máquina."""
    try:
        # Conecta a un servidor externo (sin realmente conectar)
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return "127.0.0.1"

if __name__ == '__main__':
    # Cambiar al directorio del script
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)

    local_ip = get_local_ip()

    with socketserver.TCPServer(("", PORT), MyHTTPRequestHandler) as httpd:
        print("=" * 60)
        print("  Banda Monitor - Servidor Local")
        print("=" * 60)
        print()
        print(f"  Local:    http://localhost:{PORT}/banda_monitor.html")
        print(f"  En WiFi:  http://{local_ip}:{PORT}/banda_monitor.html")
        print()
        print(f"  Abre el enlace en Safari del iPhone (misma WiFi)")
        print()
        print("  Presiona CTRL+C para detener el servidor")
        print("=" * 60)
        print()

        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n\nServidor detenido.")
            sys.exit(0)
