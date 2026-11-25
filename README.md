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

## Sesiones

El servidor conserva las sesiones en memoria durante un máximo de ocho horas y las invalida al cerrar sesión. Reiniciar el proceso requiere volver a iniciar sesión. El despliegue actual debe usar una sola instancia para que todas las peticiones de una sesión lleguen al mismo proceso.

Configura `SESSION_COOKIE_SECURE=1` para servir la aplicación por HTTPS. Render ya incluye este ajuste. Para desarrollo local por HTTP, deja la variable sin configurar.

La prueba de integración usa una base temporal y se ejecuta con `python tests/smoke_asistencia.py` después de instalar las dependencias.

## Migración de credenciales

Al iniciar, el servidor transforma las contraseñas y los PIN personalizados anteriores en hashes con sal. Los empleados que usaban el PIN compartido anterior o los últimos dígitos del documento necesitan un PIN nuevo para entrar al portal. Al editar o importar un empleado, un PIN vacío conserva el que ya tenía. Un empleado nuevo puede quedar registrado para asistencia y recibir después su PIN de acceso.

Rota las credenciales que hayan estado presentes en copias anteriores de SQLite, incluido el archivo versionado. Si el superadministrador se configura por entorno, actualiza también `SUPERADMIN_PASS`.

## Decisiones sobre asistencia y revisión

- **Marcación móvil.** El registro usa hora, tipo, coordenadas, precisión, dirección y nota. Las fotos anteriores quedan fuera de las consultas de la aplicación. Su eliminación de bases y respaldos existentes requiere definir la retención aplicable.
- **Cierre de periodos.** El supervisor prepara las novedades, Talento Humano valida y una persona facultada cierra o reabre. Cada acción deberá registrar a su responsable y las reaperturas deberán registrar su motivo.
- **Auditoría.** El auditor consulta, deja observaciones y exporta resultados dentro de su alcance. El reprocesamiento y los ajustes corresponden al responsable operativo y deberán quedar en una nueva revisión.

La separación de responsabilidades de cierre y auditoría está aprobada para su implementación en el flujo de permisos y periodos.

## Piloto web y migración de escritorio

El Blueprint de Render crea un servicio piloto separado, de una instancia, con HTTPS, comprobación pública en `/salud` y almacenamiento persistente en `/var/data`. Configure los secretos de Superadmin en Render. `ASISTENCIA_DATA_DIR` contiene SQLite y los archivos generados. Las plantillas y los recursos de marca permanecen en el repositorio. Las fechas operativas del servidor usan la zona America/Bogota.

Confirme la base con el equipo que usa el ejecutable. La aplicación de escritorio guarda sus datos junto al ejecutable, en `data/asistencia.db`. Trabaje con una copia en un directorio privado y use el importador sobre una base de pruebas inicializada. El mapa JSON relaciona identificadores con nombres de áreas de la web. Puede dar un área a cada empleado y turno, o especificar un área predeterminada en un ensayo.

```json
{
  "empleados": {"ID_EMPLEADO": "Producción"},
  "turnos": {"ID_TURNO": "Producción"},
  "area_predeterminada": "Administrativos"
}
```

```powershell
python administrar_datos.py copiar C:/ruta/PC/data/asistencia.db C:/piloto/pc-copia.db
python administrar_datos.py inicializar C:/piloto/web.db
python administrar_datos.py importar C:/piloto/pc-copia.db C:/piloto/web.db --mapa C:/piloto/areas.json
python administrar_datos.py importar C:/piloto/pc-copia.db C:/piloto/web.db --mapa C:/piloto/areas.json --aplicar
```

La primera ejecución de `importar` revierte todos los cambios y muestra el inventario y los conflictos. `--aplicar` conserva los cambios cuando el inventario está libre de conflictos. Los accesos de supervisores se crean en Áreas y Usuarios y los PIN se asignan en Base de Empleados. La copia de SQLite es consistente incluso con WAL. Para probar una restauración, use `copiar` con el respaldo como origen y una ruta nueva como destino. Guarde las copias fuera del almacenamiento del servicio.

Valide un corte completo en paralelo con el mismo Excel en ambos sistemas. Compare horas y recargos por empleado y fecha, descargue la revisión cerrada, pruebe marcación en un teléfono, imprima una hoja y compruebe reportes después de reiniciar el servicio piloto. Antes del cambio operativo, conserve el escritorio y su último respaldo para consulta y contingencia.
