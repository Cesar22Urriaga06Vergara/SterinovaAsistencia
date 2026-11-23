# Sterinova — Sistema Web En Línea & App Móvil de Asistencia y Nómina

Plataforma 100% Web y App Móvil (PWA + Capacitor) para administración de turnos, días festivos, procesamiento de reloj biométrico (huellero), cálculo automático de recargos/horas extra (`ED, EN, EF, END, RN, RND, RF`) y portal móvil de empleados con reloj GPS.

## Estructura Limpia (Sin `.exe` ni Tkinter)

- `server.py`: Servidor Web y API REST que sirve tanto el backend como la aplicación web/móvil.
- `core/`: Motor de cálculo de nómina, normalizador de Excel del huellero, comparador y exportador corporativo.
- `db.py` y `models.py`: Persistencia SQLite (`data/asistencia.db`) con soporte para administradores, empleados, turnos, asignaciones, marcaciones GPS y solicitudes.
- `public/`: Interfaz Web y App Móvil (`index.html`, `styles.css`, `app.js`, `manifest.webmanifest`, `sw.js`).
- `Dockerfile`, `render.yaml`, `Procfile`: Listos para desplegar en línea en la nube (Render, Railway, Fly.io o VPS).
- `capacitor.config.json`, `package.json`: Listos para empaquetar como App nativa Android/iOS.

## Ejecución

```bash
python server.py
```

O haz doble clic en `iniciar_app.bat` para abrir `http://localhost:8000`.
