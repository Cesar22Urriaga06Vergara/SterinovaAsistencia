/* =========================================================================
   STERINOVA - Plataforma Inteligente Web & App Móvil de Asistencia y Nómina
   Arquitectura Corporativa de 6 Roles + Áreas + Notificaciones en Tiempo Real:
   1) SUPERADMIN: Crea/edita Áreas, Usuarios (Supervisores ligados a su Área,
      Admin General, Auditor de Horas Extras, Talento Humano), Base de Empleados.
   2) SUPERVISOR (ligado a su Área): Crea/edita/elimina Turnos de su Área,
      asigna turnos en Calendario/Gantt, valida horas extras con el Huellero,
      genera reportes Individuales o Agrupados de sus empleados y avala permisos.
   3) AUDITOR DE HORAS EXTRAS: Ve todos los reportes y métricas de horas extras
      de todas las áreas y también puede procesar el Huellero y generar reportes
      individuales o por área si aún no están hechos.
   4) TALENTO HUMANO (RRHH): Gestión y aprobación final de permisos, exportación
      de Reporte Excel de Permisos, envío de Memorandos/Capacitaciones con
      notificaciones en tiempo real y confirmación de lectura, y validación de
      huellero de Administrativos o de cualquier Área.
   5) ADMIN GENERAL: Consulta y auditoría ejecutiva global (ve todas las Áreas,
      Supervisores, Empleados, Métricas, Gráficas, Mapa GPS y Reportes).
   6) EMPLEADO: Reloj GPS con Dirección Física + Coordenadas + Selfie, Buzón de
      Memorandos/Capacitaciones con confirmación de "Enterado", Mis Turnos,
      Mis Horas Extra y Solicitud de Permisos.
   ========================================================================= */

const SHIFT_COLORS = [
  "#0284C7", "#7C3AED", "#0D9488", "#D97706", "#DC2626",
  "#2563EB", "#9333EA", "#059669", "#EA580C", "#4F46E5"
];

const STATE = {
  user: JSON.parse(localStorage.getItem("sterinova_user") || "null"),
  darkMode: localStorage.getItem("sterinova_dark") === "true",
  activeView: "dashboard",
  deferredInstallPrompt: null,
  // Notificaciones en tiempo real
  notificaciones: [],
  notificacionesNoLeidas: 0,
  knownNotifIds: new Set(),
  showNotifModal: false,
  // Datos compartidos
  dashboard: null,
  areas: [],
  usuarios: [],
  turnos: [],
  festivos: [],
  empleados: [],
  asignaciones: [],
  reportes: [],
  solicitudes: [],
  comunicados: [],
  marcacionesMoviles: [],
  // Asignación de Turnos
  calMonth: new Date().toISOString().slice(0, 7),
  asignacionModoVista: "calendario",
  selectedEmployees: new Set(),
  selectedDates: new Set(),
  searchEmpAsignacion: "",
  // Procesar Huellero (Individual o Agrupado por Área)
  huelleroFiles: [],
  huelleroPreview: null,
  huelleroFiltroArea: "",
  huelleroFiltroEmpleado: "TODOS",
  // Análisis y Hoja Imprimible
  analisisTab: "tabla",
  hojaEmpleadoId: "",
  analisisData: {
    kpis: { horas_extra: 0, minutos_tardanza: 0, ausencias: 0, llegadas_tempranas: 0 },
    filas: [],
    turnos_disponibles: [],
    rango_fechas: { inicio: "", fin: "" }
  },
  analisisFiltros: {
    id_area: "",
    id_empleado: "TODOS",
    turno: "TODOS",
    fecha_inicio: "",
    fecha_fin: "",
    kpi: ""
  },
  // Estado Portal Empleado + Cámara Selfie
  empResumen: null,
  gpsActual: null,
  cameraStream: null,
  selfieBase64: "",
  notaMarcacion: "",
  // Buscadores en tiempo real de tablas
  searchUsuarios: "",
  searchEmpleados: "",
  searchTurnos: "",
  searchFestivos: "",
  // Filtros y pestañas corporativas (Superadmin + global)
  superadminTab: "usuarios", // "usuarios" | "areas"
  procesarTab: "validar", // "validar" | "reportes"
  gpsTab: "permisos", // "permisos" | "mapa"
  rrhhTab: "permisos", // "permisos" | "comunicados"
  adminEstructuraTab: "supervisores", // "supervisores" | "areas" | "empleados"
  filtroAreaEmpleados: "",
  // Drawer / Modal global reutilizable para formularios limpios
  // Tipos: null | "area" | "usuario" | "empleado" | "importar_empleados" | "festivo" | "turno" | "comunicado"
  activeDrawer: null,
  drawerData: null,
  // Estado UI del Login Corporativo
  showPassword: false
};

function icon(name, size = 18) {
  return `<i data-lucide="${name}" style="width:${size}px; height:${size}px;"></i>`;
}

function refreshLucideIcons() {
  if (typeof lucide !== "undefined" && lucide.createIcons) {
    lucide.createIcons();
  }
}

let chartRecargosInstance = null;
let chartEstadosInstance = null;
let leafletMapInstance = null;

function applyTheme() {
  if (STATE.darkMode) document.body.classList.add("dark-mode");
  else document.body.classList.remove("dark-mode");
}

function toggleDarkMode() {
  STATE.darkMode = !STATE.darkMode;
  localStorage.setItem("sterinova_dark", String(STATE.darkMode));
  applyTheme();
  renderApp();
}

function getShiftColor(idTurno, esDescanso = false) {
  if (esDescanso) return "#10B981";
  if (!idTurno) return "#64748B";
  return SHIFT_COLORS[Number(idTurno) % SHIFT_COLORS.length];
}

// Si el usuario es Supervisor, está restringido estrictamente a su Área asignada
function getEffectiveAreaId() {
  if (!STATE.user) return null;
  if (STATE.user.role === "supervisor") {
    return STATE.user.id_area || null;
  }
  return null;
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  STATE.deferredInstallPrompt = e;
  renderApp();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

function showToast(msg, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = "toast";
  if (type === "error") el.style.borderLeftColor = "#EF4444";
  if (type === "success") el.style.borderLeftColor = "#10B981";
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || "Error de comunicación con el servidor");
  }
  return data;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
}

function stopCameraStream() {
  if (STATE.cameraStream) {
    STATE.cameraStream.getTracks().forEach((t) => t.stop());
    STATE.cameraStream = null;
  }
}

function setUser(user) {
  stopCameraStream();
  STATE.user = user;
  STATE.knownNotifIds.clear();
  if (user) {
    localStorage.setItem("sterinova_user", JSON.stringify(user));
    if (user.role === "superadmin") STATE.activeView = "areas_usuarios";
    else if (user.role === "admin") STATE.activeView = "dashboard";
    else if (user.role === "supervisor") STATE.activeView = "turnos";
    else if (user.role === "auditor") STATE.activeView = "analisis";
    else if (user.role === "talento_humano") STATE.activeView = "rrhh_comunicados";
    else STATE.activeView = "emp_reloj";

    if (user.role === "supervisor" && user.id_area) {
      STATE.huelleroFiltroArea = String(user.id_area);
      STATE.analisisFiltros.id_area = String(user.id_area);
    } else {
      STATE.huelleroFiltroArea = "";
      STATE.analisisFiltros.id_area = "";
    }
    initRoleData();
  } else {
    localStorage.removeItem("sterinova_user");
    renderApp();
  }
}

async function initRoleData() {
  applyTheme();
  try {
    if (!STATE.user) {
      renderApp();
      return;
    }
    await loadNotificaciones(false);
    const role = STATE.user.role;
    if (role !== "empleado") {
      const promises = [
        loadDashboard(),
        loadAreas(),
        loadTurnos(),
        loadFestivos(),
        loadEmpleados(),
        loadSolicitudes(),
        loadComunicados(),
        loadReportes(),
        loadMarcacionesMoviles()
      ];
      if (role === "superadmin" || role === "admin") {
        promises.push(loadUsuarios());
      }
      await Promise.all(promises);
      if (STATE.empleados.length > 0 && STATE.selectedEmployees.size === 0) {
        STATE.selectedEmployees.add(STATE.empleados[0].id_empleado);
      }
      if (STATE.empleados.length > 0 && !STATE.hojaEmpleadoId) {
        STATE.hojaEmpleadoId = STATE.empleados[0].id_empleado;
      }
      await loadAsignaciones();
      await loadAnalisis();
    } else {
      await loadEmpleadoResumen();
      obtenerUbicacionGPS();
    }
    renderApp();
  } catch (err) {
    showToast(err.message, "error");
    renderApp();
  }
}

async function loadNotificaciones(notifyNew = true) {
  if (!STATE.user) return;
  try {
    const params = new URLSearchParams({
      rol: STATE.user.role,
      user_id: STATE.user.id
    });
    if (STATE.user.id_area) params.set("id_area", String(STATE.user.id_area));
    const r = await apiFetch(`/api/notificaciones?${params.toString()}`);
    const list = r.notificaciones || [];
    if (notifyNew && STATE.knownNotifIds.size > 0) {
      list.forEach((n) => {
        if (!STATE.knownNotifIds.has(n.id) && !n.leida) {
          showToast(`🔔 ${n.titulo}: ${n.mensaje}`, "info");
        }
      });
    }
    list.forEach((n) => STATE.knownNotifIds.add(n.id));
    STATE.notificaciones = list;
    STATE.notificacionesNoLeidas = r.no_leidas || 0;
    const badgeEl = document.getElementById("notif-bell-count");
    if (badgeEl) {
      badgeEl.textContent = String(STATE.notificacionesNoLeidas);
      badgeEl.style.display = STATE.notificacionesNoLeidas > 0 ? "inline-flex" : "none";
    }
  } catch {}
}

// Polling en tiempo real cada 8 segundos para notificaciones y memorandos
setInterval(() => {
  if (STATE.user) {
    loadNotificaciones(true);
  }
}, 8000);

async function loadDashboard() { STATE.dashboard = await apiFetch("/api/dashboard"); }
async function loadAreas() { const r = await apiFetch("/api/areas"); STATE.areas = r.areas || []; }
async function loadUsuarios() { const r = await apiFetch("/api/usuarios"); STATE.usuarios = r.usuarios || []; }
async function loadTurnos() {
  const areaId = getEffectiveAreaId();
  const url = areaId ? `/api/turnos?id_area=${areaId}` : "/api/turnos";
  const r = await apiFetch(url);
  STATE.turnos = r.turnos || [];
}
async function loadFestivos() { const r = await apiFetch("/api/festivos"); STATE.festivos = r.festivos || []; }
async function loadEmpleados() {
  const areaId = getEffectiveAreaId();
  const url = areaId ? `/api/empleados?id_area=${areaId}` : "/api/empleados";
  const r = await apiFetch(url);
  STATE.empleados = r.empleados || [];
}
async function loadAsignaciones() {
  const r = await apiFetch(`/api/asignaciones?mes=${encodeURIComponent(STATE.calMonth)}`);
  const empIds = new Set(STATE.empleados.map((e) => e.id_empleado));
  const areaId = getEffectiveAreaId();
  STATE.asignaciones = (r.asignaciones || []).filter((a) => !areaId || empIds.has(a.id_empleado));
}
async function loadReportes() { const r = await apiFetch("/api/reportes"); STATE.reportes = r.reportes || []; }
async function loadSolicitudes() {
  const areaId = getEffectiveAreaId();
  const url = areaId ? `/api/solicitudes?id_area=${areaId}` : "/api/solicitudes";
  const r = await apiFetch(url);
  STATE.solicitudes = r.solicitudes || [];
}
async function loadComunicados() {
  const r = await apiFetch("/api/comunicados");
  STATE.comunicados = r.comunicados || [];
}
async function loadMarcacionesMoviles() {
  const areaId = getEffectiveAreaId();
  const url = areaId ? `/api/marcaciones-moviles?id_area=${areaId}` : "/api/marcaciones-moviles";
  const r = await apiFetch(url);
  STATE.marcacionesMoviles = r.marcaciones || [];
}
async function loadAnalisis() {
  const f = STATE.analisisFiltros;
  const params = new URLSearchParams();
  const effectiveArea = getEffectiveAreaId() || f.id_area;
  if (effectiveArea && effectiveArea !== "TODAS") params.set("id_area", String(effectiveArea));
  if (f.id_empleado && f.id_empleado !== "TODOS") params.set("id_empleado", f.id_empleado);
  if (f.turno && f.turno !== "TODOS") params.set("turno", f.turno);
  if (f.fecha_inicio) params.set("fecha_inicio", f.fecha_inicio);
  if (f.fecha_fin) params.set("fecha_fin", f.fecha_fin);
  if (f.kpi) params.set("kpi", f.kpi);
  const r = await apiFetch(`/api/analisis?${params.toString()}`);
  STATE.analisisData = r;
  if (!f.fecha_inicio && r.rango_fechas?.inicio) {
    STATE.analisisFiltros.fecha_inicio = r.rango_fechas.inicio;
    STATE.analisisFiltros.fecha_fin = r.rango_fechas.fin;
  }
}

async function loadEmpleadoResumen() {
  if (!STATE.user) return;
  STATE.empResumen = await apiFetch(`/api/empleado/resumen?id_empleado=${encodeURIComponent(STATE.user.id)}`);
}

// --- GEOLOCALIZACIÓN CON COORDENADAS Y DIRECCIÓN FÍSICA ---
async function resolverDireccionPorCoordenadas(lat, lon) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&accept-language=es`
    );
    if (!res.ok) return "";
    const data = await res.json();
    return (data.display_name || "").trim();
  } catch {
    return "";
  }
}

function obtenerUbicacionGPS() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = Number(pos.coords.latitude.toFixed(6));
      const lon = Number(pos.coords.longitude.toFixed(6));
      const prec = Math.round(pos.coords.accuracy);
      STATE.gpsActual = {
        latitud: lat,
        longitud: lon,
        precision_m: prec,
        direccion: STATE.gpsActual?.direccion || ""
      };
      const el = document.getElementById("gps-status-badge");
      if (el) {
        el.innerHTML = `📍 <strong>Coordenadas:</strong> ${lat}, ${lon} (±${prec}m)<br/>🏠 <strong>Dirección:</strong> Resolviendo dirección física...`;
      }
      const dir = await resolverDireccionPorCoordenadas(lat, lon);
      STATE.gpsActual.direccion = dir || `Coord: ${lat}, ${lon}`;
      const el2 = document.getElementById("gps-status-badge");
      if (el2) {
        el2.innerHTML = `📍 <strong>Coordenadas:</strong> ${lat}, ${lon} (±${prec}m)<br/>🏠 <strong>Dirección:</strong> ${STATE.gpsActual.direccion}`;
      }
    },
    () => {},
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// ============================================================================
// RENDERIZADO PRINCIPAL
// ============================================================================

function applyMobileTableLabels() {
  document.querySelectorAll(".corp-table-card table").forEach((table) => {
    const headers = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim());
    if (headers.length === 0) return;
    table.querySelectorAll("tbody tr").forEach((tr) => {
      tr.querySelectorAll("td").forEach((td, idx) => {
        if (!td.hasAttribute("colspan") && headers[idx]) {
          td.setAttribute("data-label", headers[idx]);
        }
      });
    });
  });
}

function renderApp() {
  applyTheme();
  const root = document.getElementById("app");
  if (!root) return;

  if (!STATE.user) {
    root.innerHTML = renderLoginScreen();
    bindLoginEvents();
    refreshLucideIcons();
    return;
  }

  if (STATE.user.role === "empleado") {
    root.innerHTML = renderEmpleadoLayout();
    bindEmpleadoEvents();
    applyMobileTableLabels();
    refreshLucideIcons();
  } else {
    root.innerHTML = renderManagementLayout();
    bindManagementEvents();
    applyMobileTableLabels();
    refreshLucideIcons();
    setTimeout(() => {
      if (STATE.activeView === "analisis" || STATE.activeView === "dashboard") {
        initAnalisisCharts();
      }
      if (STATE.activeView === "gps_solicitudes" && STATE.gpsTab === "mapa") {
        initGpsLeafletMap();
      }
    }, 60);
  }
}

// ============================================================================
// LOGIN CORPORATIVO ENTERPRISE SPLIT-SCREEN (ACCESO UNIFICADO)
// ============================================================================

function renderLoginScreen() {
  return `
    <div class="login-wrapper">
      <div class="login-hero">
        <div class="login-hero-top">
          <div class="login-hero-badge">
            ${icon("shield-check", 15)}
            <span>PLATAFORMA CORPORATIVA</span>
          </div>
        </div>

        <div class="login-hero-content">
          <h1>Aseguramiento en esterilización</h1>
          <p>Nuestro equipo, comprometido con la excelencia en cada servicio.</p>
        </div>
        <div class="login-hero-footer">
          <span>© ${new Date().getFullYear()} Sterinova</span>
          <span style="display:inline-flex; align-items:center; gap:6px;">
            ${icon("lock", 14)} Conexión segura
          </span>
        </div>
      </div>

      <div class="login-panel">
        <div class="login-panel-topbar">
          <button type="button" id="btn-theme-login" class="btn btn-outline btn-sm">
            ${STATE.darkMode ? `${icon("sun", 15)} Modo Claro` : `${icon("moon", 15)} Modo Oscuro`}
          </button>
        </div>

        <div class="login-card">
          <div class="login-brand-box">
            <img src="/sterinova_logo.jpg" alt="Sterinova" class="login-logo" onerror="this.src='/api/branding/logo'" />
          </div>

          <div class="login-title">Bienvenido</div>
          <div class="login-subtitle">Ingresa tus credenciales para continuar</div>

          <form id="form-login-unificado">
            <div class="form-group">
              <label class="form-label" for="login-identificador">
                Usuario o ID de Empleado
              </label>
              <div class="login-input-group">
                <span class="login-input-icon">${icon("user", 17)}</span>
                <input
                  type="text"
                  id="login-identificador"
                  class="form-control"
                  placeholder="Ingresa tu usuario o código"
                  autocomplete="username"
                  required
                />
              </div>
            </div>

            <div class="form-group">
              <label class="form-label" for="login-clave">
                Contraseña o PIN
              </label>
              <div class="login-input-group">
                <span class="login-input-icon">${icon("lock", 17)}</span>
                <input
                  type="${STATE.showPassword ? "text" : "password"}"
                  id="login-clave"
                  class="form-control"
                  placeholder="Ingresa tu contraseña o PIN"
                  autocomplete="current-password"
                  required
                />
                <button type="button" id="btn-toggle-pass" class="login-eye-btn" title="Mostrar u ocultar contraseña">
                  ${icon(STATE.showPassword ? "eye-off" : "eye", 17)}
                </button>
              </div>
            </div>

            <button type="submit" id="btn-submit-login" class="btn btn-primary btn-block" style="margin-top:16px; padding:13px; font-size:0.95rem;">
              ${icon("log-in", 17)} Iniciar Sesión
            </button>
          </form>

          ${
            STATE.deferredInstallPrompt
              ? `
            <button type="button" id="btn-install-pwa-login" class="btn btn-outline btn-block" style="margin-top:12px;">
              ${icon("smartphone", 17)} Instalar App de Sterinova
            </button>
          `
              : ""
          }
        </div>
      </div>
    </div>
  `;
}

function bindLoginEvents() {
  document.getElementById("btn-theme-login")?.addEventListener("click", toggleDarkMode);

  document.getElementById("btn-toggle-pass")?.addEventListener("click", () => {
    const passEl = document.getElementById("login-clave");
    const currentVal = passEl ? passEl.value : "";
    const idVal = document.getElementById("login-identificador")?.value || "";
    STATE.showPassword = !STATE.showPassword;
    renderApp();
    const newId = document.getElementById("login-identificador");
    const newPass = document.getElementById("login-clave");
    if (newId) newId.value = idVal;
    if (newPass) {
      newPass.value = currentVal;
      newPass.focus();
    }
  });

  const form = document.getElementById("form-login-unificado");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btnSubmit = document.getElementById("btn-submit-login");
      const originalHtml = btnSubmit ? btnSubmit.innerHTML : "";
      try {
        if (btnSubmit) {
          btnSubmit.disabled = true;
          btnSubmit.innerHTML = `${icon("loader-2", 17)} Verificando credenciales...`;
          refreshLucideIcons();
        }
        const identificador = document.getElementById("login-identificador").value.trim();
        const clave = document.getElementById("login-clave").value;
        const res = await apiFetch("/api/login", {
          method: "POST",
          body: JSON.stringify({ identificador, clave })
        });
        const rolEtiqueta = {
          superadmin: "Superadministrador",
          admin: "Admin General",
          supervisor: `Supervisor (${res.user.nombre_area || "Área"})`,
          auditor: "Auditor de Horas Extras",
          talento_humano: "Talento Humano (RRHH)",
          empleado: "Colaborador"
        }[res.user.role] || res.user.role;
        STATE.showPassword = false;
        showToast(`Bienvenido (${rolEtiqueta}): ${res.user.nombre}`, "success");
        setUser(res.user);
      } catch (err) {
        showToast(err.message, "error");
        if (btnSubmit) {
          btnSubmit.disabled = false;
          btnSubmit.innerHTML = originalHtml;
          refreshLucideIcons();
        }
      }
    });
  }

  const btnInstall = document.getElementById("btn-install-pwa-login");
  if (btnInstall && STATE.deferredInstallPrompt) {
    btnInstall.addEventListener("click", async () => {
      STATE.deferredInstallPrompt.prompt();
      await STATE.deferredInstallPrompt.userChoice;
      STATE.deferredInstallPrompt = null;
      renderApp();
    });
  }
}

// ============================================================================
// MENÚS ESPECÍFICOS PARA CADA UNO DE LOS ROLES DE GESTIÓN
// ============================================================================

function getMenuForRole(role) {
  if (role === "superadmin") {
    return [
      { id: "areas_usuarios", lucide: "shield-check", label: "Áreas y Usuarios", step: "CONFIG", short: "Áreas/Roles" },
      { id: "empleados", lucide: "users", label: "Base de Empleados", step: "MAESTRO", short: "Empleados" },
      { id: "festivos", lucide: "calendar-days", label: "Días Festivos", step: "CALENDARIO", short: "Festivos" }
    ];
  }

  if (role === "supervisor") {
    return [
      { id: "empleados", lucide: "users", label: "Mi Personal", step: "EQUIPO", short: "Personal" },
      { id: "turnos", lucide: "clock", label: "Turnos de Mi Área", step: "PASO 1", short: "Turnos" },
      { id: "asignacion", lucide: "calendar-range", label: "Asignar Turnos & Gantt", step: "PASO 2", short: "Asignar" },
      { id: "procesar", lucide: "file-spreadsheet", label: "Validar Huellero y Reportes", step: "PASO 3", short: "Huellero" },
      { id: "analisis", lucide: "bar-chart-3", label: "Horas Extra y Hoja PDF", step: "PASO 4", short: "Horas Extra" },
      { id: "gps_solicitudes", lucide: "map-pin", label: "Permisos y Mapa GPS", step: "PERMISOS", short: "Permisos/GPS" }
    ];
  }

  if (role === "auditor") {
    return [
      { id: "analisis", lucide: "file-check-2", label: "Auditoría de Horas Extras", step: "CONTROL", short: "Auditoría" },
      { id: "procesar", lucide: "file-spreadsheet", label: "Generar Reportes / Huellero", step: "LIQUIDAR", short: "Sacar Reporte" },
      { id: "asignacion", lucide: "calendar-range", label: "Consulta Matriz Gantt", step: "TURNOS", short: "Gantt" },
      { id: "gps_solicitudes", lucide: "map-pin", label: "Auditoría GPS y Permisos", step: "CAMPO", short: "GPS" }
    ];
  }

  if (role === "talento_humano") {
    return [
      { id: "rrhh_comunicados", lucide: "megaphone", label: "Memorandos y Permisos", step: "RRHH", short: "Permisos/Memos" },
      { id: "procesar", lucide: "file-spreadsheet", label: "Validar Huellero y Reportes", step: "MULTI-ÁREA", short: "Huellero" },
      { id: "analisis", lucide: "bar-chart-3", label: "Horas Extra y Hoja PDF", step: "REPORTES", short: "Horas Extra" },
      { id: "turnos", lucide: "clock", label: "Turnos (Administrativos)", step: "TURNOS", short: "Turnos" },
      { id: "asignacion", lucide: "calendar-range", label: "Asignación & Gantt", step: "PROGRAMAR", short: "Asignar" },
      { id: "empleados", lucide: "users", label: "Base de Empleados", step: "PERSONAL", short: "Empleados" },
      { id: "festivos", lucide: "calendar-days", label: "Días Festivos", step: "CALENDARIO", short: "Festivos" }
    ];
  }

  return [
    { id: "dashboard", lucide: "layout-dashboard", label: "Dashboard Ejecutivo", step: "GERENCIA", short: "Resumen" },
    { id: "analisis", lucide: "bar-chart-3", label: "Métricas, Gráficas y PDF", step: "AUDITORÍA", short: "Métricas" },
    { id: "supervisores_empleados", lucide: "building-2", label: "Supervisores y Empleados", step: "ESTRUCTURA", short: "Personal" },
    { id: "gps_solicitudes", lucide: "map-pin", label: "Mapa GPS y Permisos", step: "CONTROL", short: "Mapa GPS" }
  ];
}

// --- MODAL DE CAMPANA DE NOTIFICACIONES EN TIEMPO REAL ---
function renderNotificationsBanner() {
  if (!STATE.showNotifModal) return "";
  return `
    <div class="card no-print" style="border:2px solid var(--naranja); background:var(--superficie); margin-bottom:20px;">
      <div class="card-header">
        <div class="card-title">🔔 Centro de Notificaciones en Tiempo Real (${STATE.notificaciones.length})</div>
        <button type="button" id="btn-close-notifs" class="btn btn-outline btn-sm">Cerrar ✖</button>
      </div>
      <div class="table-responsive" style="max-height:280px;">
        <table>
          <thead>
            <tr>
              <th>Fecha/Hora</th>
              <th>Tipo</th>
              <th>Título y Mensaje</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            ${
              STATE.notificaciones.length === 0
                ? `<tr><td colspan="4" style="text-align:center; padding:18px;">No tienes notificaciones registradas.</td></tr>`
                : STATE.notificaciones
                    .map(
                      (n) => `
                <tr>
                  <td><small>${n.creado_en}</small></td>
                  <td><span class="badge badge-info">${n.tipo}</span></td>
                  <td><strong>${n.titulo}</strong><br/><span style="font-size:0.84rem; color:var(--texto-sec);">${n.mensaje}</span></td>
                  <td>
                    ${
                      n.leida
                        ? '<span class="badge badge-ok">Leída</span>'
                        : `<button type="button" class="btn btn-primary btn-sm btn-read-notif" data-id="${n.id}">✔ Marcar Leída</button>`
                    }
                  </td>
                </tr>
              `
                    )
                    .join("")
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderManagementLayout() {
  const role = STATE.user.role;
  const navItems = getMenuForRole(role);
  if (!navItems.some((n) => n.id === STATE.activeView)) {
    STATE.activeView = navItems[0].id;
  }
  const currentNav = navItems.find((n) => n.id === STATE.activeView) || navItems[0];

  const roleBadgeMap = {
    superadmin: { lucide: "shield-check", text: "Superadministrador" },
    admin: { lucide: "layout-dashboard", text: "Admin General (Ejecutivo)" },
    supervisor: { lucide: "user-check", text: `Supervisor — ${STATE.user.nombre_area || "Área"}` },
    auditor: { lucide: "file-check-2", text: "Auditor de Horas Extras" },
    talento_humano: { lucide: "users", text: "Talento Humano (RRHH)" }
  };
  const roleInfo = roleBadgeMap[role] || { lucide: "user", text: role };
  const initials = (STATE.user.nombre || "U")
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar-brand">
          <img src="/api/branding/logo" alt="Sterinova" onerror="this.style.display='none'" />
        </div>
        <div class="sidebar-user">
          <div class="avatar-circle">${initials}</div>
          <div style="min-width:0;">
            <div style="font-weight:700; font-size:0.89rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${STATE.user.nombre}</div>
            <div style="font-size:0.73rem; color:rgba(255,255,255,0.68); display:flex; align-items:center; gap:5px; margin-top:2px;">
              ${icon(roleInfo.lucide, 13)} <span>${roleInfo.text}</span>
            </div>
          </div>
        </div>
        <div class="sidebar-section-label">Módulos asignados</div>
        <nav class="sidebar-nav">
          ${navItems
            .map(
              (item) => `
            <button type="button" class="nav-btn ${STATE.activeView === item.id ? "active" : ""}" data-view="${item.id}">
              ${icon(item.lucide || "circle", 18)}
              <span>${item.label}</span>
              <span class="nav-step-badge">${item.step}</span>
            </button>
          `
            )
            .join("")}
        </nav>
        <div class="sidebar-footer">
          <button type="button" id="btn-logout" class="btn btn-danger btn-block btn-sm">
            ${icon("log-out", 15)} Cerrar Sesión
          </button>
        </div>
      </aside>

      <div class="main-area">
        <header class="topbar">
          <div class="topbar-left">
            <div class="topbar-title">${icon(currentNav.lucide || "layout-grid", 19)} <span>${currentNav.label}</span></div>
          </div>
          <div class="topbar-right">
            ${
              STATE.deferredInstallPrompt
                ? `<button type="button" id="btn-install-pwa" class="btn btn-action btn-sm">${icon("smartphone", 15)} Instalar App</button>`
                : ""
            }
            <button type="button" id="btn-toggle-notifs" class="icon-btn" title="Notificaciones">
              ${icon("bell", 17)}
              <span id="notif-bell-count" class="notif-dot" style="display:${
                STATE.notificacionesNoLeidas > 0 ? "inline-flex" : "none"
              };">${STATE.notificacionesNoLeidas}</span>
            </button>
            <button type="button" id="btn-toggle-theme" class="icon-btn" title="${STATE.darkMode ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}">
              ${STATE.darkMode ? icon("sun", 17) : icon("moon", 17)}
            </button>
            <button type="button" id="btn-top-logout" class="icon-btn icon-btn-danger mobile-only-btn" title="Cerrar Sesión">
              ${icon("log-out", 17)}
            </button>
          </div>
        </header>

        <main class="content-container">
          ${renderNotificationsBanner()}
          ${renderManagementViewContent()}
        </main>
      </div>

      ${renderActiveDrawer()}

      <nav class="bottom-nav">
        ${(navItems.length > 4 ? navItems.slice(0, 3) : navItems)
          .map(
            (item) => `
          <button type="button" class="bottom-nav-item ${STATE.activeView === item.id ? "active" : ""}" data-view="${item.id}">
            ${icon(item.lucide || "circle", 18)}
            <span>${item.short}</span>
          </button>
        `
          )
          .join("")}
        ${
          navItems.length > 4
            ? `
          <button type="button" class="bottom-nav-item" id="btn-open-mobile-menu">
            ${icon("menu", 18)}
            <span>Menú</span>
          </button>
        `
            : ""
        }
      </nav>
    </div>
  `;
}

function renderManagementViewContent() {
  switch (STATE.activeView) {
    case "areas_usuarios":
      return renderSuperadminAreasYUsuarios();
    case "supervisores_empleados":
      return renderAdminGeneralEstructura();
    case "rrhh_comunicados":
      return renderTalentoHumanoCentro();
    case "dashboard":
      return renderAdminDashboard();
    case "turnos":
      return renderAdminTurnos();
    case "festivos":
      return renderAdminFestivos();
    case "asignacion":
      return renderAdminAsignacion();
    case "procesar":
      return renderAdminProcesar();
    case "analisis":
      return renderAdminAnalisis();
    case "empleados":
      return renderAdminEmpleados();
    case "gps_solicitudes":
      return renderGpsYSolicitudes();
    default:
      return renderAdminDashboard();
  }
}

// ============================================================================
// DRAWER / MODAL CORPORATIVO GLOBAL PARA FORMULARIOS LIMPIOS
// ============================================================================

function openDrawer(type, data = null) {
  STATE.activeDrawer = type;
  STATE.drawerData = data;
  renderApp();
}

function closeDrawer() {
  STATE.activeDrawer = null;
  STATE.drawerData = null;
  renderApp();
}

function renderActiveDrawer() {
  if (!STATE.activeDrawer) return "";
  const d = STATE.drawerData || {};

  if (STATE.activeDrawer === "area") {
    const isEdit = Boolean(d.id);
    return `
      <div class="drawer-backdrop" id="drawer-backdrop">
        <div class="drawer-panel">
          <div class="drawer-header">
            <div class="drawer-title">${icon("building-2", 18)} <span>${isEdit ? "Editar Área" : "Nueva Área"}</span></div>
            <button type="button" class="icon-btn" id="btn-close-drawer">${icon("x", 16)}</button>
          </div>
          <form id="form-area" style="display:flex; flex-direction:column; flex:1; min-height:0;">
            <div class="drawer-body">
              <input type="hidden" id="area-id" value="${d.id || ""}" />
              <div class="form-group">
                <label class="form-label">Nombre del Área</label>
                <input type="text" id="area-nombre" class="form-control" value="${d.nombre || ""}" placeholder="Ej: Producción, Calidad, Conductores..." required />
              </div>
              <div class="form-group">
                <label class="form-label">Descripción</label>
                <textarea id="area-desc" class="form-control" rows="3" placeholder="Descripción opcional del área">${d.descripcion || ""}</textarea>
              </div>
            </div>
            <div class="drawer-footer">
              <button type="button" class="btn btn-outline" id="btn-cancel-drawer">Cancelar</button>
              <button type="submit" class="btn btn-primary">${icon("save", 16)} ${isEdit ? "Actualizar Área" : "Crear Área"}</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  if (STATE.activeDrawer === "usuario") {
    const isEdit = Boolean(d.username);
    const rolActual = d.rol || "supervisor";
    return `
      <div class="drawer-backdrop" id="drawer-backdrop">
        <div class="drawer-panel">
          <div class="drawer-header">
            <div class="drawer-title">${icon("user-plus", 18)} <span>${isEdit ? "Editar Usuario" : "Nuevo Usuario del Sistema"}</span></div>
            <button type="button" class="icon-btn" id="btn-close-drawer">${icon("x", 16)}</button>
          </div>
          <form id="form-usuario-sistema" style="display:flex; flex-direction:column; flex:1; min-height:0;">
            <div class="drawer-body">
              <div class="form-group">
                <label class="form-label">Usuario de Ingreso (Username)</label>
                <input type="text" id="usr-username" class="form-control" value="${d.username || ""}" placeholder="Ej: sup_produccion, auditor1, rrhh" ${isEdit ? "readonly" : ""} required />
              </div>
              <div class="form-group">
                <label class="form-label">Nombre Completo</label>
                <input type="text" id="usr-nombre" class="form-control" value="${d.nombre || ""}" placeholder="Nombre y Apellido" required />
              </div>
              <div class="form-group">
                <label class="form-label">Rol del Usuario</label>
                <select id="usr-rol" class="form-control">
                  <option value="supervisor" ${rolActual === "supervisor" ? "selected" : ""}>Supervisor de Área</option>
                  <option value="auditor" ${rolActual === "auditor" ? "selected" : ""}>Auditor de Horas Extras</option>
                  <option value="talento_humano" ${rolActual === "talento_humano" ? "selected" : ""}>Talento Humano (RRHH)</option>
                  <option value="admin" ${rolActual === "admin" ? "selected" : ""}>Admin General (Gerencia)</option>
                  <option value="superadmin" ${rolActual === "superadmin" ? "selected" : ""}>Superadministrador</option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">Área Ligada <small style="color:var(--texto-sec);">(Obligatoria para Supervisor)</small></label>
                <select id="usr-area" class="form-control">
                  <option value="">-- Global / Todas las Áreas --</option>
                  ${STATE.areas
                    .map((a) => `<option value="${a.id}" ${String(d.id_area || "") === String(a.id) ? "selected" : ""}>${a.nombre}</option>`)
                    .join("")}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">${isEdit ? "Nueva Contraseña" : "Contraseña"}</label>
                <input type="password" id="usr-password" class="form-control" placeholder="${isEdit ? "Ingrese nueva contraseña" : "Contraseña de acceso"}" required />
              </div>
            </div>
            <div class="drawer-footer">
              <button type="button" class="btn btn-outline" id="btn-cancel-drawer">Cancelar</button>
              <button type="submit" class="btn btn-primary">${icon("save", 16)} ${isEdit ? "Guardar Cambios" : "Crear Usuario"}</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  if (STATE.activeDrawer === "empleado") {
    const isEdit = Boolean(d.id_empleado);
    const isSup = STATE.user?.role === "supervisor";
    return `
      <div class="drawer-backdrop" id="drawer-backdrop">
        <div class="drawer-panel">
          <div class="drawer-header">
            <div class="drawer-title">${icon("user-plus", 18)} <span>${isEdit ? "Editar Empleado" : "Nuevo Empleado"}</span></div>
            <button type="button" class="icon-btn" id="btn-close-drawer">${icon("x", 16)}</button>
          </div>
          <form id="form-empleado" style="display:flex; flex-direction:column; flex:1; min-height:0;">
            <div class="drawer-body">
              <div class="form-group">
                <label class="form-label">ID / Código Biométrico</label>
                <input type="text" id="emp-id" class="form-control" value="${d.id_empleado || ""}" placeholder="Ej: 141 o 1003001750" ${isEdit ? "readonly" : ""} required />
              </div>
              <div class="form-group">
                <label class="form-label">Nombre Completo</label>
                <input type="text" id="emp-nombre" class="form-control" value="${d.nombre || ""}" placeholder="Apellidos y Nombres" required />
              </div>
              <div class="form-group">
                <label class="form-label">Área Asignada</label>
                ${
                  isSup
                    ? `<input type="text" class="form-control" value="${STATE.user.nombre_area || "Mi Área"}" disabled />
                       <input type="hidden" id="emp-area" value="${STATE.user.id_area || ""}" />`
                    : `<select id="emp-area" class="form-control" required>
                        <option value="">-- Seleccione Área --</option>
                        ${STATE.areas
                          .map((a) => `<option value="${a.id}" ${String(d.id_area || "") === String(a.id) ? "selected" : ""}>${a.nombre}</option>`)
                          .join("")}
                      </select>`
                }
              </div>
              <div class="grid-2">
                <div class="form-group">
                  <label class="form-label">Cargo / Puesto</label>
                  <input type="text" id="emp-cargo" class="form-control" value="${d.cargo || "Operario"}" />
                </div>
                <div class="form-group">
                  <label class="form-label">PIN App Móvil</label>
                  <input type="text" id="emp-pin" class="form-control" value="${d.pin || "1234"}" required />
                </div>
              </div>
            </div>
            <div class="drawer-footer">
              <button type="button" class="btn btn-outline" id="btn-cancel-drawer">Cancelar</button>
              <button type="submit" class="btn btn-primary">${icon("save", 16)} ${isEdit ? "Actualizar Empleado" : "Guardar Empleado"}</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  if (STATE.activeDrawer === "importar_empleados") {
    const isSup = STATE.user?.role === "supervisor";
    return `
      <div class="drawer-backdrop" id="drawer-backdrop">
        <div class="drawer-panel">
          <div class="drawer-header">
            <div class="drawer-title">${icon("file-spreadsheet", 18)} <span>Importar Empleados desde Excel</span></div>
            <button type="button" class="icon-btn" id="btn-close-drawer">${icon("x", 16)}</button>
          </div>
          <div class="drawer-body">
            <p style="font-size:0.86rem; color:var(--texto-sec); margin-bottom:14px;">
              Sube un archivo Excel (.xlsx / .xls) con columnas: <code>ID | Nombre | Cargo | PIN</code>${isSup ? ` (todos se asignarán automáticamente a tu área: <strong>${STATE.user.nombre_area}</strong>).` : ` (y opcionalmente <code>Área</code>).`}
            </p>
            <div class="form-group">
              <label class="form-label">${isSup ? "Área Asignada (Tu Área)" : "Área por defecto (si el Excel no incluye columna Área)"}</label>
              ${
                isSup
                  ? `<input type="text" class="form-control" value="${STATE.user.nombre_area || "Mi Área"}" disabled />
                     <input type="hidden" id="import-emp-area-default" value="${STATE.user.id_area || ""}" />`
                  : `<select id="import-emp-area-default" class="form-control">
                      <option value="">-- Detectar columna Área del Excel --</option>
                      ${STATE.areas.map((a) => `<option value="${a.id}">${a.nombre}</option>`).join("")}
                    </select>`
              }
            </div>
            <div id="emp-dropzone" class="dropzone-box" style="padding:28px 18px;">
              <div style="margin-bottom:8px; color:var(--petroleo);">${icon("upload-cloud", 34)}</div>
              <div style="font-weight:700; color:var(--petroleo); font-size:0.92rem;">
                Arrastra el Excel aquí o haz clic para seleccionar
              </div>
              <div style="font-size:0.78rem; color:var(--texto-sec); margin-top:4px;">Formatos soportados: .xlsx, .xls</div>
              <input type="file" id="import-emp-excel" accept=".xlsx,.xls" style="display:none;" />
            </div>
          </div>
          <div class="drawer-footer">
            <button type="button" class="btn btn-outline" id="btn-cancel-drawer">Cerrar</button>
          </div>
        </div>
      </div>
    `;
  }

  if (STATE.activeDrawer === "festivo") {
    return `
      <div class="drawer-backdrop" id="drawer-backdrop">
        <div class="drawer-panel">
          <div class="drawer-header">
            <div class="drawer-title">${icon("calendar-plus", 18)} <span>Registrar Día Festivo</span></div>
            <button type="button" class="icon-btn" id="btn-close-drawer">${icon("x", 16)}</button>
          </div>
          <form id="form-festivo" style="display:flex; flex-direction:column; flex:1; min-height:0;">
            <div class="drawer-body">
              <div class="form-group">
                <label class="form-label">Fecha Festiva</label>
                <input type="date" id="festivo-fecha" class="form-control" required />
              </div>
              <div class="form-group">
                <label class="form-label">Descripción / Celebración</label>
                <input type="text" id="festivo-desc" class="form-control" placeholder="Ej: Día del Trabajo" required />
              </div>
            </div>
            <div class="drawer-footer">
              <button type="button" class="btn btn-outline" id="btn-cancel-drawer">Cancelar</button>
              <button type="submit" class="btn btn-primary">${icon("save", 16)} Guardar Festivo</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  if (STATE.activeDrawer === "turno") {
    const isEdit = Boolean(d.id);
    const isSup = STATE.user?.role === "supervisor";
    return `
      <div class="drawer-backdrop" id="drawer-backdrop">
        <div class="drawer-panel">
          <div class="drawer-header">
            <div class="drawer-title">${icon("clock", 18)} <span>${isEdit ? "Editar Turno" : "Nuevo Turno"}</span></div>
            <button type="button" class="icon-btn" id="btn-close-drawer">${icon("x", 16)}</button>
          </div>
          <form id="form-turno" style="display:flex; flex-direction:column; flex:1; min-height:0;">
            <div class="drawer-body">
              <input type="hidden" id="turno-id" value="${d.id || ""}" />
              <div class="form-group">
                <label class="form-label">Nombre del Turno</label>
                <input type="text" id="turno-nombre" class="form-control" value="${d.nombre || ""}" placeholder="Ej: Turno Mañana 06 a 14" required />
              </div>
              <div class="form-group">
                <label class="form-label">Área del Turno</label>
                ${
                  isSup
                    ? `<input type="text" class="form-control" value="${STATE.user.nombre_area || ""}" disabled />
                       <input type="hidden" id="turno-area" value="${STATE.user.id_area || ""}" />`
                    : `<select id="turno-area" class="form-control">
                        <option value="">-- Global (Todas las Áreas) --</option>
                        ${STATE.areas
                          .map((a) => `<option value="${a.id}" ${String(d.id_area || "") === String(a.id) ? "selected" : ""}>${a.nombre}</option>`)
                          .join("")}
                      </select>`
                }
              </div>
              <div class="grid-2">
                <div class="form-group">
                  <label class="form-label">Hora Entrada (24h)</label>
                  <input type="time" id="turno-entrada" class="form-control" value="${d.hora_entrada || "06:00"}" required />
                </div>
                <div class="form-group">
                  <label class="form-label">Hora Salida (24h)</label>
                  <input type="time" id="turno-salida" class="form-control" value="${d.hora_salida || "14:00"}" required />
                </div>
              </div>
              <div class="grid-2">
                <div class="form-group">
                  <label class="form-label">Tolerancia tarde (min)</label>
                  <input type="number" id="turno-tolerancia" class="form-control" value="${d.tolerancia_min ?? 10}" min="0" />
                </div>
                <div class="form-group">
                  <label class="form-label">Descanso intermedio (min)</label>
                  <input type="number" id="turno-descanso" class="form-control" value="${d.descanso_min ?? 0}" min="0" />
                </div>
              </div>
            </div>
            <div class="drawer-footer">
              <button type="button" class="btn btn-outline" id="btn-cancel-drawer">Cancelar</button>
              <button type="submit" class="btn btn-primary">${icon("save", 16)} ${isEdit ? "Actualizar Turno" : "Guardar Turno"}</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  if (STATE.activeDrawer === "comunicado") {
    return `
      <div class="drawer-backdrop" id="drawer-backdrop">
        <div class="drawer-panel">
          <div class="drawer-header">
            <div class="drawer-title">${icon("megaphone", 18)} <span>Nuevo Memorando / Capacitación</span></div>
            <button type="button" class="icon-btn" id="btn-close-drawer">${icon("x", 16)}</button>
          </div>
          <form id="form-comunicado" style="display:flex; flex-direction:column; flex:1; min-height:0;">
            <div class="drawer-body">
              <div class="form-group">
                <label class="form-label">Tipo de Comunicado</label>
                <select id="com-tipo" class="form-control">
                  <option value="CAPACITACIÓN">Citación a Capacitación</option>
                  <option value="MEMORANDO">Memorando Oficial</option>
                  <option value="COMUNICADO RRHH">Comunicado General RRHH</option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">Fecha/Hora del Evento (Opcional)</label>
                <input type="text" id="com-fecha" class="form-control" placeholder="Ej: Viernes 27 Nov - 2:00 PM" />
              </div>
              <div class="form-group">
                <label class="form-label">Dirigido a</label>
                <select id="com-destino-tipo" class="form-control">
                  <option value="TODOS">Toda la Empresa</option>
                  <option value="AREA">Un Área Específica</option>
                  <option value="EMPLEADO">Un Empleado Específico</option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">Seleccionar Área o Empleado (si aplica)</label>
                <select id="com-destino-valor" class="form-control">
                  <option value="">-- Toda la Empresa --</option>
                  <optgroup label="Áreas">
                    ${STATE.areas.map((a) => `<option value="AREA:${a.id}">Área: ${a.nombre}</option>`).join("")}
                  </optgroup>
                  <optgroup label="Empleados">
                    ${STATE.empleados.map((e) => `<option value="EMP:${e.id_empleado}">${e.id_empleado} - ${e.nombre}</option>`).join("")}
                  </optgroup>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">Título / Asunto</label>
                <input type="text" id="com-titulo" class="form-control" placeholder="Ej: Capacitación en Seguridad y Salud en el Trabajo" required />
              </div>
              <div class="form-group">
                <label class="form-label">Mensaje Detallado</label>
                <textarea id="com-mensaje" class="form-control" rows="4" placeholder="Escribe los detalles del memorando o capacitación..." required></textarea>
              </div>
            </div>
            <div class="drawer-footer">
              <button type="button" class="btn btn-outline" id="btn-cancel-drawer">Cancelar</button>
              <button type="submit" class="btn btn-primary">${icon("send", 15)} Enviar y Notificar</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  if (STATE.activeDrawer === "emp_solicitud") {
    const today = new Date().toISOString().slice(0, 10);
    return `
      <div class="drawer-backdrop" id="drawer-backdrop">
        <div class="drawer-panel">
          <div class="drawer-header">
            <div class="drawer-title">${icon("file-plus", 18)} <span>Nueva Solicitud de Permiso</span></div>
            <button type="button" class="icon-btn" id="btn-close-drawer">${icon("x", 16)}</button>
          </div>
          <form id="form-emp-solicitud" style="display:flex; flex-direction:column; flex:1; min-height:0;">
            <div class="drawer-body">
              <div class="form-group">
                <label class="form-label">Tipo de Solicitud</label>
                <select id="sol-tipo" class="form-control">
                  <option value="PERMISO MÉDICO / PERSONAL">Permiso Médico / Personal</option>
                  <option value="CAMBIO DE TURNO">Cambio de Turno</option>
                  <option value="OLVIDO DE MARCACIÓN">Justificación de Marcación</option>
                  <option value="VACACIONES / LICENCIA">Vacaciones / Licencia</option>
                </select>
              </div>
              <div class="grid-2">
                <div class="form-group">
                  <label class="form-label">Desde Fecha</label>
                  <input type="date" id="sol-inicio" class="form-control" value="${today}" required />
                </div>
                <div class="form-group">
                  <label class="form-label">Hasta Fecha</label>
                  <input type="date" id="sol-fin" class="form-control" value="${today}" required />
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">Motivo o Explicación</label>
                <textarea id="sol-motivo" class="form-control" rows="4" placeholder="Describe tu solicitud (la revisará tu Supervisor y luego Talento Humano)..." required></textarea>
              </div>
            </div>
            <div class="drawer-footer">
              <button type="button" class="btn btn-outline" id="btn-cancel-drawer">Cancelar</button>
              <button type="submit" class="btn btn-primary">${icon("send", 15)} Enviar Solicitud</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  if (STATE.activeDrawer === "mobile_menu") {
    const role = STATE.user?.role || "";
    const items = role === "empleado" ? EMP_NAV : getMenuForRole(role);
    return `
      <div class="drawer-backdrop" id="drawer-backdrop">
        <div class="drawer-panel">
          <div class="drawer-header">
            <div class="drawer-title">${icon("menu", 18)} <span>Menú — ${STATE.user?.nombre || "Usuario"}</span></div>
            <button type="button" class="icon-btn" id="btn-close-drawer">${icon("x", 16)}</button>
          </div>
          <div class="drawer-body">
            <div class="mobile-menu-list">
              ${items
                .map(
                  (item) => `
                <button type="button" class="mobile-menu-item ${STATE.activeView === item.id ? "active" : ""}" data-mobile-view="${item.id}">
                  ${icon(item.lucide || "circle", 18)}
                  <span>${item.label}</span>
                </button>
              `
                )
                .join("")}
            </div>
          </div>
          <div class="drawer-footer">
            <button type="button" id="btn-mobile-drawer-logout" class="btn btn-danger btn-block">
              ${icon("log-out", 16)} Cerrar Sesión
            </button>
          </div>
        </div>
      </div>
    `;
  }

  return "";
}

// ============================================================================
// 1. VISTA SUPERADMIN: ÁREAS Y USUARIOS (TABS + TABLA ANCHO COMPLETO + DRAWER)
// ============================================================================

function renderSuperadminAreasYUsuarios() {
  const tab = STATE.superadminTab || "usuarios";
  const totalSupervisores = STATE.usuarios.filter((u) => u.rol === "supervisor").length;

  const qUsr = (STATE.searchUsuarios || "").toLowerCase();
  const usuariosFiltrados = STATE.usuarios.filter(
    (u) =>
      u.username.toLowerCase().includes(qUsr) ||
      u.nombre.toLowerCase().includes(qUsr) ||
      (u.nombre_area || "").toLowerCase().includes(qUsr) ||
      u.rol.toLowerCase().includes(qUsr)
  );

  const roleBadges = {
    superadmin: `<span class="badge badge-danger">${icon("shield-check", 13)} Superadmin</span>`,
    admin: `<span class="badge badge-info">${icon("layout-dashboard", 13)} Admin General</span>`,
    supervisor: `<span class="badge badge-ok">${icon("user-check", 13)} Supervisor</span>`,
    auditor: `<span class="badge badge-warn">${icon("file-check-2", 13)} Auditor H.E.</span>`,
    talento_humano: `<span class="badge badge-info">${icon("users", 13)} Talento Humano</span>`
  };

  return `
    <div class="corp-kpi-strip">
      <div class="corp-kpi-mini">
        <div class="corp-kpi-mini-icon">${icon("building-2", 19)}</div>
        <div>
          <div class="corp-kpi-mini-label">Áreas Activas</div>
          <div class="corp-kpi-mini-val">${STATE.areas.length}</div>
        </div>
      </div>
      <div class="corp-kpi-mini">
        <div class="corp-kpi-mini-icon">${icon("users", 19)}</div>
        <div>
          <div class="corp-kpi-mini-label">Usuarios del Sistema</div>
          <div class="corp-kpi-mini-val">${STATE.usuarios.length}</div>
        </div>
      </div>
      <div class="corp-kpi-mini">
        <div class="corp-kpi-mini-icon">${icon("user-check", 19)}</div>
        <div>
          <div class="corp-kpi-mini-label">Supervisores de Área</div>
          <div class="corp-kpi-mini-val">${totalSupervisores}</div>
        </div>
      </div>
      <div class="corp-kpi-mini">
        <div class="corp-kpi-mini-icon">${icon("id-card", 19)}</div>
        <div>
          <div class="corp-kpi-mini-label">Empleados Registrados</div>
          <div class="corp-kpi-mini-val">${STATE.empleados.length}</div>
        </div>
      </div>
    </div>

    <div class="corp-tabs-bar">
      <div class="corp-tabs">
        <button type="button" class="corp-tab ${tab === "usuarios" ? "active" : ""}" data-sa-tab="usuarios">
          ${icon("users", 16)} Usuarios y Roles <span class="corp-tab-count">${STATE.usuarios.length}</span>
        </button>
        <button type="button" class="corp-tab ${tab === "areas" ? "active" : ""}" data-sa-tab="areas">
          ${icon("building-2", 16)} Áreas de la Empresa <span class="corp-tab-count">${STATE.areas.length}</span>
        </button>
      </div>
      <div style="padding-bottom:8px;">
        ${
          tab === "usuarios"
            ? `<button type="button" class="btn btn-primary btn-sm" id="btn-open-new-usr">${icon("user-plus", 15)} Nuevo Usuario</button>`
            : `<button type="button" class="btn btn-primary btn-sm" id="btn-open-new-area">${icon("plus", 15)} Nueva Área</button>`
        }
      </div>
    </div>

    ${
      tab === "usuarios"
        ? `
      <div class="corp-toolbar">
        <div class="corp-toolbar-left">
          <div class="corp-search-box">
            ${icon("search", 16)}
            <input type="text" id="search-usuarios-table" class="form-control" placeholder="Buscar por usuario, nombre, rol o área..." value="${STATE.searchUsuarios || ""}" />
          </div>
        </div>
        <div class="corp-toolbar-right">
          <span style="font-size:0.8rem; color:var(--texto-sec); font-weight:600;">Mostrando ${usuariosFiltrados.length} de ${STATE.usuarios.length}</span>
        </div>
      </div>

      <div class="corp-table-card">
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Usuario</th>
                <th>Nombre Completo</th>
                <th>Rol Asignado</th>
                <th>Área Ligada</th>
                <th style="width:110px; text-align:right;">Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${
                usuariosFiltrados.length === 0
                  ? `<tr><td colspan="5" style="text-align:center; padding:28px; color:var(--texto-sec);">No se encontraron usuarios.</td></tr>`
                  : usuariosFiltrados
                      .map(
                        (u) => `
                <tr>
                  <td><strong>${u.username}</strong></td>
                  <td>${u.nombre}</td>
                  <td>${roleBadges[u.rol] || u.rol}</td>
                  <td>${u.nombre_area ? `<span class="badge badge-info">${u.nombre_area}</span>` : `<span style="color:var(--texto-sec); font-size:0.82rem;">Global</span>`}</td>
                  <td style="text-align:right;">
                    <div class="row-actions">
                      <button type="button" class="icon-btn btn-edit-usr" data-user="${u.username}" title="Editar usuario">${icon("pencil", 15)}</button>
                      <button type="button" class="icon-btn icon-btn-danger btn-del-usr" data-user="${u.username}" title="Eliminar usuario">${icon("trash-2", 15)}</button>
                    </div>
                  </td>
                </tr>
              `
                      )
                      .join("")
              }
            </tbody>
          </table>
        </div>
      </div>
    `
        : `
      <div class="corp-table-card">
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Nombre del Área</th>
                <th>Descripción</th>
                <th>Supervisores</th>
                <th>Empleados</th>
                <th style="width:110px; text-align:right;">Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${
                STATE.areas.length === 0
                  ? `<tr><td colspan="5" style="text-align:center; padding:28px; color:var(--texto-sec);">No hay áreas creadas.</td></tr>`
                  : STATE.areas
                      .map(
                        (a) => `
                <tr>
                  <td><strong>${a.nombre}</strong></td>
                  <td style="color:var(--texto-sec);">${a.descripcion || "—"}</td>
                  <td><span class="badge badge-info">${a.total_supervisores} sup.</span></td>
                  <td><span class="badge badge-ok">${a.total_empleados} emp.</span></td>
                  <td style="text-align:right;">
                    <div class="row-actions">
                      <button type="button" class="icon-btn btn-edit-area" data-id="${a.id}" data-nombre="${a.nombre}" data-desc="${a.descripcion || ""}" title="Editar área">${icon("pencil", 15)}</button>
                      <button type="button" class="icon-btn icon-btn-danger btn-del-area" data-id="${a.id}" title="Eliminar área">${icon("trash-2", 15)}</button>
                    </div>
                  </td>
                </tr>
              `
                      )
                      .join("")
              }
            </tbody>
          </table>
        </div>
      </div>
    `
    }
  `;
}

// ============================================================================
// 2. VISTA ADMIN GENERAL: SUPERVISORES, ÁREAS Y EMPLEADOS (TABS + TABLAS)
// ============================================================================

function renderAdminGeneralEstructura() {
  const supervisores = STATE.usuarios.filter((u) => u.rol === "supervisor");
  const tab = STATE.adminEstructuraTab || "supervisores";
  const qEmp = (STATE.searchEmpleados || "").toLowerCase();
  const empleadosFiltrados = STATE.empleados.filter(
    (e) =>
      e.id_empleado.toLowerCase().includes(qEmp) ||
      e.nombre.toLowerCase().includes(qEmp) ||
      (e.nombre_area || "").toLowerCase().includes(qEmp)
  );

  return `
    <div class="corp-tabs-bar">
      <div class="corp-tabs">
        <button type="button" class="corp-tab ${tab === "supervisores" ? "active" : ""}" data-est-tab="supervisores">
          ${icon("user-check", 16)} Supervisores <span class="corp-tab-count">${supervisores.length}</span>
        </button>
        <button type="button" class="corp-tab ${tab === "areas" ? "active" : ""}" data-est-tab="areas">
          ${icon("building-2", 16)} Áreas <span class="corp-tab-count">${STATE.areas.length}</span>
        </button>
        <button type="button" class="corp-tab ${tab === "empleados" ? "active" : ""}" data-est-tab="empleados">
          ${icon("users", 16)} Plantilla de Empleados <span class="corp-tab-count">${STATE.empleados.length}</span>
        </button>
      </div>
    </div>

    ${
      tab === "supervisores"
        ? `
      <div class="corp-table-card">
        <div class="table-responsive" style="max-height:calc(100vh - 210px);">
          <table>
            <thead>
              <tr>
                <th>Nombre del Supervisor</th>
                <th>Usuario</th>
                <th>Área Asignada</th>
              </tr>
            </thead>
            <tbody>
              ${
                supervisores.length === 0
                  ? `<tr><td colspan="3" style="text-align:center; padding:28px; color:var(--texto-sec);">No hay supervisores registrados aún.</td></tr>`
                  : supervisores
                      .map(
                        (s) => `
                  <tr>
                    <td><strong>${s.nombre}</strong></td>
                    <td><code>${s.username}</code></td>
                    <td><span class="badge badge-ok">${s.nombre_area || "Sin Área"}</span></td>
                  </tr>
                `
                      )
                      .join("")
              }
            </tbody>
          </table>
        </div>
      </div>
    `
        : tab === "areas"
        ? `
      <div class="corp-table-card">
        <div class="table-responsive" style="max-height:calc(100vh - 210px);">
          <table>
            <thead>
              <tr>
                <th>Área</th>
                <th>Descripción</th>
                <th>Supervisores</th>
                <th>Empleados</th>
              </tr>
            </thead>
            <tbody>
              ${STATE.areas
                .map(
                  (a) => `
                <tr>
                  <td><strong>${a.nombre}</strong></td>
                  <td style="color:var(--texto-sec);">${a.descripcion || "—"}</td>
                  <td><span class="badge badge-info">${a.total_supervisores} sup.</span></td>
                  <td><span class="badge badge-ok">${a.total_empleados} emp.</span></td>
                </tr>
              `
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    `
        : `
      <div class="corp-toolbar">
        <div class="corp-toolbar-left">
          <div class="corp-search-box">
            ${icon("search", 16)}
            <input type="text" id="search-empleados-table" class="form-control" placeholder="Buscar empleado por ID, nombre o área..." value="${STATE.searchEmpleados || ""}" />
          </div>
        </div>
      </div>
      <div class="corp-table-card">
        <div class="table-responsive" style="max-height:calc(100vh - 260px);">
          <table>
            <thead>
              <tr>
                <th>ID Biométrico</th>
                <th>Nombre Completo</th>
                <th>Área Asignada</th>
                <th>Cargo</th>
              </tr>
            </thead>
            <tbody>
              ${empleadosFiltrados
                .map(
                  (e) => `
                <tr>
                  <td><strong>${e.id_empleado}</strong></td>
                  <td>${e.nombre}</td>
                  <td><span class="badge badge-info">${e.nombre_area || "Sin Área"}</span></td>
                  <td>${e.cargo || "Operario"}</td>
                </tr>
              `
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    `
    }
  `;
}

// ============================================================================
// 3. VISTA TALENTO HUMANO: TABS (PERMISOS | MEMORANDOS) + DRAWER DE ENVÍO
// ============================================================================

function renderTalentoHumanoCentro() {
  const tab = STATE.rrhhTab || "permisos";
  const pendientesRRHH = STATE.solicitudes.filter((s) => s.estado === "AVALADO_SUPERVISOR" || s.estado === "PENDIENTE_SUPERVISOR").length;

  return `
    <div class="corp-tabs-bar">
      <div class="corp-tabs">
        <button type="button" class="corp-tab ${tab === "permisos" ? "active" : ""}" data-rrhh-tab="permisos">
          ${icon("file-check-2", 16)} Permisos y Solicitudes <span class="corp-tab-count">${pendientesRRHH} pend.</span>
        </button>
        <button type="button" class="corp-tab ${tab === "comunicados" ? "active" : ""}" data-rrhh-tab="comunicados">
          ${icon("megaphone", 16)} Memorandos y Capacitaciones <span class="corp-tab-count">${STATE.comunicados.length}</span>
        </button>
      </div>
      <div style="padding-bottom:8px; display:flex; gap:8px;">
        ${
          tab === "permisos"
            ? `<button type="button" id="btn-exportar-permisos" class="btn btn-outline btn-sm">${icon("download", 15)} Exportar Excel Permisos</button>`
            : `<button type="button" id="btn-open-new-comunicado" class="btn btn-primary btn-sm">${icon("send", 15)} Nuevo Memorando / Citación</button>`
        }
      </div>
    </div>

    ${
      tab === "permisos"
        ? `
      <div class="corp-table-card">
        <div class="table-responsive" style="max-height:calc(100vh - 210px);">
          <table>
            <thead>
              <tr>
                <th>Empleado / Área</th>
                <th>Tipo / Fechas</th>
                <th>Motivo</th>
                <th>Aval Supervisor</th>
                <th>Estado</th>
                <th style="text-align:right;">Decisión RRHH</th>
              </tr>
            </thead>
            <tbody>
              ${
                STATE.solicitudes.length === 0
                  ? `<tr><td colspan="6" style="text-align:center; padding:28px; color:var(--texto-sec);">No hay solicitudes de permisos registradas.</td></tr>`
                  : STATE.solicitudes
                      .map((s) => {
                        let badge = "badge-warn";
                        if (s.estado === "APROBADA") badge = "badge-ok";
                        else if (s.estado.includes("RECHAZADA")) badge = "badge-danger";
                        else if (s.estado === "AVALADO_SUPERVISOR") badge = "badge-info";
                        return `
                    <tr>
                      <td>
                        <strong>${s.nombre_empleado}</strong> <small style="color:var(--texto-sec);">(${s.id_empleado})</small><br/>
                        <span class="badge badge-info">${s.nombre_area || "Sin Área"}</span>
                      </td>
                      <td><strong>${s.tipo}</strong><br/><small style="color:var(--texto-sec);">${s.fecha_inicio} a ${s.fecha_fin}</small></td>
                      <td>${s.motivo}</td>
                      <td><small>${s.supervisor_usuario ? `${icon("check", 13)} ${s.supervisor_usuario}` : "Pendiente Supervisor"}</small></td>
                      <td><span class="badge ${badge}">${s.estado}</span></td>
                      <td style="text-align:right;">
                        ${
                          s.estado !== "APROBADA" && !s.estado.includes("RECHAZADA")
                            ? `
                          <div class="row-actions">
                            <button type="button" class="btn btn-primary btn-sm btn-resp-sol" data-id="${s.id}" data-estado="APROBADA">${icon("check", 14)} Aprobar</button>
                            <button type="button" class="icon-btn icon-btn-danger btn-resp-sol" data-id="${s.id}" data-estado="RECHAZADA" title="Rechazar">${icon("x", 15)}</button>
                          </div>
                        `
                            : `<small style="color:var(--texto-sec);">${s.rrhh_usuario || s.respuesta_admin || "Cerrada"}</small>`
                        }
                      </td>
                    </tr>
                  `;
                      })
                      .join("")
              }
            </tbody>
          </table>
        </div>
      </div>
    `
        : `
      <div class="corp-table-card">
        <div class="table-responsive" style="max-height:calc(100vh - 210px);">
          <table>
            <thead>
              <tr>
                <th>Tipo / Fecha</th>
                <th>Asunto y Mensaje</th>
                <th>Destinatario</th>
                <th style="text-align:right;">Confirmaciones</th>
              </tr>
            </thead>
            <tbody>
              ${
                STATE.comunicados.length === 0
                  ? `<tr><td colspan="4" style="text-align:center; padding:28px; color:var(--texto-sec);">Aún no se han enviado memorandos ni capacitaciones. Pulsa "Nuevo Memorando / Citación".</td></tr>`
                  : STATE.comunicados
                      .map(
                        (c) => `
                  <tr>
                    <td>
                      <span class="badge badge-info">${c.tipo}</span><br/>
                      <small style="color:var(--texto-sec);">${c.creado_en}</small>
                    </td>
                    <td>
                      <strong>${c.titulo}</strong>
                      ${c.fecha_evento ? `<br/><small style="color:var(--naranja); font-weight:700;">${icon("calendar", 12)} ${c.fecha_evento}</small>` : ""}
                      <br/><small style="color:var(--texto-sec);">${c.mensaje}</small>
                    </td>
                    <td><span class="badge badge-ok">${c.destino_etiqueta}</span></td>
                    <td style="text-align:right;"><strong>${c.total_lecturas}</strong> <small style="color:var(--texto-sec);">leído(s)</small></td>
                  </tr>
                `
                      )
                      .join("")
              }
            </tbody>
          </table>
        </div>
      </div>
    `
    }
  `;
}

// --- VISTA: DASHBOARD EJECUTIVO ---
function renderAdminDashboard() {
  const d = STATE.dashboard || {
    total_empleados: STATE.empleados.length,
    total_turnos: STATE.turnos.length,
    ultima_fecha_asignada: null,
    mensaje_alerta: "Cargando resumen...",
    nivel_alerta: "ok",
    kpis: { horas_extra: 0, minutos_tardanza: 0, ausencias: 0, llegadas_tempranas: 0 },
    solicitudes_pendientes: 0
  };
  const isReadOnlyAdmin = STATE.user?.role === "admin";

  return `
    <div class="alert-banner alert-${d.nivel_alerta || "ok"}">
      <div>
        <strong>${icon("activity", 16)} Estado de Programación:</strong> ${d.mensaje_alerta}
      </div>
      ${
        !isReadOnlyAdmin
          ? `<button type="button" class="btn btn-primary btn-sm" data-goto="asignacion">${icon("calendar-range", 15)} Programar Turnos →</button>`
          : `<button type="button" class="btn btn-primary btn-sm" data-goto="analisis">${icon("bar-chart-3", 15)} Ver Métricas y Reportes →</button>`
      }
    </div>

    <div class="grid-4" style="margin-bottom:20px;">
      <div class="kpi-card" data-goto="${isReadOnlyAdmin ? "supervisores_empleados" : "empleados"}">
        <div class="kpi-top">
          <div class="kpi-label">Empleados Activos / Áreas</div>
          <div class="kpi-icon-box">${icon("users", 20)}</div>
        </div>
        <div class="kpi-value">${d.total_empleados} / ${STATE.areas.length}</div>
      </div>
      <div class="kpi-card" data-goto="analisis">
        <div class="kpi-top">
          <div class="kpi-label">Total Horas Extras</div>
          <div class="kpi-icon-box">${icon("clock", 20)}</div>
        </div>
        <div class="kpi-value">${Number(d.kpis?.horas_extra || 0).toFixed(2)} h</div>
      </div>
      <div class="kpi-card" data-goto="analisis">
        <div class="kpi-top">
          <div class="kpi-label">Ausencias / Tardanzas</div>
          <div class="kpi-icon-box">${icon("alert-triangle", 20)}</div>
        </div>
        <div class="kpi-value">${d.kpis?.ausencias || 0} / ${d.kpis?.minutos_tardanza || 0}m</div>
      </div>
      <div class="kpi-card" data-goto="gps_solicitudes">
        <div class="kpi-top">
          <div class="kpi-label">Marcas GPS / Permisos</div>
          <div class="kpi-icon-box">${icon("map-pin", 20)}</div>
        </div>
        <div class="kpi-value">${STATE.marcacionesMoviles.length} / ${STATE.solicitudes.length}</div>
      </div>
    </div>

    <div class="grid-2" style="margin-bottom:20px;">
      <div class="card" style="margin-bottom:0;">
        <div class="card-header">
          <div class="card-title">${icon("bar-chart-3", 18)} <span>Distribución Global de Horas Extra y Recargos</span></div>
        </div>
        <div style="height:230px; position:relative;">
          <canvas id="chart-recargos"></canvas>
        </div>
      </div>
      <div class="card" style="margin-bottom:0;">
        <div class="card-header">
          <div class="card-title">${icon("pie-chart", 18)} <span>Comportamiento Global de Asistencia</span></div>
        </div>
        <div style="height:230px; position:relative;">
          <canvas id="chart-estados"></canvas>
        </div>
      </div>
    </div>
  `;
}

// --- VISTA 1: CATÁLOGO DE TURNOS (TABLA ANCHO COMPLETO + DRAWER) ---
function renderAdminTurnos() {
  const qTurno = (STATE.searchTurnos || "").toLowerCase();
  const turnosFiltrados = STATE.turnos.filter(
    (t) =>
      t.nombre.toLowerCase().includes(qTurno) ||
      (t.nombre_area || "Global").toLowerCase().includes(qTurno) ||
      `${t.hora_entrada} ${t.hora_salida}`.includes(qTurno)
  );
  const diurnos = STATE.turnos.filter((t) => !t.cruza_medianoche).length;
  const nocturnos = STATE.turnos.filter((t) => t.cruza_medianoche).length;

  return `
    <div class="corp-kpi-strip" style="grid-template-columns: repeat(3, 1fr);">
      <div class="corp-kpi-mini">
        <div class="corp-kpi-mini-icon">${icon("clock", 19)}</div>
        <div>
          <div class="corp-kpi-mini-label">Turnos Configurados</div>
          <div class="corp-kpi-mini-val">${STATE.turnos.length}</div>
        </div>
      </div>
      <div class="corp-kpi-mini">
        <div class="corp-kpi-mini-icon">${icon("sun", 19)}</div>
        <div>
          <div class="corp-kpi-mini-label">Turnos Diurnos</div>
          <div class="corp-kpi-mini-val">${diurnos}</div>
        </div>
      </div>
      <div class="corp-kpi-mini">
        <div class="corp-kpi-mini-icon">${icon("moon", 19)}</div>
        <div>
          <div class="corp-kpi-mini-label">Turnos Nocturnos</div>
          <div class="corp-kpi-mini-val">${nocturnos}</div>
        </div>
      </div>
    </div>

    <div class="corp-toolbar">
      <div class="corp-toolbar-left">
        <div class="corp-search-box">
          ${icon("search", 16)}
          <input type="text" id="search-turnos-table" class="form-control" placeholder="Buscar turno por nombre, horario o área..." value="${STATE.searchTurnos || ""}" />
        </div>
      </div>
      <div class="corp-toolbar-right">
        <button type="button" id="btn-open-new-turno" class="btn btn-primary btn-sm">
          ${icon("plus", 15)} Nuevo Turno
        </button>
      </div>
    </div>

    <div class="corp-table-card">
      <div class="table-responsive" style="max-height:calc(100vh - 280px);">
        <table>
          <thead>
            <tr>
              <th>Nombre del Turno</th>
              <th>Área</th>
              <th>Horario</th>
              <th>Tolerancia</th>
              <th>Descanso</th>
              <th>Tipo</th>
              <th style="width:110px; text-align:right;">Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${
              turnosFiltrados.length === 0
                ? `<tr><td colspan="7" style="text-align:center; padding:28px; color:var(--texto-sec);">No hay turnos configurados. Pulsa "Nuevo Turno" para crear uno.</td></tr>`
                : turnosFiltrados
                    .map((t) => {
                      const color = getShiftColor(t.id);
                      return `
              <tr>
                <td>
                  <span style="display:inline-block; width:10px; height:10px; border-radius:3px; background:${color}; margin-right:8px;"></span>
                  <strong>${t.nombre}</strong>
                </td>
                <td><span class="badge badge-info">${t.nombre_area || "Global"}</span></td>
                <td><strong>${t.hora_entrada}</strong> — <strong>${t.hora_salida}</strong></td>
                <td>${t.tolerancia_min ?? 10} min</td>
                <td>${t.descanso_min ?? 0} min</td>
                <td>${
                  t.cruza_medianoche
                    ? `<span class="badge badge-warn">${icon("moon", 13)} Nocturno</span>`
                    : `<span class="badge badge-ok">${icon("sun", 13)} Diurno</span>`
                }</td>
                <td style="text-align:right;">
                  <div class="row-actions">
                    <button type="button" class="icon-btn btn-edit-turno" data-id="${t.id}" title="Editar turno">${icon("pencil", 15)}</button>
                    <button type="button" class="icon-btn icon-btn-danger btn-del-turno" data-id="${t.id}" title="Eliminar turno">${icon("trash-2", 15)}</button>
                  </div>
                </td>
              </tr>
            `;
                    })
                    .join("")
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// --- VISTA 2: DÍAS FESTIVOS (TABLA ANCHO COMPLETO + DRAWER) ---
function renderAdminFestivos() {
  const currentYear = new Date().getFullYear();
  const qFest = (STATE.searchFestivos || "").toLowerCase();
  const festivosFiltrados = STATE.festivos.filter(
    (f) => f.fecha.toLowerCase().includes(qFest) || f.descripcion.toLowerCase().includes(qFest)
  );

  return `
    <div class="corp-toolbar">
      <div class="corp-toolbar-left">
        <div class="corp-search-box">
          ${icon("search", 16)}
          <input type="text" id="search-festivos-table" class="form-control" placeholder="Buscar festivo por fecha o nombre..." value="${STATE.searchFestivos || ""}" />
        </div>
      </div>
      <div class="corp-toolbar-right">
        <div style="display:flex; align-items:center; gap:6px;">
          <input type="number" id="festivo-anio-col" class="form-control" value="${currentYear}" min="2020" max="2035" style="width:92px; height:36px;" />
          <button type="button" id="btn-cargar-colombia" class="btn btn-outline btn-sm" style="white-space:nowrap;">
            ${icon("calendar-check-2", 15)} Cargar Colombia
          </button>
        </div>
        <button type="button" id="btn-open-new-festivo" class="btn btn-primary btn-sm">
          ${icon("calendar-plus", 15)} Nuevo Festivo
        </button>
      </div>
    </div>

    <div class="corp-table-card">
      <div class="table-responsive" style="max-height:calc(100vh - 210px);">
        <table>
          <thead>
            <tr>
              <th style="width:160px;">Fecha</th>
              <th>Descripción / Celebración</th>
              <th style="width:90px; text-align:right;">Acción</th>
            </tr>
          </thead>
          <tbody>
            ${
              festivosFiltrados.length === 0
                ? `<tr><td colspan="3" style="text-align:center; padding:28px; color:var(--texto-sec);">No hay festivos cargados. Pulsa "Cargar Colombia" o "Nuevo Festivo".</td></tr>`
                : festivosFiltrados
                    .map(
                      (f) => `
              <tr>
                <td><strong>${f.fecha}</strong></td>
                <td>${f.descripcion}</td>
                <td style="text-align:right;">
                  <button type="button" class="icon-btn icon-btn-danger btn-del-festivo" data-fecha="${f.fecha}" title="Eliminar festivo">
                    ${icon("trash-2", 15)}
                  </button>
                </td>
              </tr>
            `
                    )
                    .join("")
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// --- VISTA 3: ASIGNACIÓN DE TURNOS + MATRIZ GANTT ---
function renderAdminAsignacion() {
  const [year, month] = STATE.calMonth.split("-").map(Number);
  const firstDay = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const startWeekday = (firstDay.getDay() + 6) % 7;
  const festivosSet = new Set(STATE.festivos.map((f) => f.fecha));
  const isAuditor = STATE.user.role === "auditor";

  const modeSwitcher = `
    <div class="card" style="padding:14px 20px; margin-bottom:18px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
      <div style="display:flex; gap:10px;">
        <button type="button" class="btn ${STATE.asignacionModoVista === "calendario" ? "btn-primary" : "btn-outline"} btn-sm" data-asig-mode="calendario">
          🗓️ Calendario Interactivo & Patrones
        </button>
        <button type="button" class="btn ${STATE.asignacionModoVista === "matriz" ? "btn-primary" : "btn-outline"} btn-sm" data-asig-mode="matriz">
          📊 Matriz Gantt Mensual (${STATE.user.role === "supervisor" ? STATE.user.nombre_area : "Personal"})
        </button>
      </div>
      <div style="display:flex; gap:8px; align-items:center;">
        <label style="font-weight:700; font-size:0.86rem;">Mes:</label>
        <input type="month" id="cal-month-picker" class="form-control" value="${STATE.calMonth}" style="width:170px;" />
      </div>
    </div>
  `;

  if (STATE.asignacionModoVista === "matriz" || isAuditor) {
    const mapEmpFecha = {};
    STATE.asignaciones.forEach((a) => {
      if (!mapEmpFecha[a.id_empleado]) mapEmpFecha[a.id_empleado] = {};
      mapEmpFecha[a.id_empleado][a.fecha] = a;
    });
    const daysArray = Array.from({ length: daysInMonth }, (_, i) => i + 1);

    return `
      ${modeSwitcher}
      <div class="card">
        <div class="card-header">
          <div class="card-title">📊 Matriz Gantt de Turnos Asignados — ${STATE.calMonth}</div>
          <div style="display:flex; gap:10px; flex-wrap:wrap; font-size:0.78rem;">
            <span class="badge badge-ok">D = Descanso</span>
            ${STATE.turnos
              .slice(0, 6)
              .map(
                (t) =>
                  `<span class="badge" style="background:${getShiftColor(t.id)}; color:#fff;">${t.nombre.slice(0, 14)}</span>`
              )
              .join("")}
          </div>
        </div>
        <div class="table-responsive" style="max-height:600px;">
          <table class="gantt-table">
            <thead>
              <tr>
                <th style="position:sticky; left:0; z-index:10; min-width:220px;">Empleado (Área)</th>
                ${daysArray
                  .map((d) => {
                    const fIso = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
                    const isHol = festivosSet.has(fIso);
                    return `<th style="${isHol ? "background:#E64A19;" : ""}" title="${fIso}">${d}</th>`;
                  })
                  .join("")}
              </tr>
            </thead>
            <tbody>
              ${
                STATE.empleados.length === 0
                  ? `<tr><td colspan="${daysInMonth + 1}" style="padding:24px;">No hay empleados cargados en esta área.</td></tr>`
                  : STATE.empleados
                      .map((emp) => {
                        const rowMap = mapEmpFecha[emp.id_empleado] || {};
                        return `
                    <tr>
                      <td style="position:sticky; left:0; background:var(--superficie); text-align:left; font-weight:700; white-space:nowrap;">
                        ${emp.id_empleado} - ${emp.nombre.slice(0, 20)} <small style="color:var(--texto-sec);">(${emp.nombre_area || ""})</small>
                      </td>
                      ${daysArray
                        .map((d) => {
                          const fIso = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
                          const a = rowMap[fIso];
                          if (!a) return `<td><span style="color:var(--texto-sec); opacity:0.35;">·</span></td>`;
                          const bg = getShiftColor(a.id_turno, a.es_descanso);
                          const abbr = a.es_descanso
                            ? "D"
                            : a.nombre_turno
                                .split(" ")
                                .map((w) => w[0])
                                .join("")
                                .slice(0, 3)
                                .toUpperCase();
                          return `
                            <td title="${emp.nombre} | ${fIso}: ${a.nombre_turno} (${a.hora_entrada}-${a.hora_salida})">
                              <div class="gantt-cell" style="background:${bg}; color:#fff; display:flex; align-items:center; justify-content:center;">
                                ${abbr}
                              </div>
                            </td>
                          `;
                        })
                        .join("")}
                    </tr>
                  `;
                      })
                      .join("")
              }
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  const asigPorFecha = {};
  STATE.asignaciones.forEach((a) => {
    if (STATE.selectedEmployees.has(a.id_empleado)) {
      if (!asigPorFecha[a.fecha]) asigPorFecha[a.fecha] = [];
      asigPorFecha[a.fecha].push(a);
    }
  });

  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(`<div class="cal-day empty"></div>`);
  for (let d = 1; d <= daysInMonth; d++) {
    const fechaIso = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const isSelected = STATE.selectedDates.has(fechaIso);
    const isHoliday = festivosSet.has(fechaIso);
    const items = asigPorFecha[fechaIso] || [];
    let etiqueta = "";
    let isRest = false;
    let colorTurno = "";
    if (items.length > 0) {
      const nombres = [...new Set(items.map((x) => x.nombre_turno))];
      etiqueta = nombres.length === 1 ? nombres[0] : `Varios (${items.length})`;
      isRest = nombres.length === 1 && nombres[0] === "DESCANSO";
      colorTurno = getShiftColor(items[0].id_turno, isRest);
      if (STATE.selectedEmployees.size > 1) {
        etiqueta += ` [${items.length}/${STATE.selectedEmployees.size}]`;
      }
    }
    cells.push(`
      <div class="cal-day ${isSelected ? "selected" : ""} ${isHoliday ? "holiday" : ""}" data-date="${fechaIso}">
        <div class="cal-day-num">
          <span>${d}</span>
          ${isHoliday ? '<span title="Festivo" style="color:var(--naranja); font-size:0.75rem;">★ Festivo</span>' : ""}
        </div>
        ${
          etiqueta
            ? `<div class="cal-day-shift ${isRest ? "rest" : ""}" style="${
                !isRest && colorTurno ? `background:${colorTurno}; color:#fff;` : ""
              }">${etiqueta}</div>`
            : ""
        }
      </div>
    `);
  }

  const q = STATE.searchEmpAsignacion.toLowerCase();
  const empleadosFiltrados = STATE.empleados.filter(
    (e) => e.id_empleado.toLowerCase().includes(q) || e.nombre.toLowerCase().includes(q)
  );

  return `
    ${modeSwitcher}
    <div class="grid-2" style="grid-template-columns: 360px 1fr;">
      <div class="card">
        <div class="card-header">
          <div class="card-title">1. Empleados (${STATE.selectedEmployees.size} selec.)</div>
        </div>
        <div class="form-group">
          <input type="text" id="search-emp-asig" class="form-control" placeholder="🔍 Buscar por ID o nombre..." value="${STATE.searchEmpAsignacion}" />
        </div>
        <div style="display:flex; gap:8px; margin-bottom:10px;">
          <button type="button" id="btn-sel-all-emp" class="btn btn-outline btn-sm" style="flex:1;">Todos</button>
          <button type="button" id="btn-clear-emp" class="btn btn-outline btn-sm" style="flex:1;">Ninguno</button>
        </div>
        <div class="emp-list-box">
          ${
            empleadosFiltrados.length === 0
              ? `<div style="padding:18px; text-align:center; color:var(--texto-sec);">No hay empleados registrados en esta área.</div>`
              : empleadosFiltrados
                  .map((e) => {
                    const checked = STATE.selectedEmployees.has(e.id_empleado);
                    return `
                <div class="emp-item ${checked ? "selected" : ""}" data-emp="${e.id_empleado}">
                  <input type="checkbox" ${checked ? "checked" : ""} style="pointer-events:none;" />
                  <div>
                    <div style="font-weight:700;">${e.nombre}</div>
                    <div style="font-size:0.75rem; color:var(--texto-sec);">ID: ${e.id_empleado} | ${e.nombre_area || "Sin Área"}</div>
                  </div>
                </div>
              `;
                  })
                  .join("")
          }
        </div>
      </div>

      <div>
        <div class="card">
          <div class="card-header">
            <div class="card-title">2. Seleccione Días en el Calendario (${STATE.selectedDates.size} días seleccionados)</div>
            <button type="button" id="btn-clear-dates" class="btn btn-outline btn-sm">Limpiar Selección</button>
          </div>

          <div class="calendar-grid">
            ${["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]
              .map((d) => `<div class="cal-weekday">${d}</div>`)
              .join("")}
            ${cells.join("")}
          </div>

          <div style="margin-top:18px; padding-top:16px; border-top:1px solid var(--borde);">
            <div class="grid-3" style="align-items:end;">
              <div class="form-group" style="margin-bottom:0;">
                <label class="form-label">Plantilla de Turno a Asignar</label>
                <select id="asig-turno-select" class="form-control">
                  ${STATE.turnos
                    .filter((t) => t.activo)
                    .map(
                      (t) => `<option value="${t.id}">${t.nombre} (${t.hora_entrada} - ${t.hora_salida})</option>`
                    )
                    .join("")}
                </select>
              </div>
              <div class="form-group" style="margin-bottom:0;">
                <label class="form-label">Observaciones (opcional)</label>
                <input type="text" id="asig-obs" class="form-control" placeholder="Nota opcional..." />
              </div>
              <div style="display:flex; gap:8px; flex-wrap:wrap;">
                <button type="button" id="btn-asignar-turno" class="btn btn-primary" style="flex:1;">
                  ✅ Asignar Turno
                </button>
                <button type="button" id="btn-asignar-descanso" class="btn btn-action">
                  🏖️ Descanso
                </button>
                <button type="button" id="btn-eliminar-asig" class="btn btn-danger">
                  🗑️ Quitar
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <div class="card-title">⚡ Programación Rápida por Patrón Semanal</div>
          </div>
          <div class="grid-3">
            <div class="form-group">
              <label class="form-label">Fecha Inicio</label>
              <input type="date" id="pat-inicio" class="form-control" value="${STATE.calMonth}-01" />
            </div>
            <div class="form-group">
              <label class="form-label">Fecha Fin</label>
              <input type="date" id="pat-fin" class="form-control" value="${STATE.calMonth}-${String(daysInMonth).padStart(2, "0")}" />
            </div>
            <div class="form-group">
              <label class="form-label">Turno o Descanso</label>
              <select id="pat-turno" class="form-control">
                ${STATE.turnos
                  .filter((t) => t.activo)
                  .map((t) => `<option value="${t.id}">${t.nombre} (${t.hora_entrada}-${t.hora_salida})</option>`)
                  .join("")}
                <option value="DESCANSO">🏖️ DÍA DE DESCANSO</option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Días de la Semana a Aplicar</label>
            <div style="display:flex; gap:14px; flex-wrap:wrap; margin-top:4px;">
              ${["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]
                .map(
                  (d, idx) => `
                <label style="display:flex; align-items:center; gap:5px; font-weight:700; cursor:pointer;">
                  <input type="checkbox" class="pat-weekday" value="${idx}" ${idx < 5 ? "checked" : ""} /> ${d}
                </label>
              `
                )
                .join("")}
            </div>
          </div>
          <button type="button" id="btn-aplicar-patron" class="btn btn-primary">
            Aplicar Patrón a los ${STATE.selectedEmployees.size} Empleados Seleccionados
          </button>
        </div>
      </div>
    </div>
  `;
}

// ============================================================================
// 4. PROCESAR HUELLERO Y GENERAR REPORTES (TABS: VALIDAR HUELLERO | REPORTES)
// Disponible para: Supervisor (su Área), Auditor de Horas Extras (Todas) y Talento Humano (Administrativos o Todas)
// ============================================================================

function renderAdminProcesar() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();
  const prev = STATE.huelleroPreview;
  const isSup = STATE.user.role === "supervisor";
  const tab = STATE.procesarTab || "validar";

  const selectedArea = isSup ? String(STATE.user.id_area || "") : STATE.huelleroFiltroArea;
  const empleadosDelArea = STATE.empleados.filter(
    (e) => !selectedArea || String(e.id_area || "") === String(selectedArea)
  );

  return `
    <div class="corp-tabs-bar">
      <div class="corp-tabs">
        <button type="button" class="corp-tab ${tab === "validar" ? "active" : ""}" data-proc-tab="validar">
          ${icon("file-spreadsheet", 16)} Validar Huellero y Generar Reporte
        </button>
        <button type="button" class="corp-tab ${tab === "reportes" ? "active" : ""}" data-proc-tab="reportes">
          ${icon("folder-down", 16)} Reportes Excel Generados <span class="corp-tab-count">${STATE.reportes.length}</span>
        </button>
      </div>
    </div>

    ${
      tab === "validar"
        ? `
      <div class="card" style="max-width:880px;">
        <form id="form-procesar-huellero">
          <div id="huellero-dropzone" class="dropzone-box" style="padding:22px 18px; margin-bottom:16px;">
            <div style="margin-bottom:6px; color:var(--petroleo);">${icon("upload-cloud", 32)}</div>
            <div style="font-weight:700; font-size:0.95rem; color:var(--petroleo);">
              Arrastra y suelta aquí el Excel del Huellero (.xlsx / .xls) o haz clic para seleccionar
            </div>
            <div style="font-size:0.8rem; color:var(--texto-sec); margin-top:4px;">
              Se cruzarán las marcaciones biométricas contra los turnos programados del período
            </div>
            <input type="file" id="proc-files" accept=".xlsx,.xls" multiple style="display:none;" />
          </div>

          ${
            prev
              ? `
            <div class="alert-banner alert-ok" style="margin-bottom:16px;">
              <div>
                <strong>${icon("check-circle-2", 16)} Archivo cargado:</strong> ${prev.total_marcaciones} marcaciones detectadas (${prev.fecha_min || "—"} al ${prev.fecha_max || "—"}).
              </div>
            </div>
          `
              : ""
          }

          <div class="grid-2">
            <div class="form-group">
              <label class="form-label">1. Área a Validar / Liquidar</label>
              ${
                isSup
                  ? `<input type="text" class="form-control" value="${STATE.user.nombre_area}" disabled />
                     <input type="hidden" id="proc-area" value="${STATE.user.id_area || ""}" />`
                  : `<select id="proc-area" class="form-control">
                      <option value="">Todas las Áreas (Consolidado)</option>
                      ${STATE.areas
                        .map(
                          (a) =>
                            `<option value="${a.id}" ${String(selectedArea) === String(a.id) ? "selected" : ""}>Área: ${a.nombre}</option>`
                        )
                        .join("")}
                    </select>`
              }
            </div>
            <div class="form-group">
              <label class="form-label">2. Tipo de Reporte (Agrupado o Individual)</label>
              <select id="proc-empleado" class="form-control">
                <option value="TODOS">Agrupado (Todos los empleados del área)</option>
                ${empleadosDelArea
                  .map(
                    (e) =>
                      `<option value="${e.id_empleado}" ${STATE.huelleroFiltroEmpleado === e.id_empleado ? "selected" : ""}>Individual: ${e.id_empleado} - ${e.nombre}</option>`
                  )
                  .join("")}
              </select>
            </div>
          </div>

          <div class="grid-2">
            <div class="form-group">
              <label class="form-label">Fecha Inicio del Período</label>
              <input type="date" id="proc-inicio" class="form-control" value="${prev?.fecha_min || `${y}-${m}-01`}" required />
            </div>
            <div class="form-group">
              <label class="form-label">Fecha Fin del Período (máx 31 días)</label>
              <input type="date" id="proc-fin" class="form-control" value="${prev?.fecha_max || `${y}-${m}-${String(lastDay).padStart(2, "0")}`}" required />
            </div>
          </div>

          <details style="margin-bottom:14px; border:1px solid var(--borde); border-radius:10px; padding:10px 14px; background:var(--superficie-sec);">
            <summary style="font-size:0.82rem; font-weight:700; color:var(--texto-sec); cursor:pointer;">Opciones avanzadas de columnas del Excel y marcaciones</summary>
            <div class="grid-3" style="margin-top:12px;">
              <div class="form-group" style="margin-bottom:8px;">
                <label class="form-label">Columna ID (Resp: A)</label>
                <input type="text" id="proc-col-id" class="form-control" value="ID_Empleado" />
              </div>
              <div class="form-group" style="margin-bottom:8px;">
                <label class="form-label">Columna Fecha (Resp: C)</label>
                <input type="text" id="proc-col-fecha" class="form-control" value="Fecha" />
              </div>
              <div class="form-group" style="margin-bottom:8px;">
                <label class="form-label">Columna Hora (Resp: D)</label>
                <input type="text" id="proc-col-hora" class="form-control" value="Hora" />
              </div>
            </div>
            <div style="display:flex; gap:18px; flex-wrap:wrap; margin-top:6px;">
              <label style="display:flex; align-items:center; gap:8px; font-size:0.84rem; font-weight:600; cursor:pointer;">
                <input type="checkbox" id="proc-incluir-app" checked />
                Integrar marcaciones de App Móvil (Reloj GPS)
              </label>
              <label style="display:flex; align-items:center; gap:8px; font-size:0.84rem; font-weight:600; cursor:pointer;">
                <input type="checkbox" id="proc-no-programados" checked />
                Incluir auditoría de horas no programadas
              </label>
            </div>
          </details>

          <button type="submit" id="btn-submit-procesar" class="btn btn-primary btn-block" style="padding:12px; font-size:0.95rem;">
            ${icon("play", 16)} Validar Horas Extras y Generar Reporte Excel
          </button>
        </form>
      </div>
    `
        : `
      <div class="corp-table-card">
        <div class="table-responsive" style="max-height:calc(100vh - 210px);">
          <table>
            <thead>
              <tr>
                <th>Archivo Excel</th>
                <th>Fecha de Generación</th>
                <th>Tamaño</th>
                <th style="width:130px; text-align:right;">Descargar</th>
              </tr>
            </thead>
            <tbody>
              ${
                STATE.reportes.length === 0
                  ? `<tr><td colspan="4" style="text-align:center; padding:28px; color:var(--texto-sec);">Aún no hay reportes generados. Ve a la pestaña "Validar Huellero y Generar Reporte".</td></tr>`
                  : STATE.reportes
                      .map(
                        (r) => `
                  <tr>
                    <td><strong>${r.nombre}</strong></td>
                    <td>${r.fecha}</td>
                    <td>${r.tamano_kb} KB</td>
                    <td style="text-align:right;">
                      <a href="${r.url}" download class="btn btn-primary btn-sm">${icon("download", 14)} Descargar</a>
                    </td>
                  </tr>
                `
                      )
                      .join("")
              }
            </tbody>
          </table>
        </div>
      </div>
    `
    }
  `;
}

// ============================================================================
// 5. ANÁLISIS, AUDITORÍA DE HORAS EXTRAS, GRÁFICAS Y HOJA IMPRIMIBLE PDF
// ============================================================================

function renderAdminAnalisis() {
  const { kpis, filas, turnos_disponibles } = STATE.analisisData;
  const f = STATE.analisisFiltros;
  const isSup = STATE.user.role === "supervisor";
  const canProcessHuellero = ["superadmin", "supervisor", "auditor", "talento_humano"].includes(STATE.user.role);

  const kpiCards = [
    { key: "horas_extra", label: "Total Horas Extras", val: Number(kpis.horas_extra || 0).toFixed(2) },
    { key: "minutos_tardanza", label: "Minutos de Tardanza", val: kpis.minutos_tardanza || 0 },
    { key: "ausencias", label: "Total Ausencias", val: kpis.ausencias || 0 },
    { key: "llegadas_tempranas", label: "Llegadas Tempranas", val: kpis.llegadas_tempranas || 0 }
  ];

  return `
    ${
      STATE.user.role === "auditor"
        ? `
      <div class="alert-banner alert-ok no-print">
        <div>
          <strong>🔍 Panel del Auditor de Horas Extras:</strong> Consulta todos los reportes generados o pulsa <strong>"Generar Nuevo Reporte con Huellero"</strong> si algún área o empleado aún no tiene su reporte hecho.
        </div>
        <button type="button" class="btn btn-action btn-sm" data-goto="procesar">
          ⚙️ Generar Nuevo Reporte con Huellero →
        </button>
      </div>
    `
        : ""
    }

    <div class="grid-4 no-print" style="margin-bottom:18px;">
      ${kpiCards
        .map(
          (k) => `
        <div class="kpi-card ${f.kpi === k.key ? "active" : ""}" data-kpi="${k.key}">
          <div class="kpi-label">${k.label} (Clic para filtrar)</div>
          <div class="kpi-value">${k.val}</div>
        </div>
      `
        )
        .join("")}
    </div>

    <div class="grid-2 no-print" style="margin-bottom:18px;">
      <div class="card" style="margin-bottom:0;">
        <div class="card-header">
          <div class="card-title">📊 Desglose de Horas Extra y Recargos (ED, EN, EF, END, RN, RND, RF)</div>
        </div>
        <div style="height:230px; position:relative;">
          <canvas id="chart-recargos"></canvas>
        </div>
      </div>
      <div class="card" style="margin-bottom:0;">
        <div class="card-header">
          <div class="card-title">🎯 Distribución de Estados de Jornada</div>
        </div>
        <div style="height:230px; position:relative;">
          <canvas id="chart-estados"></canvas>
        </div>
      </div>
    </div>

    <div class="card no-print">
      <div class="card-header">
        <div style="display:flex; gap:10px; flex-wrap:wrap;">
          <button type="button" class="btn ${STATE.analisisTab === "tabla" ? "btn-primary" : "btn-outline"} btn-sm" data-ana-tab="tabla">
            📋 Tabla Detallada de Horas Extra y Novedades
          </button>
          <button type="button" class="btn ${STATE.analisisTab === "hoja_imprimible" ? "btn-primary" : "btn-outline"} btn-sm" data-ana-tab="hoja_imprimible">
            🖨️ Vista Previa Hoja de Turnos Individual (PDF / Imprimir)
          </button>
        </div>
        <div style="display:flex; gap:8px;">
          ${
            canProcessHuellero
              ? `<button type="button" class="btn btn-outline btn-sm" data-goto="procesar">⚙️ Procesar Huellero</button>`
              : ""
          }
          <button type="button" id="btn-exportar-novedades" class="btn btn-action btn-sm">
            📊 Exportar Reporte Excel (6 Pestañas)
          </button>
        </div>
      </div>

      <div class="grid-4" style="align-items:end;">
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label">Área</label>
          ${
            isSup
              ? `<input type="text" class="form-control" value="${STATE.user.nombre_area}" disabled />
                 <input type="hidden" id="ana-area" value="${STATE.user.id_area || ""}" />`
              : `<select id="ana-area" class="form-control">
                  <option value="">TODAS LAS ÁREAS</option>
                  ${STATE.areas
                    .map(
                      (a) =>
                        `<option value="${a.id}" ${String(f.id_area) === String(a.id) ? "selected" : ""}>${a.nombre}</option>`
                    )
                    .join("")}
                </select>`
          }
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label">Empleado (Individual o Todos)</label>
          <select id="ana-emp" class="form-control">
            <option value="TODOS">TODOS LOS EMPLEADOS</option>
            ${STATE.empleados
              .filter((e) => !f.id_area || String(e.id_area || "") === String(f.id_area))
              .map(
                (e) =>
                  `<option value="${e.id_empleado}" ${f.id_empleado === e.id_empleado ? "selected" : ""}>${e.id_empleado} - ${e.nombre}</option>`
              )
              .join("")}
          </select>
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label">Fecha Inicio</label>
          <input type="date" id="ana-inicio" class="form-control" value="${f.fecha_inicio}" />
        </div>
        <div class="form-group" style="margin-bottom:0; display:flex; gap:8px;">
          <div style="flex:1;">
            <label class="form-label">Fecha Fin</label>
            <input type="date" id="ana-fin" class="form-control" value="${f.fecha_fin}" />
          </div>
          <button type="button" id="btn-aplicar-analisis" class="btn btn-primary" style="align-self:flex-end;">
            Filtrar
          </button>
        </div>
      </div>
    </div>

    ${STATE.analisisTab === "hoja_imprimible" ? renderHojaTurnosImprimible(filas) : renderTablaAnalisis(filas)}
  `;
}

function renderTablaAnalisis(filas) {
  return `
    <div class="card">
      <div class="card-header">
        <div class="card-title">Detalle de Jornadas, Recargos (ED, EN, EF, END, RN, RND, RF) y Novedades (${filas.length} registros)</div>
      </div>
      <div class="table-responsive" style="max-height:540px;">
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Empleado</th>
              <th>Área</th>
              <th>Turno</th>
              <th>Ent. Teórica</th>
              <th>Ent. Real</th>
              <th>Sal. Teórica</th>
              <th>Sal. Real</th>
              <th>H. Extra</th>
              <th>Desglose Recargos / Extras</th>
              <th>Tardanza</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            ${
              filas.length === 0
                ? `<tr><td colspan="12" style="text-align:center; padding:24px;">No hay registros liquidados para estos filtros.</td></tr>`
                : filas
                    .map((row) => {
                      let badgeClass = "badge-ok";
                      if (row.estado.includes("AUSENCIA")) badgeClass = "badge-danger";
                      else if (row.estado.includes("TARDANZA") || row.estado.includes("ANTICIPADA"))
                        badgeClass = "badge-warn";
                      return `
                    <tr>
                      <td>${row.fecha}</td>
                      <td><strong>${row.id_empleado}</strong> - ${row.nombre_empleado}</td>
                      <td><span class="badge badge-info">${row.nombre_area || "Sin Área"}</span></td>
                      <td>${row.turno}</td>
                      <td>${row.hora_entrada_teorica || "—"}</td>
                      <td>${row.hora_entrada_real || "—"}</td>
                      <td>${row.hora_salida_teorica || "—"}</td>
                      <td>${row.hora_salida_real || "—"}</td>
                      <td><strong>${Number(row.horas_extra).toFixed(2)}</strong></td>
                      <td><span style="font-size:0.8rem; color:var(--petroleo); font-weight:700;">${row.desglose}</span></td>
                      <td>${row.minutos_tardanza > 0 ? `${row.minutos_tardanza} min` : "0"}</td>
                      <td><span class="badge ${badgeClass}">${row.estado}</span></td>
                    </tr>
                  `;
                    })
                    .join("")
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderHojaTurnosImprimible(filas) {
  const empId =
    STATE.analisisFiltros.id_empleado !== "TODOS"
      ? STATE.analisisFiltros.id_empleado
      : STATE.hojaEmpleadoId || STATE.empleados[0]?.id_empleado || "";
  const empObj = STATE.empleados.find((e) => e.id_empleado === empId) || {
    id_empleado: empId,
    nombre: "SELECCIONE UN EMPLEADO",
    nombre_area: ""
  };
  const filasEmp = filas.filter((r) => String(r.id_empleado) === String(empId));

  const totales = { ED: 0, EN: 0, EF: 0, END: 0, RN: 0, RND: 0, RF: 0 };
  filasEmp.forEach((r) => {
    for (const k of Object.keys(totales)) {
      totales[k] += Number(r[k] || 0);
    }
  });
  const totalExtras = totales.ED + totales.EN + totales.EF + totales.END;

  return `
    <div class="card no-print" style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
      <div style="display:flex; align-items:center; gap:10px;">
        <label style="font-weight:700;">Empleado para Hoja Individual:</label>
        <select id="hoja-emp-select" class="form-control" style="width:320px;">
          ${STATE.empleados
            .map(
              (e) => `<option value="${e.id_empleado}" ${e.id_empleado === empId ? "selected" : ""}>${e.id_empleado} - ${e.nombre} (${e.nombre_area || ""})</option>`
            )
            .join("")}
        </select>
      </div>
      <button type="button" id="btn-print-sheet" class="btn btn-primary">
        🖨️ Imprimir / Guardar Hoja Individual en PDF
      </button>
    </div>

    <div class="printable-sheet">
      <div style="display:flex; align-items:center; justify-content:space-between; border-bottom:3px solid #005A66; padding-bottom:14px; margin-bottom:16px;">
        <img src="/api/branding/logo" alt="Sterinova" style="max-height:55px;" onerror="this.style.display='none'" />
        <div style="text-align:right;">
          <div style="font-size:1.2rem; font-weight:800; color:#005A66;">HOJA DE TURNOS Y LIQUIDACIÓN DE HORAS</div>
          <div style="font-size:0.86rem; color:#475569;">Formato Corporativo Sterinova — Área: ${empObj.nombre_area || "General"}</div>
        </div>
      </div>

      <div style="display:flex; justify-content:space-between; margin-bottom:14px; font-size:0.92rem;">
        <div><strong>TRABAJADOR:</strong> ${empObj.nombre}</div>
        <div><strong>ID / CÓDIGO:</strong> ${empObj.id_empleado}</div>
        <div><strong>TOTAL HORAS EXTRAS:</strong> ${totalExtras.toFixed(2)} h</div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Hora Entrada</th>
            <th>Hora Salida</th>
            <th>E.D</th>
            <th>E.N</th>
            <th>E.F</th>
            <th>E.N.D</th>
            <th>R.N</th>
            <th>R.N.D</th>
            <th>Observaciones</th>
          </tr>
        </thead>
        <tbody>
          ${
            filasEmp.length === 0
              ? `<tr><td colspan="10" style="padding:20px;">Sin registros para este trabajador en el período filtrado.</td></tr>`
              : filasEmp
                  .map(
                    (r) => `
              <tr>
                <td><strong>${r.fecha}</strong></td>
                <td>${r.hora_entrada_real || r.hora_entrada_teorica || ""}</td>
                <td>${r.hora_salida_real || r.hora_salida_teorica || ""}</td>
                <td>${Number(r.ED).toFixed(2)}</td>
                <td>${Number(r.EN).toFixed(2)}</td>
                <td>${Number(r.EF).toFixed(2)}</td>
                <td>${Number(r.END).toFixed(2)}</td>
                <td>${Number(r.RN).toFixed(2)}</td>
                <td>${Number(r.RND).toFixed(2)}</td>
                <td style="text-align:left;">${r.observaciones || r.estado}</td>
              </tr>
            `
                  )
                  .join("")
          }
        </tbody>
      </table>

      <div style="margin-top:14px; padding:10px 14px; background:#E8F0F1; border:1px solid #005A66; font-weight:800; font-size:0.84rem; color:#005A66;">
        RESUMEN DE HORAS | E.D: ${totales.ED.toFixed(2)} | E.N: ${totales.EN.toFixed(2)} | E.F: ${totales.EF.toFixed(2)} | E.N.D: ${totales.END.toFixed(2)} | R.N: ${totales.RN.toFixed(2)} | R.N.D: ${totales.RND.toFixed(2)} | R.F: ${totales.RF.toFixed(2)}
      </div>
    </div>
  `;
}

function initAnalisisCharts() {
  if (typeof Chart === "undefined") return;
  const filas = STATE.analisisData?.filas || [];

  const totals = { ED: 0, EN: 0, EF: 0, END: 0, RN: 0, RND: 0, RF: 0 };
  const estadosCount = { OK: 0, TARDANZA: 0, AUSENCIA: 0, DESCANSO: 0, OTROS: 0 };

  filas.forEach((r) => {
    for (const k of Object.keys(totals)) totals[k] += Number(r[k] || 0);
    const est = String(r.estado || "").toUpperCase();
    if (est.includes("AUSENCIA")) estadosCount.AUSENCIA++;
    else if (est.includes("TARDANZA")) estadosCount.TARDANZA++;
    else if (est.includes("DESCANSO") || r.turno === "DESCANSO") estadosCount.DESCANSO++;
    else if (est === "OK") estadosCount.OK++;
    else estadosCount.OTROS++;
  });

  const ctxRec = document.getElementById("chart-recargos");
  if (ctxRec) {
    if (chartRecargosInstance) chartRecargosInstance.destroy();
    chartRecargosInstance = new Chart(ctxRec, {
      type: "bar",
      data: {
        labels: ["E.D", "E.N", "E.F", "E.N.D", "R.N", "R.N.D", "R.F"],
        datasets: [
          {
            label: "Horas Acumuladas",
            data: Object.values(totals).map((v) => Number(v.toFixed(2))),
            backgroundColor: ["#005A66", "#0284C7", "#E64A19", "#7C3AED", "#0D9488", "#D97706", "#2563EB"],
            borderRadius: 8
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } }
      }
    });
  }

  const ctxEst = document.getElementById("chart-estados");
  if (ctxEst) {
    if (chartEstadosInstance) chartEstadosInstance.destroy();
    chartEstadosInstance = new Chart(ctxEst, {
      type: "doughnut",
      data: {
        labels: ["Cumplidos (OK)", "Tardanzas", "Ausencias", "Descansos", "Otros"],
        datasets: [
          {
            data: [
              estadosCount.OK,
              estadosCount.TARDANZA,
              estadosCount.AUSENCIA,
              estadosCount.DESCANSO,
              estadosCount.OTROS
            ],
            backgroundColor: ["#10B981", "#F59E0B", "#EF4444", "#0284C7", "#64748B"]
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "right" } }
      }
    });
  }
}

// ============================================================================
// 6. BASE DE DATOS DE EMPLEADOS (TABLA ANCHO COMPLETO + FILTRO ÁREA + DRAWERS)
// ============================================================================

function renderAdminEmpleados() {
  const isSup = STATE.user?.role === "supervisor";
  const qEmp = (STATE.searchEmpleados || "").toLowerCase();
  const areaFilter = isSup ? String(STATE.user.id_area || "") : STATE.filtroAreaEmpleados || "";
  const empleadosFiltrados = STATE.empleados.filter((e) => {
    const matchText =
      e.id_empleado.toLowerCase().includes(qEmp) ||
      e.nombre.toLowerCase().includes(qEmp) ||
      (e.nombre_area || "").toLowerCase().includes(qEmp) ||
      (e.cargo || "").toLowerCase().includes(qEmp);
    const matchArea = !areaFilter || String(e.id_area || "") === String(areaFilter);
    return matchText && matchArea;
  });

  return `
    <div class="corp-toolbar">
      <div class="corp-toolbar-left">
        <div class="corp-search-box">
          ${icon("search", 16)}
          <input type="text" id="search-empleados-table" class="form-control" placeholder="Buscar por ID, nombre, cargo..." value="${STATE.searchEmpleados || ""}" />
        </div>
        ${
          isSup
            ? `<span class="badge badge-info" style="height:36px; padding:0 12px; font-size:0.82rem;">${icon("building-2", 14)} Área: ${STATE.user.nombre_area || "Mi Área"} (${empleadosFiltrados.length})</span>`
            : `<select id="filter-area-empleados" class="form-control" style="width:auto; min-width:190px; height:38px; font-size:0.86rem;">
                <option value="">Todas las Áreas (${STATE.empleados.length})</option>
                ${STATE.areas
                  .map(
                    (a) =>
                      `<option value="${a.id}" ${String(areaFilter) === String(a.id) ? "selected" : ""}>${a.nombre} (${a.total_empleados})</option>`
                  )
                  .join("")}
              </select>`
        }
      </div>
      <div class="corp-toolbar-right">
        <button type="button" id="btn-open-import-emp" class="btn btn-outline btn-sm">
          ${icon("file-spreadsheet", 15)} Importar Excel
        </button>
        <button type="button" id="btn-open-new-emp" class="btn btn-primary btn-sm">
          ${icon("user-plus", 15)} Nuevo Empleado
        </button>
      </div>
    </div>

    <div class="corp-table-card">
      <div class="table-responsive" style="max-height:calc(100vh - 210px);">
        <table>
          <thead>
            <tr>
              <th>ID Biométrico</th>
              <th>Nombre Completo</th>
              <th>Área Asignada</th>
              <th>Cargo</th>
              <th>PIN App</th>
              <th style="width:110px; text-align:right;">Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${
              empleadosFiltrados.length === 0
                ? `<tr><td colspan="6" style="text-align:center; padding:28px; color:var(--texto-sec);">No hay empleados que coincidan con el filtro.</td></tr>`
                : empleadosFiltrados
                    .map(
                      (e) => `
              <tr>
                <td><strong>${e.id_empleado}</strong></td>
                <td>${e.nombre}</td>
                <td><span class="badge badge-info">${e.nombre_area || "Sin Área"}</span></td>
                <td>${e.cargo || "Operario"}</td>
                <td><code>${e.pin || "1234"}</code></td>
                <td style="text-align:right;">
                  <div class="row-actions">
                    <button type="button" class="icon-btn btn-edit-emp" data-id="${e.id_empleado}" data-nombre="${e.nombre}" data-cargo="${e.cargo || "Operario"}" data-pin="${e.pin || "1234"}" data-area="${e.id_area || ""}" title="Editar empleado">${icon("pencil", 15)}</button>
                    <button type="button" class="icon-btn icon-btn-danger btn-del-emp" data-id="${e.id_empleado}" title="Eliminar empleado">${icon("trash-2", 15)}</button>
                  </div>
                </td>
              </tr>
            `
                    )
                    .join("")
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ============================================================================
// 7. MAPA GPS Y PERMISOS (TABS: PERMISOS DEL EQUIPO | MAPA GPS EN VIVO)
// ============================================================================

function renderGpsYSolicitudes() {
  const role = STATE.user.role;
  const isSup = role === "supervisor";
  const isRRHH = role === "talento_humano" || role === "superadmin";
  const tab = STATE.gpsTab || "permisos";

  return `
    <div class="corp-tabs-bar">
      <div class="corp-tabs">
        <button type="button" class="corp-tab ${tab === "permisos" ? "active" : ""}" data-gps-tab="permisos">
          ${icon("file-text", 16)} Solicitudes de Permisos <span class="corp-tab-count">${STATE.solicitudes.length}</span>
        </button>
        <button type="button" class="corp-tab ${tab === "mapa" ? "active" : ""}" data-gps-tab="mapa">
          ${icon("map-pin", 16)} Mapa GPS y Marcaciones Móviles <span class="corp-tab-count">${STATE.marcacionesMoviles.length}</span>
        </button>
      </div>
    </div>

    ${
      tab === "permisos"
        ? `
      <div class="corp-table-card">
        <div class="table-responsive" style="max-height:calc(100vh - 210px);">
          <table>
            <thead>
              <tr>
                <th>Empleado / Área</th>
                <th>Tipo / Fechas</th>
                <th>Motivo</th>
                <th>Estado del Flujo</th>
                <th style="text-align:right;">Acción</th>
              </tr>
            </thead>
            <tbody>
              ${
                STATE.solicitudes.length === 0
                  ? `<tr><td colspan="5" style="text-align:center; padding:28px; color:var(--texto-sec);">No hay solicitudes de permisos registradas.</td></tr>`
                  : STATE.solicitudes
                      .map((s) => {
                        let badge = "badge-warn";
                        if (s.estado === "APROBADA") badge = "badge-ok";
                        else if (s.estado.includes("RECHAZADA")) badge = "badge-danger";
                        else if (s.estado === "AVALADO_SUPERVISOR") badge = "badge-info";

                        let accionesHtml = `<small style="color:var(--texto-sec);">${s.respuesta_admin || s.respuesta_supervisor || "En trámite"}</small>`;
                        if (isSup && s.estado === "PENDIENTE_SUPERVISOR") {
                          accionesHtml = `
                            <div class="row-actions">
                              <button type="button" class="btn btn-primary btn-sm btn-resp-sol" data-id="${s.id}" data-estado="AVALADO_SUPERVISOR">
                                ${icon("check", 14)} Avalar
                              </button>
                              <button type="button" class="icon-btn icon-btn-danger btn-resp-sol" data-id="${s.id}" data-estado="RECHAZADA_SUPERVISOR" title="Rechazar">
                                ${icon("x", 15)}
                              </button>
                            </div>
                          `;
                        } else if (isRRHH && s.estado !== "APROBADA" && !s.estado.includes("RECHAZADA")) {
                          accionesHtml = `
                            <div class="row-actions">
                              <button type="button" class="btn btn-primary btn-sm btn-resp-sol" data-id="${s.id}" data-estado="APROBADA">
                                ${icon("check", 14)} Aprobar RRHH
                              </button>
                              <button type="button" class="icon-btn icon-btn-danger btn-resp-sol" data-id="${s.id}" data-estado="RECHAZADA" title="Rechazar">
                                ${icon("x", 15)}
                              </button>
                            </div>
                          `;
                        }

                        return `
                    <tr>
                      <td>
                        <strong>${s.nombre_empleado}</strong> <small style="color:var(--texto-sec);">(${s.id_empleado})</small><br/>
                        <span class="badge badge-info">${s.nombre_area || "Sin Área"}</span>
                      </td>
                      <td><strong>${s.tipo}</strong><br/><small style="color:var(--texto-sec);">${s.fecha_inicio} a ${s.fecha_fin}</small></td>
                      <td>${s.motivo}</td>
                      <td><span class="badge ${badge}">${s.estado}</span></td>
                      <td style="text-align:right;">${accionesHtml}</td>
                    </tr>
                  `;
                      })
                      .join("")
              }
            </tbody>
          </table>
        </div>
      </div>
    `
        : `
      <div class="card" style="padding:14px; margin-bottom:16px;">
        <div id="gps-leaflet-map" class="gps-map-container" style="margin-bottom:0;"></div>
      </div>

      <div class="corp-table-card">
        <div class="table-responsive" style="max-height:360px;">
          <table>
            <thead>
              <tr>
                <th>Fecha y Hora</th>
                <th>Empleado / Área</th>
                <th>Tipo</th>
                <th>Evidencia / Nota</th>
                <th>Dirección Física</th>
                <th>Coordenadas</th>
                <th style="text-align:right;">Mapa</th>
              </tr>
            </thead>
            <tbody>
              ${
                STATE.marcacionesMoviles.length === 0
                  ? `<tr><td colspan="7" style="text-align:center; padding:28px; color:var(--texto-sec);">Aún no hay marcaciones registradas desde celulares.</td></tr>`
                  : STATE.marcacionesMoviles
                      .map(
                        (m) => `
                  <tr>
                    <td><strong>${m.fecha_hora}</strong></td>
                    <td>
                      <strong>${m.nombre_empleado}</strong> <small style="color:var(--texto-sec);">(${m.id_empleado})</small><br/>
                      <span class="badge badge-info">${m.nombre_area || "Sin Área"}</span>
                    </td>
                    <td><span class="badge ${m.tipo === "ENTRADA" ? "badge-ok" : "badge-warn"}">${m.tipo}</span></td>
                    <td>
                      ${
                        m.foto_base64
                          ? `<img src="${m.foto_base64}" alt="Selfie" style="width:40px; height:40px; object-fit:cover; border-radius:8px; border:1px solid var(--borde); display:block; margin-bottom:4px;" />`
                          : ""
                      }
                      <small>${m.observaciones || "—"}</small>
                    </td>
                    <td><strong>${m.direccion || "Sin dirección"}</strong></td>
                    <td>${
                      m.latitud != null && m.longitud != null
                        ? `<code>${m.latitud}, ${m.longitud}</code> <small>(±${m.precision_m || 0}m)</small>`
                        : "—"
                    }</td>
                    <td style="text-align:right;">
                      ${
                        m.latitud != null && m.longitud != null
                          ? `<a href="https://www.google.com/maps?q=${m.latitud},${m.longitud}" target="_blank" class="btn btn-outline btn-sm">${icon("external-link", 14)} Ver</a>`
                          : "—"
                      }
                    </td>
                  </tr>
                `
                      )
                      .join("")
              }
            </tbody>
          </table>
        </div>
      </div>
    `
    }
  `;
}

function initGpsLeafletMap() {
  if (typeof L === "undefined") return;
  const container = document.getElementById("gps-leaflet-map");
  if (!container) return;
  if (leafletMapInstance) {
    leafletMapInstance.remove();
    leafletMapInstance = null;
  }

  let center = [4.6533, -74.0836];
  const validMarks = STATE.marcacionesMoviles.filter((m) => m.latitud != null && m.longitud != null);
  if (validMarks.length > 0) {
    center = [Number(validMarks[0].latitud), Number(validMarks[0].longitud)];
  }

  leafletMapInstance = L.map("gps-leaflet-map").setView(center, validMarks.length > 0 ? 14 : 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors"
  }).addTo(leafletMapInstance);

  validMarks.forEach((m) => {
    const marker = L.marker([Number(m.latitud), Number(m.longitud)]).addTo(leafletMapInstance);
    marker.bindPopup(`
      <div style="font-size:0.84rem;">
        <strong>${m.nombre_empleado} (${m.nombre_area || ""})</strong><br/>
        <span style="color:#005A66; font-weight:700;">${m.tipo}</span> — ${m.fecha_hora}<br/>
        🏠 ${m.direccion || "Sin dirección"}<br/>
        📍 <code>${m.latitud}, ${m.longitud}</code>
      </div>
    `);
  });
}

// ============================================================================
// EVENTOS DE GESTIÓN (TODOS LOS ROLES)
// ============================================================================

function bindManagementEvents() {
  document.getElementById("btn-toggle-theme")?.addEventListener("click", toggleDarkMode);

  document.getElementById("btn-toggle-notifs")?.addEventListener("click", () => {
    STATE.showNotifModal = !STATE.showNotifModal;
    renderApp();
  });

  document.getElementById("btn-close-notifs")?.addEventListener("click", () => {
    STATE.showNotifModal = false;
    renderApp();
  });

  document.querySelectorAll(".btn-read-notif").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await apiFetch("/api/notificaciones/leer", {
        method: "POST",
        body: JSON.stringify({ id: Number(btn.dataset.id) })
      });
      await loadNotificaciones(false);
      renderApp();
    });
  });

  document.querySelectorAll("[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      STATE.activeView = btn.dataset.view;
      renderApp();
    });
  });

  document.querySelectorAll("[data-goto]").forEach((el) => {
    el.addEventListener("click", () => {
      STATE.activeView = el.dataset.goto;
      renderApp();
    });
  });

  const logout = () => setUser(null);
  document.getElementById("btn-logout")?.addEventListener("click", logout);
  document.getElementById("btn-top-logout")?.addEventListener("click", logout);

  document.getElementById("btn-install-pwa")?.addEventListener("click", async () => {
    if (STATE.deferredInstallPrompt) {
      STATE.deferredInstallPrompt.prompt();
      await STATE.deferredInstallPrompt.userChoice;
      STATE.deferredInstallPrompt = null;
      renderApp();
    }
  });

  // --- Eventos Drawer / Modal Corporativo Global ---
  document.getElementById("btn-open-mobile-menu")?.addEventListener("click", () => openDrawer("mobile_menu", null));
  document.getElementById("btn-mobile-drawer-logout")?.addEventListener("click", () => {
    STATE.activeDrawer = null;
    setUser(null);
  });
  document.querySelectorAll("[data-mobile-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      STATE.activeView = btn.dataset.mobileView;
      STATE.activeDrawer = null;
      renderApp();
    });
  });

  document.getElementById("btn-close-drawer")?.addEventListener("click", closeDrawer);
  document.getElementById("btn-cancel-drawer")?.addEventListener("click", closeDrawer);
  document.getElementById("drawer-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "drawer-backdrop") closeDrawer();
  });

  // --- Eventos Pestañas y Acciones Superadmin (Áreas y Usuarios) ---
  document.querySelectorAll("[data-sa-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      STATE.superadminTab = btn.dataset.saTab;
      renderApp();
    });
  });

  document.getElementById("btn-open-new-area")?.addEventListener("click", () => openDrawer("area", null));
  document.getElementById("btn-open-new-usr")?.addEventListener("click", () => openDrawer("usuario", null));

  document.querySelectorAll(".btn-edit-area").forEach((btn) => {
    btn.addEventListener("click", () => {
      openDrawer("area", {
        id: btn.dataset.id,
        nombre: btn.dataset.nombre,
        descripcion: btn.dataset.desc
      });
    });
  });

  document.querySelectorAll(".btn-del-area").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await apiFetch("/api/areas/eliminar", {
          method: "POST",
          body: JSON.stringify({ id: Number(btn.dataset.id) })
        });
        showToast("Área eliminada", "info");
        await Promise.all([loadAreas(), loadUsuarios(), loadEmpleados()]);
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  });

  document.querySelectorAll(".btn-edit-usr").forEach((btn) => {
    btn.addEventListener("click", () => {
      const u = STATE.usuarios.find((x) => x.username === btn.dataset.user);
      if (u) openDrawer("usuario", u);
    });
  });

  document.querySelectorAll(".btn-del-usr").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await apiFetch("/api/usuarios/eliminar", {
          method: "POST",
          body: JSON.stringify({ username: btn.dataset.user })
        });
        showToast("Usuario eliminado", "info");
        await Promise.all([loadUsuarios(), loadAreas()]);
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  });

  document.getElementById("search-usuarios-table")?.addEventListener("input", (e) => {
    STATE.searchUsuarios = e.target.value;
    renderApp();
    const input = document.getElementById("search-usuarios-table");
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });

  const formArea = document.getElementById("form-area");
  if (formArea) {
    formArea.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await apiFetch("/api/areas", {
          method: "POST",
          body: JSON.stringify({
            id: document.getElementById("area-id").value || null,
            nombre: document.getElementById("area-nombre").value,
            descripcion: document.getElementById("area-desc").value
          })
        });
        showToast("Área guardada correctamente", "success");
        STATE.activeDrawer = null;
        STATE.drawerData = null;
        await Promise.all([loadAreas(), loadUsuarios(), loadEmpleados()]);
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }

  const formUsr = document.getElementById("form-usuario-sistema");
  if (formUsr) {
    formUsr.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await apiFetch("/api/usuarios", {
          method: "POST",
          body: JSON.stringify({
            username: document.getElementById("usr-username").value,
            nombre: document.getElementById("usr-nombre").value,
            password: document.getElementById("usr-password").value,
            rol: document.getElementById("usr-rol").value,
            id_area: document.getElementById("usr-area").value || null
          })
        });
        showToast("Usuario guardado correctamente", "success");
        STATE.activeDrawer = null;
        STATE.drawerData = null;
        await Promise.all([loadUsuarios(), loadAreas()]);
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }

  // --- Eventos Pestañas Talento Humano y Admin General Estructura ---
  document.querySelectorAll("[data-rrhh-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      STATE.rrhhTab = btn.dataset.rrhhTab;
      renderApp();
    });
  });

  document.querySelectorAll("[data-est-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      STATE.adminEstructuraTab = btn.dataset.estTab;
      renderApp();
    });
  });

  document.getElementById("btn-open-new-comunicado")?.addEventListener("click", () => openDrawer("comunicado", null));

  // --- Eventos Talento Humano: Memorandos y Reporte de Permisos ---
  const formCom = document.getElementById("form-comunicado");
  if (formCom) {
    formCom.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const dtTipo = document.getElementById("com-destino-tipo").value;
        const rawVal = document.getElementById("com-destino-valor").value;
        let destino_valor = "";
        if (dtTipo === "AREA") {
          destino_valor = rawVal.startsWith("AREA:") ? rawVal.replace("AREA:", "") : rawVal;
        } else if (dtTipo === "EMPLEADO") {
          destino_valor = rawVal.startsWith("EMP:") ? rawVal.replace("EMP:", "") : rawVal;
        }
        await apiFetch("/api/comunicados", {
          method: "POST",
          body: JSON.stringify({
            tipo: document.getElementById("com-tipo").value,
            fecha_evento: document.getElementById("com-fecha").value,
            destino_tipo: dtTipo,
            destino_valor,
            titulo: document.getElementById("com-titulo").value,
            mensaje: document.getElementById("com-mensaje").value,
            autor: STATE.user.nombre
          })
        });
        showToast("Memorando enviado y notificado en tiempo real", "success");
        STATE.activeDrawer = null;
        STATE.drawerData = null;
        await Promise.all([loadComunicados(), loadNotificaciones(false)]);
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }

  document.getElementById("btn-exportar-permisos")?.addEventListener("click", async () => {
    try {
      const res = await apiFetch("/api/exportar-permisos", {
        method: "POST",
        body: JSON.stringify({})
      });
      showToast("Reporte Excel de Permisos generado", "success");
      window.open(res.url, "_blank");
      await loadReportes();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  // --- Eventos Pestañas de Procesar Huellero y Permisos/GPS ---
  document.querySelectorAll("[data-proc-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      STATE.procesarTab = btn.dataset.procTab;
      renderApp();
    });
  });

  document.querySelectorAll("[data-gps-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      STATE.gpsTab = btn.dataset.gpsTab;
      renderApp();
    });
  });

  // --- Eventos Catálogo Turnos (Tabla completa + Drawer) ---
  document.getElementById("btn-open-new-turno")?.addEventListener("click", () => openDrawer("turno", null));

  document.getElementById("search-turnos-table")?.addEventListener("input", (e) => {
    STATE.searchTurnos = e.target.value;
    renderApp();
    const input = document.getElementById("search-turnos-table");
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });

  document.querySelectorAll(".btn-edit-turno").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = STATE.turnos.find((x) => String(x.id) === String(btn.dataset.id));
      if (t) openDrawer("turno", t);
    });
  });

  document.querySelectorAll(".btn-del-turno").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await apiFetch("/api/turnos/eliminar", {
          method: "POST",
          body: JSON.stringify({ id: Number(btn.dataset.id) })
        });
        showToast("Turno eliminado", "info");
        await Promise.all([loadTurnos(), loadDashboard()]);
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  });

  const formTurno = document.getElementById("form-turno");
  if (formTurno) {
    formTurno.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const id = document.getElementById("turno-id").value;
        const nombre = document.getElementById("turno-nombre").value;
        const hora_entrada = document.getElementById("turno-entrada").value;
        const hora_salida = document.getElementById("turno-salida").value;
        const tolerancia_min = Number(document.getElementById("turno-tolerancia").value || 0);
        const descanso_min = Number(document.getElementById("turno-descanso").value || 0);
        const id_area = document.getElementById("turno-area")?.value || null;
        await apiFetch("/api/turnos", {
          method: "POST",
          body: JSON.stringify({
            id: id || null,
            nombre,
            hora_entrada,
            hora_salida,
            tolerancia_min,
            descanso_min,
            id_area
          })
        });
        showToast("Turno guardado correctamente", "success");
        STATE.activeDrawer = null;
        STATE.drawerData = null;
        await Promise.all([loadTurnos(), loadDashboard()]);
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }

  // --- Eventos Festivos ---
  document.getElementById("btn-open-new-festivo")?.addEventListener("click", () => openDrawer("festivo", null));

  document.getElementById("search-festivos-table")?.addEventListener("input", (e) => {
    STATE.searchFestivos = e.target.value;
    renderApp();
    const input = document.getElementById("search-festivos-table");
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });

  document.getElementById("btn-cargar-colombia")?.addEventListener("click", async () => {
    try {
      const anio = Number(document.getElementById("festivo-anio-col").value);
      const res = await apiFetch("/api/festivos/cargar-colombia", {
        method: "POST",
        body: JSON.stringify({ anio })
      });
      showToast(`Se cargaron ${res.cantidad} festivos de Colombia (${res.anio})`, "success");
      await loadFestivos();
      renderApp();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  document.querySelectorAll(".btn-del-festivo").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await apiFetch("/api/festivos/eliminar", {
          method: "POST",
          body: JSON.stringify({ fecha: btn.dataset.fecha })
        });
        showToast("Festivo eliminado", "info");
        await loadFestivos();
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  });

  const formFestivo = document.getElementById("form-festivo");
  if (formFestivo) {
    formFestivo.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await apiFetch("/api/festivos", {
          method: "POST",
          body: JSON.stringify({
            fecha: document.getElementById("festivo-fecha").value,
            descripcion: document.getElementById("festivo-desc").value
          })
        });
        showToast("Día festivo guardado", "success");
        STATE.activeDrawer = null;
        STATE.drawerData = null;
        await loadFestivos();
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }

  // --- Eventos Asignación de Turnos & Matriz Gantt ---
  document.querySelectorAll("[data-asig-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      STATE.asignacionModoVista = btn.dataset.asigMode;
      renderApp();
    });
  });

  const calPicker = document.getElementById("cal-month-picker");
  if (calPicker) {
    calPicker.addEventListener("change", async () => {
      STATE.calMonth = calPicker.value;
      STATE.selectedDates.clear();
      await loadAsignaciones();
      renderApp();
    });

    document.getElementById("search-emp-asig")?.addEventListener("input", (e) => {
      STATE.searchEmpAsignacion = e.target.value;
      renderApp();
      const input = document.getElementById("search-emp-asig");
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    });

    document.getElementById("btn-sel-all-emp")?.addEventListener("click", () => {
      STATE.empleados.forEach((e) => STATE.selectedEmployees.add(e.id_empleado));
      renderApp();
    });

    document.getElementById("btn-clear-emp")?.addEventListener("click", () => {
      STATE.selectedEmployees.clear();
      renderApp();
    });

    document.getElementById("btn-clear-dates")?.addEventListener("click", () => {
      STATE.selectedDates.clear();
      renderApp();
    });

    document.querySelectorAll(".emp-item").forEach((item) => {
      item.addEventListener("click", () => {
        const id = item.dataset.emp;
        if (STATE.selectedEmployees.has(id)) STATE.selectedEmployees.delete(id);
        else STATE.selectedEmployees.add(id);
        renderApp();
      });
    });

    document.querySelectorAll(".cal-day[data-date]").forEach((cell) => {
      cell.addEventListener("click", () => {
        const d = cell.dataset.date;
        if (STATE.selectedDates.has(d)) STATE.selectedDates.delete(d);
        else STATE.selectedDates.add(d);
        renderApp();
      });
    });

    const ejecutarAsignacion = async (esDescanso) => {
      try {
        const empleados = [...STATE.selectedEmployees];
        const fechas = [...STATE.selectedDates];
        const id_turno = document.getElementById("asig-turno-select")?.value;
        const observaciones = document.getElementById("asig-obs")?.value || "";
        const res = await apiFetch("/api/asignaciones/masivas", {
          method: "POST",
          body: JSON.stringify({
            empleados,
            fechas,
            id_turno: esDescanso ? null : Number(id_turno),
            es_descanso: esDescanso,
            observaciones
          })
        });
        showToast(`Se guardaron ${res.asignadas} asignaciones`, "success");
        STATE.selectedDates.clear();
        await Promise.all([loadAsignaciones(), loadDashboard()]);
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    };

    document.getElementById("btn-asignar-turno")?.addEventListener("click", () => ejecutarAsignacion(false));
    document.getElementById("btn-asignar-descanso")?.addEventListener("click", () => ejecutarAsignacion(true));

    document.getElementById("btn-eliminar-asig")?.addEventListener("click", async () => {
      try {
        const empleados = [...STATE.selectedEmployees];
        const fechas = [...STATE.selectedDates];
        const res = await apiFetch("/api/asignaciones/eliminar", {
          method: "POST",
          body: JSON.stringify({ empleados, fechas })
        });
        showToast(`Se eliminaron ${res.eliminadas} asignaciones`, "info");
        STATE.selectedDates.clear();
        await Promise.all([loadAsignaciones(), loadDashboard()]);
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    document.getElementById("btn-aplicar-patron")?.addEventListener("click", async () => {
      try {
        const empleados = [...STATE.selectedEmployees];
        const fecha_inicio = document.getElementById("pat-inicio").value;
        const fecha_fin = document.getElementById("pat-fin").value;
        const valTurno = document.getElementById("pat-turno").value;
        const es_descanso = valTurno === "DESCANSO";
        const id_turno = es_descanso ? null : Number(valTurno);
        const dias_semana = [...document.querySelectorAll(".pat-weekday:checked")].map((cb) => Number(cb.value));

        const res = await apiFetch("/api/asignaciones/patron", {
          method: "POST",
          body: JSON.stringify({
            empleados,
            fecha_inicio,
            fecha_fin,
            dias_semana,
            id_turno,
            es_descanso
          })
        });
        showToast(`Patrón aplicado: ${res.asignadas} turnos programados`, "success");
        await Promise.all([loadAsignaciones(), loadDashboard()]);
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }

  // --- Eventos Procesar Huellero (Individual o Agrupado por Área) ---
  document.getElementById("proc-area")?.addEventListener("change", (e) => {
    STATE.huelleroFiltroArea = e.target.value;
    STATE.huelleroFiltroEmpleado = "TODOS";
    renderApp();
  });

  document.getElementById("proc-empleado")?.addEventListener("change", (e) => {
    STATE.huelleroFiltroEmpleado = e.target.value;
  });

  const dropzone = document.getElementById("huellero-dropzone");
  const fileInput = document.getElementById("proc-files");
  if (dropzone && fileInput) {
    const handleHuelleroFiles = async (fileList) => {
      if (!fileList || fileList.length === 0) return;
      try {
        showToast("Analizando vista previa del Excel...", "info");
        const archivos = [];
        for (const f of fileList) {
          const b64 = await fileToBase64(f);
          archivos.push({ filename: f.name, content_base64: b64 });
        }
        STATE.huelleroFiles = archivos;
        const prev = await apiFetch("/api/previsualizar-huellero", {
          method: "POST",
          body: JSON.stringify({
            archivos,
            columna_id: document.getElementById("proc-col-id")?.value || "ID_Empleado",
            columna_fecha: document.getElementById("proc-col-fecha")?.value || "Fecha",
            columna_hora: document.getElementById("proc-col-hora")?.value || "Hora"
          })
        });
        STATE.huelleroPreview = prev;
        showToast(`Vista previa lista: ${prev.total_marcaciones} marcaciones detectadas`, "success");
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    };

    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
      handleHuelleroFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener("change", (e) => handleHuelleroFiles(e.target.files));
  }

  const formProc = document.getElementById("form-procesar-huellero");
  if (formProc) {
    formProc.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("btn-submit-procesar");
      try {
        btn.disabled = true;
        btn.textContent = "⏳ Validando horas extras y generando reportes...";
        const payload = {
          archivos: STATE.huelleroFiles || [],
          id_area: document.getElementById("proc-area")?.value || null,
          id_empleado: document.getElementById("proc-empleado")?.value || "TODOS",
          fecha_inicio: document.getElementById("proc-inicio").value,
          fecha_fin: document.getElementById("proc-fin").value,
          columna_id: document.getElementById("proc-col-id").value,
          columna_fecha: document.getElementById("proc-col-fecha").value,
          columna_hora: document.getElementById("proc-col-hora").value,
          incluir_marcaciones_app: document.getElementById("proc-incluir-app").checked,
          incluir_no_programados: document.getElementById("proc-no-programados").checked
        };
        const res = await apiFetch("/api/procesar-huellero", {
          method: "POST",
          body: JSON.stringify(payload)
        });
        showToast(`¡Listo! ${res.filas_generadas} jornadas validadas y ${res.reportes.length} reportes Excel generados`, "success");
        await Promise.all([loadReportes(), loadDashboard(), loadAnalisis()]);
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
        btn.disabled = false;
        btn.textContent = "⚙️ Validar Horas Extras y Generar Reporte Excel";
      }
    });
  }

  // --- Eventos Análisis, Gráficas y Hoja Imprimible ---
  document.querySelectorAll("[data-ana-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      STATE.analisisTab = btn.dataset.anaTab;
      renderApp();
    });
  });

  document.getElementById("hoja-emp-select")?.addEventListener("change", (e) => {
    STATE.hojaEmpleadoId = e.target.value;
    renderApp();
  });

  document.getElementById("btn-print-sheet")?.addEventListener("click", () => {
    window.print();
  });

  document.querySelectorAll("[data-kpi]").forEach((card) => {
    card.addEventListener("click", async () => {
      const key = card.dataset.kpi;
      STATE.analisisFiltros.kpi = STATE.analisisFiltros.kpi === key ? "" : key;
      await loadAnalisis();
      renderApp();
    });
  });

  document.getElementById("btn-aplicar-analisis")?.addEventListener("click", async () => {
    STATE.analisisFiltros.id_area = document.getElementById("ana-area")?.value || "";
    STATE.analisisFiltros.id_empleado = document.getElementById("ana-emp").value;
    STATE.analisisFiltros.fecha_inicio = document.getElementById("ana-inicio").value;
    STATE.analisisFiltros.fecha_fin = document.getElementById("ana-fin").value;
    await loadAnalisis();
    renderApp();
  });

  document.getElementById("btn-exportar-novedades")?.addEventListener("click", async () => {
    try {
      const res = await apiFetch("/api/exportar-novedades", {
        method: "POST",
        body: JSON.stringify(STATE.analisisFiltros)
      });
      showToast("Reporte de 6 pestañas generado", "success");
      window.open(res.url, "_blank");
      await loadReportes();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  // --- Eventos Base de Empleados (con Área, Filtros y Drawers) ---
  document.getElementById("btn-open-new-emp")?.addEventListener("click", () => openDrawer("empleado", null));
  document.getElementById("btn-open-import-emp")?.addEventListener("click", () => openDrawer("importar_empleados", null));

  document.getElementById("filter-area-empleados")?.addEventListener("change", (e) => {
    STATE.filtroAreaEmpleados = e.target.value;
    renderApp();
  });

  document.getElementById("search-empleados-table")?.addEventListener("input", (e) => {
    STATE.searchEmpleados = e.target.value;
    renderApp();
    const input = document.getElementById("search-empleados-table");
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });

  document.querySelectorAll(".btn-edit-emp").forEach((btn) => {
    btn.addEventListener("click", () => {
      openDrawer("empleado", {
        id_empleado: btn.dataset.id,
        nombre: btn.dataset.nombre,
        cargo: btn.dataset.cargo,
        pin: btn.dataset.pin,
        id_area: btn.dataset.area || ""
      });
    });
  });

  document.querySelectorAll(".btn-del-emp").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await apiFetch("/api/empleados/eliminar", {
          method: "POST",
          body: JSON.stringify({ id_empleado: btn.dataset.id })
        });
        showToast("Empleado eliminado", "info");
        await Promise.all([loadEmpleados(), loadAreas(), loadDashboard()]);
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  });

  const empDrop = document.getElementById("emp-dropzone");
  const empInput = document.getElementById("import-emp-excel");
  if (empDrop && empInput) {
    const uploadEmpExcel = async (file) => {
      if (!file) return;
      try {
        const b64 = await fileToBase64(file);
        const id_area_default = document.getElementById("import-emp-area-default")?.value || null;
        const res = await apiFetch("/api/empleados/importar-excel", {
          method: "POST",
          body: JSON.stringify({ filename: file.name, content_base64: b64, id_area_default })
        });
        showToast(`¡Se importaron ${res.importados} empleados en la Base de Datos!`, "success");
        STATE.activeDrawer = null;
        STATE.drawerData = null;
        await Promise.all([loadEmpleados(), loadAreas(), loadDashboard()]);
        if (STATE.empleados.length > 0 && STATE.selectedEmployees.size === 0) {
          STATE.selectedEmployees.add(STATE.empleados[0].id_empleado);
        }
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    };
    empDrop.addEventListener("click", () => empInput.click());
    empDrop.addEventListener("dragover", (e) => {
      e.preventDefault();
      empDrop.classList.add("dragover");
    });
    empDrop.addEventListener("dragleave", () => empDrop.classList.remove("dragover"));
    empDrop.addEventListener("drop", (e) => {
      e.preventDefault();
      empDrop.classList.remove("dragover");
      uploadEmpExcel(e.dataTransfer.files?.[0]);
    });
    empInput.addEventListener("change", (e) => uploadEmpExcel(e.target.files?.[0]));
  }

  const formEmp = document.getElementById("form-empleado");
  if (formEmp) {
    formEmp.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await apiFetch("/api/empleados", {
          method: "POST",
          body: JSON.stringify({
            id_empleado: document.getElementById("emp-id").value,
            nombre: document.getElementById("emp-nombre").value,
            cargo: document.getElementById("emp-cargo").value,
            pin: document.getElementById("emp-pin").value,
            id_area: document.getElementById("emp-area").value || null
          })
        });
        showToast("Empleado guardado con su Área", "success");
        STATE.activeDrawer = null;
        STATE.drawerData = null;
        await Promise.all([loadEmpleados(), loadAreas(), loadDashboard()]);
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }

  // --- Eventos Responder Solicitudes (Supervisor avala -> Talento Humano aprueba) ---
  document.querySelectorAll(".btn-resp-sol").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await apiFetch("/api/solicitudes/responder", {
          method: "POST",
          body: JSON.stringify({
            id: Number(btn.dataset.id),
            estado: btn.dataset.estado,
            autor_rol: STATE.user.role,
            autor_nombre: STATE.user.nombre,
            respuesta_admin: `Gestionado por ${STATE.user.nombre} (${STATE.user.role})`
          })
        });
        showToast(`Solicitud actualizada: ${btn.dataset.estado}`, "success");
        await Promise.all([loadSolicitudes(), loadDashboard(), loadNotificaciones(false)]);
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  });
}

// ============================================================================
// PORTAL / APP MÓVIL DEL EMPLEADO (CON BUZÓN DE MEMORANDOS + NOTIFICACIONES)
// ============================================================================

const EMP_NAV = [
  { id: "emp_reloj", lucide: "clock", label: "Reloj GPS & Selfie", short: "Marcar" },
  { id: "emp_comunicados", lucide: "megaphone", label: "Memorandos y Capacitaciones", short: "Memorandos" },
  { id: "emp_turnos", lucide: "calendar-days", label: "Mis Turnos", short: "Mis Turnos" },
  { id: "emp_horas", lucide: "coins", label: "Horas Extra y Recargos", short: "Mis Horas" },
  { id: "emp_permisos", lucide: "file-text", label: "Solicitar Permiso", short: "Permisos" }
];

function renderEmpleadoLayout() {
  const currentNav = EMP_NAV.find((n) => n.id === STATE.activeView) || EMP_NAV[0];
  const r = STATE.empResumen || { comunicados: [] };
  const memosSinLeer = (r.comunicados || []).filter((c) => !c.leido_por_mi).length;

  return `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar-brand">
          <img src="/api/branding/logo" alt="Sterinova" onerror="this.style.display='none'" />
        </div>
        <div class="sidebar-user">
          <div class="avatar-circle">${STATE.user.nombre.charAt(0)}</div>
          <div>
            <div style="font-weight:700; font-size:0.9rem;">${STATE.user.nombre}</div>
            <div style="font-size:0.74rem; opacity:0.85;">ID: ${STATE.user.id} | ${STATE.user.nombre_area || "Área"}</div>
          </div>
        </div>
        <div class="sidebar-section-label">Portal del Colaborador</div>
        <nav class="sidebar-nav">
          ${EMP_NAV.map(
            (item) => `
            <button type="button" class="nav-btn ${STATE.activeView === item.id ? "active" : ""}" data-view="${item.id}">
              ${icon(item.lucide, 18)}
              <span>${item.label}</span>
              ${
                item.id === "emp_comunicados" && memosSinLeer > 0
                  ? `<span class="nav-step-badge" style="background:#EF4444;">${memosSinLeer} Nuevo</span>`
                  : ""
              }
            </button>
          `
          ).join("")}
        </nav>
        <div class="sidebar-footer">
          <button type="button" id="btn-emp-logout" class="btn btn-danger btn-block btn-sm">
            ${icon("log-out", 15)} Cerrar Sesión
          </button>
        </div>
      </aside>

      <div class="main-area">
        <header class="topbar">
          <div class="topbar-left">
            <div class="topbar-title">${icon(currentNav.lucide, 19)} <span>${currentNav.label}</span></div>
          </div>
          <div class="topbar-right">
            <button type="button" id="btn-emp-notifs" class="icon-btn" title="Notificaciones">
              ${icon("bell", 17)}
              <span id="notif-bell-count" class="notif-dot" style="display:${
                STATE.notificacionesNoLeidas > 0 ? "inline-flex" : "none"
              };">${STATE.notificacionesNoLeidas}</span>
            </button>
            <button type="button" id="btn-emp-theme" class="icon-btn" title="${STATE.darkMode ? "Modo claro" : "Modo oscuro"}">
              ${STATE.darkMode ? icon("sun", 17) : icon("moon", 17)}
            </button>
            <button type="button" id="btn-emp-top-logout" class="icon-btn icon-btn-danger mobile-only-btn" title="Cerrar Sesión">
              ${icon("log-out", 17)}
            </button>
          </div>
        </header>

        <main class="content-container" style="max-width:960px;">
          ${renderNotificationsBanner()}
          ${renderEmpleadoViewContent()}
        </main>
      </div>

      ${renderActiveDrawer()}

      <nav class="bottom-nav">
        ${EMP_NAV.slice(0, 3)
          .map(
            (item) => `
          <button type="button" class="bottom-nav-item ${STATE.activeView === item.id ? "active" : ""}" data-view="${item.id}">
            ${icon(item.lucide, 18)}
            <span>${item.short}</span>
          </button>
        `
          )
          .join("")}
        <button type="button" class="bottom-nav-item" id="btn-emp-mobile-menu">
          ${icon("menu", 18)}
          <span>Menú</span>
        </button>
      </nav>
    </div>
  `;
}

function renderEmpleadoViewContent() {
  const r = STATE.empResumen || {
    turno_hoy: null,
    proximos_turnos: [],
    asignaciones: [],
    kpis: { horas_extra: 0, minutos_tardanza: 0, ausencias: 0, llegadas_tempranas: 0 },
    historial: [],
    marcaciones_moviles: [],
    solicitudes: [],
    comunicados: []
  };

  if (STATE.activeView === "emp_comunicados") {
    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title">📢 Mis Memorandos, Citaciones a Capacitación y Comunicados (${r.comunicados.length})</div>
        </div>
        ${
          r.comunicados.length === 0
            ? `<p style="padding:20px; text-align:center; color:var(--texto-sec);">No tienes memorandos ni citaciones a capacitación en este momento.</p>`
            : r.comunicados
                .map(
                  (c) => `
            <div class="card" style="border-left:5px solid ${c.leido_por_mi ? "#10B981" : "#E64A19"}; margin-bottom:14px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <span class="badge badge-info">${c.tipo}</span>
                <small style="color:var(--texto-sec);">Enviado por ${c.autor} — ${c.creado_en}</small>
              </div>
              <div style="font-size:1.08rem; font-weight:800; color:var(--petroleo); margin-bottom:6px;">
                ${c.titulo}
              </div>
              ${
                c.fecha_evento
                  ? `<div style="font-size:0.88rem; font-weight:700; color:var(--naranja); margin-bottom:8px;">📅 Fecha/Hora Citación: ${c.fecha_evento}</div>`
                  : ""
              }
              <p style="font-size:0.92rem; margin-bottom:12px;">${c.mensaje}</p>
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <small style="color:var(--texto-sec);">Alcance: ${c.destino_etiqueta}</small>
                ${
                  c.leido_por_mi
                    ? `<span class="badge badge-ok">✔ Lectura Confirmada</span>`
                    : `<button type="button" class="btn btn-primary btn-sm btn-confirmar-memo" data-id="${c.id}">
                        ✋ Confirmar Enterado / Recibido
                      </button>`
                }
              </div>
            </div>
          `
                )
                .join("")
        }
      </div>
    `;
  }

  if (STATE.activeView === "emp_reloj") {
    const now = new Date();
    const timeStr = now.toTimeString().slice(0, 8);
    const dateStr = now.toLocaleDateString("es-CO", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    });
    const memosSinLeer = (r.comunicados || []).filter((c) => !c.leido_por_mi);

    return `
      ${
        memosSinLeer.length > 0
          ? `
        <div class="alert-banner alert-warning">
          <div>
            <strong>📢 Tienes ${memosSinLeer.length} Memorando(s) / Citación a Capacitación sin confirmar:</strong> "${memosSinLeer[0].titulo}"
          </div>
          <button type="button" class="btn btn-action btn-sm" data-view="emp_comunicados">
            Ver Memorando →
          </button>
        </div>
      `
          : ""
      }

      <div class="clock-widget">
        <div style="font-size:0.85rem; text-transform:uppercase; letter-spacing:1px; opacity:0.85;">
          Reloj Biométrico Móvil Sterinova — Área: ${r.nombre_area || STATE.user.nombre_area || "General"}
        </div>
        <div class="clock-time" id="live-clock-time">${timeStr}</div>
        <div class="clock-date">${dateStr}</div>
        <div id="gps-status-badge" style="font-size:0.83rem; margin-bottom:14px; opacity:0.95; line-height:1.5;">
          ${
            STATE.gpsActual
              ? `📍 <strong>Coordenadas:</strong> ${STATE.gpsActual.latitud}, ${STATE.gpsActual.longitud} (±${STATE.gpsActual.precision_m}m)<br/>🏠 <strong>Dirección:</strong> ${STATE.gpsActual.direccion || "Calculando..."}`
              : "📍 Obteniendo coordenadas GPS y dirección física..."
          }
        </div>

        <div style="max-width:440px; margin:0 auto 14px;">
          ${
            STATE.selfieBase64
              ? `
            <div class="camera-preview-box">
              <img src="${STATE.selfieBase64}" alt="Selfie capturada" />
            </div>
            <button type="button" id="btn-clear-selfie" class="btn btn-outline btn-sm" style="margin-bottom:10px; background:rgba(255,255,255,0.15); color:#fff; border-color:#fff;">
              🔄 Tomar otra foto
            </button>
          `
              : `
            <div id="camera-container" class="camera-preview-box" style="display:none;">
              <video id="camera-video" autoplay playsinline></video>
            </div>
            <div style="display:flex; justify-content:center; gap:8px; margin-bottom:10px;">
              <button type="button" id="btn-toggle-camera" class="btn btn-outline btn-sm" style="background:rgba(255,255,255,0.15); color:#fff; border-color:rgba(255,255,255,0.5);">
                📷 Activar Cámara Selfie (Opcional)
              </button>
              <button type="button" id="btn-snap-selfie" class="btn btn-action btn-sm" style="display:none;">
                📸 Capturar Foto
              </button>
            </div>
          `
          }
          <input
            type="text"
            id="emp-nota-marcacion"
            class="form-control"
            placeholder="Nota opcional (ej: Ingreso turno mañana)"
            value="${STATE.notaMarcacion}"
            style="background:rgba(255,255,255,0.92); color:#0F172A; font-size:0.86rem;"
          />
        </div>

        <div class="clock-actions">
          <button type="button" class="btn-punch-in" data-punch="ENTRADA">
            🟢 MARCAR ENTRADA
          </button>
          <button type="button" class="btn-punch-out" data-punch="SALIDA">
            🟠 MARCAR SALIDA
          </button>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">📅 Mi Turno Programado para Hoy</div>
        </div>
        ${
          r.turno_hoy
            ? `
          <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
            <div>
              <div style="font-size:1.15rem; font-weight:800; color:var(--petroleo);">${r.turno_hoy.nombre_turno}</div>
              <div style="color:var(--texto-sec); font-size:0.92rem;">
                ${
                  r.turno_hoy.es_descanso
                    ? "Hoy tienes día de descanso programado"
                    : `Horario: ${r.turno_hoy.hora_entrada} a ${r.turno_hoy.hora_salida}`
                }
              </div>
            </div>
            <span class="badge ${r.turno_hoy.es_descanso ? "badge-ok" : "badge-info"}" style="font-size:0.9rem; padding:6px 14px;">
              ${r.turno_hoy.es_descanso ? "🏖️ DESCANSO" : "🕒 TURNO ACTIVO"}
            </span>
          </div>
        `
            : `<p style="color:var(--texto-sec);">No tienes un turno específico asignado para la fecha de hoy.</p>`
        }
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">📲 Mis Últimas Marcaciones (Dirección, Coordenadas y Selfie) (${r.marcaciones_moviles.length})</div>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Fecha y Hora</th>
                <th>Tipo</th>
                <th>Foto / Nota</th>
                <th>Dirección Física</th>
                <th>Coordenadas GPS</th>
              </tr>
            </thead>
            <tbody>
              ${
                r.marcaciones_moviles.length === 0
                  ? `<tr><td colspan="5" style="text-align:center; padding:18px;">Pulsa "Marcar Entrada" o "Marcar Salida" arriba para registrar tu asistencia con dirección y coordenadas.</td></tr>`
                  : r.marcaciones_moviles
                      .map(
                        (m) => `
                  <tr>
                    <td><strong>${m.fecha_hora}</strong></td>
                    <td>
                      <span class="badge ${m.tipo === "ENTRADA" ? "badge-ok" : "badge-warn"}">${m.tipo}</span>
                    </td>
                    <td>
                      ${
                        m.foto_base64
                          ? `<img src="${m.foto_base64}" alt="Selfie" style="width:38px; height:38px; border-radius:6px; object-fit:cover; display:block;" />`
                          : ""
                      }
                      <small>${m.observaciones || "—"}</small>
                    </td>
                    <td><strong>${m.direccion || "Sin dirección"}</strong></td>
                    <td>${
                      m.latitud != null && m.longitud != null
                        ? `<code>${m.latitud}, ${m.longitud}</code> (±${m.precision_m || 0}m)`
                        : "—"
                    }</td>
                  </tr>
                `
                      )
                      .join("")
              }
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  if (STATE.activeView === "emp_turnos") {
    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title">🗓️ Mi Calendario de Turnos y Descansos Asignados (${r.asignaciones.length})</div>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Turno Asignado</th>
                <th>Horario</th>
                <th>Observaciones</th>
              </tr>
            </thead>
            <tbody>
              ${
                r.asignaciones.length === 0
                  ? `<tr><td colspan="4" style="text-align:center; padding:22px;">Aún no tienes turnos asignados en este período.</td></tr>`
                  : r.asignaciones
                      .map(
                        (a) => `
                  <tr>
                    <td><strong>${a.fecha}</strong></td>
                    <td>
                      <span class="badge ${a.es_descanso ? "badge-ok" : "badge-info"}">${a.nombre_turno}</span>
                    </td>
                    <td>${a.es_descanso ? "Libre" : `${a.hora_entrada} - ${a.hora_salida}`}</td>
                    <td>${a.observaciones || "—"}</td>
                  </tr>
                `
                      )
                      .join("")
              }
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  if (STATE.activeView === "emp_horas") {
    return `
      <div class="grid-4" style="margin-bottom:18px;">
        <div class="kpi-card">
          <div class="kpi-label">Mis Horas Extras</div>
          <div class="kpi-value">${Number(r.kpis.horas_extra || 0).toFixed(2)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Min. Tardanza</div>
          <div class="kpi-value">${r.kpis.minutos_tardanza || 0}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Ausencias</div>
          <div class="kpi-value">${r.kpis.ausencias || 0}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Llegadas Tempranas</div>
          <div class="kpi-value">${r.kpis.llegadas_tempranas || 0}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">💰 Historial de Jornadas, Horas Extra y Recargos</div>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Turno</th>
                <th>Entrada / Salida</th>
                <th>H. Extra</th>
                <th>Desglose</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              ${
                r.historial.length === 0
                  ? `<tr><td colspan="6" style="text-align:center; padding:22px;">Sin registros liquidados para tu ID en el período actual.</td></tr>`
                  : r.historial
                      .map(
                        (h) => `
                  <tr>
                    <td><strong>${h.fecha}</strong></td>
                    <td>${h.turno}</td>
                    <td>${h.hora_entrada_real || "—"} a ${h.hora_salida_real || "—"}</td>
                    <td><strong>${Number(h.horas_extra).toFixed(2)}</strong></td>
                    <td><small>${h.desglose}</small></td>
                    <td><span class="badge badge-info">${h.estado}</span></td>
                  </tr>
                `
                      )
                      .join("")
              }
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  if (STATE.activeView === "emp_permisos") {
    return `
      <div class="corp-toolbar">
        <div class="corp-toolbar-left">
          <span style="font-size:0.86rem; color:var(--texto-sec); font-weight:600;">
            Mis Solicitudes de Permiso y Cambio de Turno (${r.solicitudes.length})
          </span>
        </div>
        <div class="corp-toolbar-right">
          <button type="button" id="btn-open-new-sol" class="btn btn-primary btn-sm">
            ${icon("plus", 15)} Nueva Solicitud
          </button>
        </div>
      </div>

      <div class="corp-table-card">
        <div class="table-responsive" style="max-height:calc(100vh - 210px);">
          <table>
            <thead>
              <tr>
                <th>Tipo</th>
                <th>Fechas</th>
                <th>Motivo</th>
                <th>Estado en el Flujo</th>
              </tr>
            </thead>
            <tbody>
              ${
                r.solicitudes.length === 0
                  ? `<tr><td colspan="4" style="text-align:center; padding:28px; color:var(--texto-sec);">No has enviado solicitudes todavía. Pulsa "Nueva Solicitud".</td></tr>`
                  : r.solicitudes
                      .map(
                        (s) => `
                  <tr>
                    <td><strong>${s.tipo}</strong></td>
                    <td>${s.fecha_inicio} a ${s.fecha_fin}</td>
                    <td>${s.motivo}</td>
                    <td>
                      <span class="badge ${
                        s.estado === "APROBADA"
                          ? "badge-ok"
                          : s.estado.includes("RECHAZADA")
                          ? "badge-danger"
                          : s.estado === "AVALADO_SUPERVISOR"
                          ? "badge-info"
                          : "badge-warn"
                      }">${s.estado}</span>
                    </td>
                  </tr>
                `
                      )
                      .join("")
              }
            </tbody>
          </table>
        </div>
      </div>
    `;
  }
}

function bindEmpleadoEvents() {
  document.getElementById("btn-emp-theme")?.addEventListener("click", toggleDarkMode);
  document.getElementById("btn-emp-notifs")?.addEventListener("click", () => {
    STATE.showNotifModal = !STATE.showNotifModal;
    renderApp();
  });
  document.getElementById("btn-close-notifs")?.addEventListener("click", () => {
    STATE.showNotifModal = false;
    renderApp();
  });
  document.querySelectorAll(".btn-read-notif").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await apiFetch("/api/notificaciones/leer", {
        method: "POST",
        body: JSON.stringify({ id: Number(btn.dataset.id) })
      });
      await loadNotificaciones(false);
      renderApp();
    });
  });

  document.querySelectorAll(".btn-confirmar-memo").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await apiFetch("/api/comunicados/leer", {
          method: "POST",
          body: JSON.stringify({
            id_comunicado: Number(btn.dataset.id),
            id_empleado: STATE.user.id
          })
        });
        showToast("✔ Has confirmado la lectura del memorando", "success");
        await loadEmpleadoResumen();
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  });

  document.querySelectorAll("[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      stopCameraStream();
      STATE.activeView = btn.dataset.view;
      renderApp();
    });
  });

  const logout = () => setUser(null);
  document.getElementById("btn-emp-logout")?.addEventListener("click", logout);
  document.getElementById("btn-emp-top-logout")?.addEventListener("click", logout);

  document.getElementById("btn-toggle-camera")?.addEventListener("click", async () => {
    try {
      const box = document.getElementById("camera-container");
      const video = document.getElementById("camera-video");
      const snapBtn = document.getElementById("btn-snap-selfie");
      if (!navigator.mediaDevices?.getUserMedia) {
        showToast("Tu navegador no permite acceso directo a cámara", "error");
        return;
      }
      STATE.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 360 }, height: { ideal: 280 } },
        audio: false
      });
      video.srcObject = STATE.cameraStream;
      box.style.display = "block";
      snapBtn.style.display = "inline-flex";
    } catch {
      showToast("No se pudo acceder a la cámara", "error");
    }
  });

  document.getElementById("btn-snap-selfie")?.addEventListener("click", () => {
    const video = document.getElementById("camera-video");
    if (!video) return;
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    STATE.selfieBase64 = canvas.toDataURL("image/jpeg", 0.72);
    stopCameraStream();
    renderApp();
  });

  document.getElementById("btn-clear-selfie")?.addEventListener("click", () => {
    STATE.selfieBase64 = "";
    renderApp();
  });

  document.querySelectorAll("[data-punch]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        const tipo = btn.dataset.punch;
        const nota = document.getElementById("emp-nota-marcacion")?.value || "";
        if (STATE.gpsActual && !STATE.gpsActual.direccion && STATE.gpsActual.latitud != null) {
          STATE.gpsActual.direccion = await resolverDireccionPorCoordenadas(
            STATE.gpsActual.latitud,
            STATE.gpsActual.longitud
          );
        }
        const payload = {
          id_empleado: STATE.user.id,
          tipo,
          latitud: STATE.gpsActual?.latitud ?? null,
          longitud: STATE.gpsActual?.longitud ?? null,
          precision_m: STATE.gpsActual?.precision_m ?? null,
          direccion: STATE.gpsActual?.direccion || "",
          observaciones: nota,
          foto_base64: STATE.selfieBase64 || "",
          dispositivo: navigator.userAgent.includes("Mobile") ? "App Celular" : "Navegador Web"
        };
        const res = await apiFetch("/api/empleado/marcar", {
          method: "POST",
          body: JSON.stringify(payload)
        });
        STATE.selfieBase64 = "";
        STATE.notaMarcacion = "";
        showToast(
          `¡${tipo} registrada! ${res.direccion ? `Ubicación: ${res.direccion}` : res.fecha_hora}`,
          "success"
        );
        await loadEmpleadoResumen();
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  });

  document.getElementById("btn-open-new-sol")?.addEventListener("click", () => openDrawer("emp_solicitud", null));
  document.getElementById("btn-emp-mobile-menu")?.addEventListener("click", () => openDrawer("mobile_menu", null));
  document.getElementById("btn-mobile-drawer-logout")?.addEventListener("click", () => {
    STATE.activeDrawer = null;
    setUser(null);
  });
  document.querySelectorAll("[data-mobile-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      stopCameraStream();
      STATE.activeView = btn.dataset.mobileView;
      STATE.activeDrawer = null;
      renderApp();
    });
  });
  document.getElementById("btn-close-drawer")?.addEventListener("click", closeDrawer);
  document.getElementById("btn-cancel-drawer")?.addEventListener("click", closeDrawer);
  document.getElementById("drawer-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "drawer-backdrop") closeDrawer();
  });

  const formSol = document.getElementById("form-emp-solicitud");
  if (formSol) {
    formSol.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await apiFetch("/api/empleado/solicitud", {
          method: "POST",
          body: JSON.stringify({
            id_empleado: STATE.user.id,
            tipo: document.getElementById("sol-tipo").value,
            fecha_inicio: document.getElementById("sol-inicio").value,
            fecha_fin: document.getElementById("sol-fin").value,
            motivo: document.getElementById("sol-motivo").value
          })
        });
        showToast("Solicitud enviada a tu Supervisor de Área", "success");
        STATE.activeDrawer = null;
        STATE.drawerData = null;
        await loadEmpleadoResumen();
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }
}

setInterval(() => {
  const el = document.getElementById("live-clock-time");
  if (el) {
    el.textContent = new Date().toTimeString().slice(0, 8);
  }
}, 1000);

window.addEventListener("DOMContentLoaded", () => {
  initRoleData();
});

