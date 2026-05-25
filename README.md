# Emma Presupuestos Pro

Paquete comercial para vender Emma como sistema web de presupuestos de obra.

## Archivos principales

- `index.html`: landing page de venta.
- `demo.html`: demo comercial ligera para mostrar el valor en 5 minutos.
- `app/presupuesto_emma.html`: copia de la app completa original.
- `ventas/`: mensajes, guion, checklist y plan de prospeccion.
- `assets/screenshots/`: capturas listas para landing, redes y videos.
- `assets/videos/`: carpeta destino para MP4 exportados desde una IA con avatar.
- `server.js`: servidor estatico para publicar en Railway.
- `railway.json`: configuracion de despliegue para Railway.
- `netlify.toml`: configuracion lista para publicar como sitio estatico.

## Como probar localmente

Abre `index.html` en el navegador, o levanta un servidor local:

```powershell
python -m http.server 8080
```

Luego abre:

```text
http://localhost:8080
```

Tambien puedes probarlo con Node, igual que Railway:

```powershell
npm start
```

## Como publicarlo rapido

1. Sube esta carpeta a GitHub.
2. En Railway, crea un servicio nuevo conectado al repo.
3. Configura `emma-presupuestos.com` para el sitio comercial.
4. Configura `api.emma-presupuestos.com` para el servidor de licencias.
5. Usa `/demo` para prospectos frios.
6. Usa `/app` para demos completas o clientes con licencia.

## Orden recomendado de venta

1. Enviar mensaje corto por WhatsApp.
2. Mandar link de `demo.html`.
3. Agendar demo de 5 a 10 minutos.
4. Abrir `app/presupuesto_emma.html` para mostrar la herramienta real.
5. Ofrecer plan anual como opcion principal.

## Videos con avatar

Ya estan preparados:

- `ventas/video-avatar.md`: guiones de 30, 45 y 90 segundos.
- `ventas/storyboard.md`: orden de tomas y textos en pantalla.
- `ventas/herramientas-ia-avatar.md`: opciones recomendadas con enlaces oficiales.

Las capturas para subir a HeyGen, Synthesia o D-ID estan en `assets/screenshots`.

Video generado:

- `assets/videos/emma-anuncio-45s.mp4`
- `assets/videos/emma-anuncio-vertical-9x16.mp4`
