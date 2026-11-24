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
  darkMode: localStorage.getItem("sterinova_dark") === "true",`r`n  loginMode: "corporativo", // "corporativo" | "colaborador"
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
    refreshLucideIcons();
  } else {
    root.innerHTML = renderManagementLayout();
    bindManagementEvents();
    refreshLucideIcons();
    setTimeout(() => {
      if (STATE.activeView === "analisis" || STATE.activeView === "dashboard") {
        initAnalisisCharts();
      }
      if (STATE.activeView === "gps_solicitudes") {
        initGpsLeafletMap();
      }
    }, 60);
  }
}

// ============================================================================
// LOGIN CORPORATIVO ENTERPRISE SPLIT-SCREEN (6 ROLES)
// ============================================================================

function renderLoginScreen() {`r`n  const isColab = STATE.loginMode === "colaborador";
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

          <div class="login-mode-tabs" role="tablist">`r`n            <button type="button" class="login-mode-tab ${!isColab ? "active" : ""}" data-login-mode="corporativo">`r`n              ${icon("briefcase", 15)} Gestión Corporativa`r`n            </button>`r`n            <button type="button" class="login-mode-tab ${isColab ? "active" : ""}" data-login-mode="colaborador">`r`n              ${icon("user-circle", 15)} Soy Colaborador`r`n            </button>`r`n          </div>`r`n`r`n          <form id="form-login-unificado">
            <div class="form-group">
              <label class="form-label" for="login-identificador">
                ${isColab ? "ID Biométrico / Número de Cédula" : "Usuario Corporativo"}
              </label>
              <div class="login-input-group">
                <span class="login-input-icon">${icon(isColab ? "id-card" : "user", 17)}</span>
                <input
                  type="text"
                  id="login-identificador"
                  class="form-control"
                  placeholder="${isColab ? "Ej: 1003001750 o código de huella" : "Ej: usuario corporativo"}"
                  autocomplete="username"
                  required
                />
              </div>
            </div>

            <div class="form-group">
              <label class="form-label" for="login-clave">
                ${isColab ? "PIN de Acceso Móvil" : "Contraseña"}
              </label>
              <div class="login-input-group">
                <span class="login-input-icon">${icon("lock", 17)}</span>
                <input
                  type="${STATE.showPassword ? "text" : "password"}"
                  id="login-clave"
                  class="form-control"
                  placeholder="${isColab ? "Ingresa tu PIN numérico" : "Ingresa tu contraseña"}"
                  autocomplete="current-password"
                  required
                />
                <button type="button" id="btn-toggle-pass" class="login-eye-btn" title="Mostrar u ocultar contraseña">
                  ${icon(STATE.showPassword ? "eye-off" : "eye", 17)}
                </button>
              </div>
            </div>

            <button type="submit" id="btn-submit-login" class="btn btn-primary btn-block" style="margin-top:16px; padding:13px; font-size:0.95rem;">
              ${icon("log-in", 17)} ${isColab ? "Ingresar al Portal del Colaborador" : "Iniciar Sesión Corporativa"}
            </button>
          </form>

          ${
            STATE.deferredInstallPrompt
              ? `
            <button type="button" id="btn-install-pwa-login" class="btn btn-outline btn-block" style="margin-top:12px;">
              ${icon("smartphone", 17)} Instalar App de Sterinova en este Dispositivo
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
  document.getElementById("btn-theme-login")?.addEventListener("click", toggleDarkMode);`r`n`r`n  document.querySelectorAll("[data-login-mode]").forEach((btn) => {`r`n    btn.addEventListener("click", () => {`r`n      STATE.loginMode = btn.dataset.loginMode;`r`n      renderApp();`r`n      setTimeout(() => document.getElementById("login-identificador")?.focus(), 20);`r`n    });`r`n  });

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
      { id: "turnos", lucide: "clock", label: "Turnos de Mi Área", step: "PASO 1", short: "Turnos" },
      { id: "asignacion", lucide: "calendar-range", label: "Asignar Turnos & Gantt", step: "PASO 2", short: "Asignar" },
      { id: "procesar", lucide: "file-spreadsheet", label: "Validar Huellero y Reportes", step: "PASO 3", short: "Huellero" },
      { id: "analisis", lucide: "bar-chart-3", label: "Horas Extra y Hoja PDF", step: "PASO 4", short: "Horas Extra" },
      { id: "gps_solicitudes", lucide: "map-pin", label: "Permisos y Mapa GPS", step: "MI EQUIPO", short: "Permisos/GPS" }
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
          <div>
            <div class="topbar-breadcrumb">STERINOVA WORKFORCE / ${roleInfo.text}</div>
            <div class="topbar-title">${icon(currentNav.lucide || "layout-grid", 20)} <span>${currentNav.label}</span></div>
          </div>
          <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
            <button type="button" id="btn-toggle-notifs" class="btn btn-outline btn-sm" style="position:relative;">
              ${icon("bell", 16)} <span>Notificaciones</span>
              <span id="notif-bell-count" class="badge badge-danger" style="margin-left:4px; display:${
                STATE.notificacionesNoLeidas > 0 ? "inline-flex" : "none"
              };">${STATE.notificacionesNoLeidas}</span>
            </button>
            <button type="button" id="btn-toggle-theme" class="btn btn-outline btn-sm">
              ${STATE.darkMode ? `${icon("sun", 16)} Claro` : `${icon("moon", 16)} Oscuro`}
            </button>
            ${
              STATE.deferredInstallPrompt
                ? `<button type="button" id="btn-install-pwa" class="btn btn-action btn-sm">${icon("smartphone", 16)} Instalar App</button>`
                : ""
            }
            <span class="badge badge-info">${icon(roleInfo.lucide, 14)} ${roleInfo.text}</span>
            <button type="button" id="btn-top-logout" class="btn btn-danger btn-sm">
              ${icon("log-out", 15)} Salir
            </button>
          </div>
        </header>

        <main class="content-container">
          ${renderNotificationsBanner()}
          ${renderManagementViewContent()}
        </main>
      </div>

      <nav class="bottom-nav">
        ${navItems
          .slice(0, 6)
          .map(
            (item) => `
          <button type="button" class="bottom-nav-item ${STATE.activeView === item.id ? "active" : ""}" data-view="${item.id}">
            ${icon(item.lucide || "circle", 18)}
            <span>${item.short}</span>
          </button>
        `
          )
          .join("")}
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
// 1. VISTA SUPERADMIN: GESTIÓN LIBRE DE ÁREAS Y CREACIÓN DE LOS 6 ROLES
// ============================================================================

function renderSuperadminAreasYUsuarios() {
  const qUsr = (STATE.searchUsuarios || "").toLowerCase();
  const usuariosFiltrados = STATE.usuarios.filter(
    (u) =>
      u.username.toLowerCase().includes(qUsr) ||
      u.nombre.toLowerCase().includes(qUsr) ||
      (u.nombre_area || "").toLowerCase().includes(qUsr) ||
      u.rol.toLowerCase().includes(qUsr)
  );

  return `
    <div class="alert-banner alert-ok">
      <div>
        <strong>${icon("shield-check", 16)} Configuración Organizacional (Superadmin):</strong> 1) Define las <strong>Áreas</strong> de la empresa. 2) Crea a los <strong>Supervisores</strong> (ligados a su Área), al <strong>Auditor de Horas Extras</strong>, a <strong>Talento Humano</strong> y al <strong>Admin General</strong>.
      </div>
      <button type="button" class="btn btn-primary btn-sm" data-goto="empleados">
        ${icon("users", 15)} Ir a Base de Empleados →
      </button>
    </div>

    <div class="grid-2">
      <!-- Módulo de Áreas -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">${icon("building-2", 18)} <span>1. Gestión de Áreas de la Empresa (${STATE.areas.length})</span></div>
        </div>
        <form id="form-area">
          <input type="hidden" id="area-id" value="" />
          <div class="grid-2">
            <div class="form-group">
              <label class="form-label">Nombre del Área</label>
              <input type="text" id="area-nombre" class="form-control" placeholder="Ej: Producción, Calidad, Conductores..." required />
            </div>
            <div class="form-group">
              <label class="form-label">Descripción</label>
              <input type="text" id="area-desc" class="form-control" placeholder="Descripción opcional" />
            </div>
          </div>
          <div style="display:flex; gap:8px; margin-bottom:16px;">
            <button type="submit" class="btn btn-primary" style="flex:1;">${icon("save", 16)} Guardar Área</button>
            <button type="button" id="btn-limpiar-area" class="btn btn-outline">Limpiar</button>
          </div>
        </form>

        <div class="table-responsive" style="max-height:260px;">
          <table>
            <thead>
              <tr>
                <th>Área</th>
                <th>Supervisores</th>
                <th>Empleados</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${STATE.areas
                .map(
                  (a) => `
                <tr>
                  <td><strong>${a.nombre}</strong><br/><small style="color:var(--texto-sec);">${a.descripcion}</small></td>
                  <td><span class="badge badge-info">${a.total_supervisores} sup.</span></td>
                  <td><span class="badge badge-ok">${a.total_empleados} emp.</span></td>
                  <td>
                    <button type="button" class="btn btn-outline btn-sm btn-edit-area" data-id="${a.id}" data-nombre="${a.nombre}" data-desc="${a.descripcion}">${icon("pencil", 14)} Editar</button>
                    <button type="button" class="btn btn-danger btn-sm btn-del-area" data-id="${a.id}">${icon("trash-2", 14)}</button>
                  </td>
                </tr>
              `
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Módulo de Usuarios y Roles -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">${icon("user-plus", 18)} <span>2. Crear / Asignar Usuarios por Rol y Área</span></div>
        </div>
        <form id="form-usuario-sistema">
          <div class="grid-2">
            <div class="form-group">
              <label class="form-label">Usuario de Ingreso (Username)</label>
              <input type="text" id="usr-username" class="form-control" placeholder="Ej: sup_produccion, auditor1, rrhh" required />
            </div>
            <div class="form-group">
              <label class="form-label">Rol del Usuario</label>
              <select id="usr-rol" class="form-control">
                <option value="supervisor">Supervisor de Área (Turnos, Huellero y Permisos de su Área)</option>
                <option value="auditor">Auditor de Horas Extras (Control y Reportes de Horas Extra)</option>
                <option value="talento_humano">Talento Humano (Permisos, Memorandos y Multi-Área)</option>
                <option value="admin">Admin General (Gerencia: Consulta Global y Métricas)</option>
                <option value="superadmin">Superadministrador (Control Maestro)</option>
              </select>
            </div>
          </div>
          <div class="grid-3">
            <div class="form-group">
              <label class="form-label">Área Ligada (Obligatoria p/ Supervisor)</label>
              <select id="usr-area" class="form-control">
                <option value="">-- Global / Todas las Áreas --</option>
                ${STATE.areas.map((a) => `<option value="${a.id}">${a.nombre}</option>`).join("")}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Nombre Completo</label>
              <input type="text" id="usr-nombre" class="form-control" placeholder="Nombre y Apellido" required />
            </div>
            <div class="form-group">
              <label class="form-label">Contraseña</label>
              <input type="password" id="usr-password" class="form-control" placeholder="Contraseña" required />
            </div>
          </div>
          <div style="display:flex; gap:10px;">
            <button type="submit" class="btn btn-primary" style="flex:1;">${icon("save", 16)} Guardar Usuario</button>
            <button type="button" id="btn-limpiar-usr" class="btn btn-outline">Limpiar</button>
          </div>
        </form>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">${icon("users", 18)} <span>Directorio de Usuarios del Sistema (${usuariosFiltrados.length} / ${STATE.usuarios.length})</span></div>
        <div class="search-input-wrap">
          <input type="text" id="search-usuarios-table" class="form-control" placeholder="Buscar por usuario, nombre, rol o área..." value="${STATE.searchUsuarios || ""}" />
        </div>
      </div>
      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              <th>Usuario</th>
              <th>Nombre</th>
              <th>Rol Asignado</th>
              <th>Área Ligada</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${usuariosFiltrados
              .map((u) => {
                const roleBadges = {
                  superadmin: `<span class="badge badge-danger">${icon("shield-check", 13)} Superadmin</span>`,
                  admin: `<span class="badge badge-info">${icon("layout-dashboard", 13)} Admin General</span>`,
                  supervisor: `<span class="badge badge-ok">${icon("user-check", 13)} Supervisor</span>`,
                  auditor: `<span class="badge badge-warn">${icon("file-check-2", 13)} Auditor Horas Extras</span>`,
                  talento_humano: `<span class="badge badge-info">${icon("users", 13)} Talento Humano</span>`
                };
                return `
                  <tr>
                    <td><strong>${u.username}</strong></td>
                    <td>${u.nombre}</td>
                    <td>${roleBadges[u.rol] || u.rol}</td>
                    <td><strong>${u.nombre_area || "Global / Todas las Áreas"}</strong></td>
                    <td>
                      <button type="button" class="btn btn-outline btn-sm btn-edit-usr" data-user="${u.username}">${icon("pencil", 14)} Editar</button>
                      <button type="button" class="btn btn-danger btn-sm btn-del-usr" data-user="${u.username}">${icon("trash-2", 14)} Eliminar</button>
                    </td>
                  </tr>
                `;
              })
              .join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ============================================================================
// 2. VISTA ADMIN GENERAL: SUPERVISORES, ÁREAS Y EMPLEADOS (SOLO CONSULTA)
// ============================================================================

function renderAdminGeneralEstructura() {
  const supervisores = STATE.usuarios.filter((u) => u.rol === "supervisor");
  return `
    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <div class="card-title">👷 Supervisores por Área (${supervisores.length})</div>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Supervisor</th>
                <th>Usuario</th>
                <th>Área Asignada</th>
              </tr>
            </thead>
            <tbody>
              ${
                supervisores.length === 0
                  ? `<tr><td colspan="3" style="text-align:center; padding:18px;">No hay supervisores registrados aún.</td></tr>`
                  : supervisores
                      .map(
                        (s) => `
                  <tr>
                    <td><strong>${s.nombre}</strong></td>
                    <td><code>${s.username}</code></td>
                    <td><span class="badge badge-ok">${s.nombre_area}</span></td>
                  </tr>
                `
                      )
                      .join("")
              }
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">🏛️ Resumen por Áreas (${STATE.areas.length})</div>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Área</th>
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
                  <td>${a.total_supervisores}</td>
                  <td><strong>${a.total_empleados}</strong></td>
                </tr>
              `
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">👥 Plantilla Global de Empleados (${STATE.empleados.length})</div>
      </div>
      <div class="table-responsive" style="max-height:460px;">
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
            ${STATE.empleados
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
  `;
}

// ============================================================================
// 3. VISTA TALENTO HUMANO: MEMORANDOS/CAPACITACIONES + PERMISOS + REPORTE EXCEL
// ============================================================================

function renderTalentoHumanoCentro() {
  return `
    <div class="grid-2">
      <!-- Envío de Memorandos, Capacitaciones y Comunicados con Notificación en Tiempo Real -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">📢 Enviar Memorando, Citación a Capacitación o Comunicado</div>
        </div>
        <form id="form-comunicado">
          <div class="grid-2">
            <div class="form-group">
              <label class="form-label">Tipo de Comunicado</label>
              <select id="com-tipo" class="form-control">
                <option value="CAPACITACIÓN">🎓 Citación a Capacitación</option>
                <option value="MEMORANDO">📋 Memorando Oficial</option>
                <option value="COMUNICADO RRHH">📢 Comunicado General RRHH</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Fecha/Hora del Evento (Opcional)</label>
              <input type="text" id="com-fecha" class="form-control" placeholder="Ej: Viernes 27 Nov - 2:00 PM" />
            </div>
          </div>

          <div class="grid-2">
            <div class="form-group">
              <label class="form-label">Dirigido a</label>
              <select id="com-destino-tipo" class="form-control">
                <option value="TODOS">🏢 Toda la Empresa</option>
                <option value="AREA">🏛️ Un Área Específica</option>
                <option value="EMPLEADO">👤 Un Empleado Específico</option>
              </select>
            </div>
            <div class="form-group" id="com-destino-valor-wrap">
              <label class="form-label">Seleccionar Área o Empleado</label>
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
          </div>

          <div class="form-group">
            <label class="form-label">Título / Asunto</label>
            <input type="text" id="com-titulo" class="form-control" placeholder="Ej: Capacitación obligatoria en Seguridad y Salud en el Trabajo" required />
          </div>
          <div class="form-group">
            <label class="form-label">Mensaje Detallado</label>
            <textarea id="com-mensaje" class="form-control" rows="3" placeholder="Escribe los detalles del memorando o capacitación..." required></textarea>
          </div>
          <button type="submit" class="btn btn-action btn-block">
            🔔 Enviar y Notificar en Tiempo Real a los Celulares
          </button>
        </form>
      </div>

      <!-- Historial de Memorandos y Confirmaciones de Lectura -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">📬 Memorandos y Capacitaciones Enviadas (${STATE.comunicados.length})</div>
        </div>
        <div class="table-responsive" style="max-height:380px;">
          <table>
            <thead>
              <tr>
                <th>Tipo / Fecha</th>
                <th>Asunto y Mensaje</th>
                <th>Destinatario</th>
                <th>Confirmados</th>
              </tr>
            </thead>
            <tbody>
              ${
                STATE.comunicados.length === 0
                  ? `<tr><td colspan="4" style="text-align:center; padding:22px;">Aún no se han enviado memorandos ni capacitaciones.</td></tr>`
                  : STATE.comunicados
                      .map(
                        (c) => `
                  <tr>
                    <td>
                      <span class="badge badge-info">${c.tipo}</span><br/>
                      <small>${c.creado_en}</small>
                    </td>
                    <td>
                      <strong>${c.titulo}</strong>
                      ${c.fecha_evento ? `<br/><small style="color:var(--naranja); font-weight:700;">📅 ${c.fecha_evento}</small>` : ""}
                      <br/><small style="color:var(--texto-sec);">${c.mensaje}</small>
                    </td>
                    <td><span class="badge badge-ok">${c.destino_etiqueta}</span></td>
                    <td><strong>${c.total_lecturas} leído(s)</strong></td>
                  </tr>
                `
                      )
                      .join("")
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Gestión Final de Permisos (Avalados por Supervisor) y Exportación Excel -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">📝 Gestión de Permisos y Solicitudes de Empleados (${STATE.solicitudes.length})</div>
        <button type="button" id="btn-exportar-permisos" class="btn btn-primary btn-sm">
          📥 Exportar Reporte Excel de Permisos y Ausentismo
        </button>
      </div>
      <p style="font-size:0.86rem; color:var(--texto-sec); margin-bottom:12px;">
        Flujo: El empleado solicita → Su Supervisor de Área la avala (<code>AVALADO_SUPERVISOR</code>) → Talento Humano da la aprobación final (<code>APROBADA</code>).
      </p>
      <div class="table-responsive" style="max-height:420px;">
        <table>
          <thead>
            <tr>
              <th>Empleado / Área</th>
              <th>Tipo / Fechas</th>
              <th>Motivo</th>
              <th>Aval Supervisor</th>
              <th>Estado Actual</th>
              <th>Decisión Final RRHH</th>
            </tr>
          </thead>
          <tbody>
            ${
              STATE.solicitudes.length === 0
                ? `<tr><td colspan="6" style="text-align:center; padding:22px;">No hay solicitudes de permisos registradas.</td></tr>`
                : STATE.solicitudes
                    .map((s) => {
                      let badge = "badge-warn";
                      if (s.estado === "APROBADA") badge = "badge-ok";
                      else if (s.estado.includes("RECHAZADA")) badge = "badge-danger";
                      else if (s.estado === "AVALADO_SUPERVISOR") badge = "badge-info";
                      return `
                  <tr>
                    <td>
                      <strong>${s.nombre_empleado}</strong> (ID: ${s.id_empleado})<br/>
                      <span class="badge badge-info">${s.nombre_area || "Sin Área"}</span>
                    </td>
                    <td><strong>${s.tipo}</strong><br/><small>${s.fecha_inicio} a ${s.fecha_fin}</small></td>
                    <td>${s.motivo}</td>
                    <td><small>${s.supervisor_usuario ? `✔ ${s.supervisor_usuario}` : "Pendiente Supervisor"}</small></td>
                    <td><span class="badge ${badge}">${s.estado}</span></td>
                    <td>
                      ${
                        s.estado !== "APROBADA" && !s.estado.includes("RECHAZADA")
                          ? `
                        <button type="button" class="btn btn-primary btn-sm btn-resp-sol" data-id="${s.id}" data-estado="APROBADA">✔ Aprobar RRHH</button>
                        <button type="button" class="btn btn-danger btn-sm btn-resp-sol" data-id="${s.id}" data-estado="RECHAZADA">✖ Rechazar</button>
                      `
                          : `<small>${s.rrhh_usuario || s.respuesta_admin || "Cerrada"}</small>`
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

// --- VISTA 1: CATÁLOGO DE TURNOS (POR ÁREA O GLOBAL) ---
function renderAdminTurnos() {
  const isSup = STATE.user.role === "supervisor";
  return `
    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <div class="card-title" id="turno-form-title">
            ${isSup ? `Crear / Editar Turno para ${STATE.user.nombre_area}` : "Crear / Editar Plantilla de Turno"}
          </div>
        </div>
        <form id="form-turno">
          <input type="hidden" id="turno-id" value="" />
          <div class="grid-2">
            <div class="form-group">
              <label class="form-label">Nombre del Turno</label>
              <input type="text" id="turno-nombre" class="form-control" placeholder="Ej: Turno Mañana 06 a 14" required />
            </div>
            <div class="form-group">
              <label class="form-label">Área del Turno</label>
              ${
                isSup
                  ? `<input type="text" class="form-control" value="${STATE.user.nombre_area}" disabled />
                     <input type="hidden" id="turno-area" value="${STATE.user.id_area || ""}" />`
                  : `<select id="turno-area" class="form-control">
                      <option value="">-- Global (Todas las Áreas) --</option>
                      ${STATE.areas.map((a) => `<option value="${a.id}">${a.nombre}</option>`).join("")}
                    </select>`
              }
            </div>
          </div>
          <div class="grid-2">
            <div class="form-group">
              <label class="form-label">Hora Entrada (24h HH:MM)</label>
              <input type="time" id="turno-entrada" class="form-control" value="06:00" required />
            </div>
            <div class="form-group">
              <label class="form-label">Hora Salida (24h HH:MM)</label>
              <input type="time" id="turno-salida" class="form-control" value="14:00" required />
            </div>
          </div>
          <div class="grid-2">
            <div class="form-group">
              <label class="form-label">Tolerancia llegada tarde (min)</label>
              <input type="number" id="turno-tolerancia" class="form-control" value="10" min="0" />
            </div>
            <div class="form-group">
              <label class="form-label">Descanso intermedio (min)</label>
              <input type="number" id="turno-descanso" class="form-control" value="0" min="0" />
            </div>
          </div>
          <div style="display:flex; gap:10px; margin-top:8px;">
            <button type="submit" class="btn btn-primary" style="flex:1;">💾 Guardar Turno</button>
            <button type="button" id="btn-limpiar-turno" class="btn btn-outline">Limpiar</button>
          </div>
        </form>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">Turnos Disponibles (${STATE.turnos.length})</div>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Turno</th>
                <th>Área</th>
                <th>Horario</th>
                <th>Tipo</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${
                STATE.turnos.length === 0
                  ? `<tr><td colspan="5" style="text-align:center; padding:22px;">No hay turnos creados aún.</td></tr>`
                  : STATE.turnos
                      .map((t) => {
                        const color = getShiftColor(t.id);
                        return `
                <tr>
                  <td>
                    <span style="display:inline-block; width:12px; height:12px; border-radius:4px; background:${color}; margin-right:8px;"></span>
                    <strong>${t.nombre}</strong>
                  </td>
                  <td><span class="badge badge-info">${t.nombre_area || "Global"}</span></td>
                  <td>${t.hora_entrada} - ${t.hora_salida}</td>
                  <td>${
                    t.cruza_medianoche
                      ? '<span class="badge badge-warn">🌙 Nocturno</span>'
                      : '<span class="badge badge-ok">☀️ Diurno</span>'
                  }</td>
                  <td>
                    <button type="button" class="btn btn-outline btn-sm btn-edit-turno" data-id="${t.id}">Editar</button>
                    <button type="button" class="btn btn-danger btn-sm btn-del-turno" data-id="${t.id}">Eliminar</button>
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
    </div>
  `;
}

// --- VISTA 2: DÍAS FESTIVOS ---
function renderAdminFestivos() {
  const currentYear = new Date().getFullYear();
  return `
    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <div class="card-title">Registrar Día Festivo</div>
        </div>
        <form id="form-festivo">
          <div class="form-group">
            <label class="form-label">Fecha Festiva</label>
            <input type="date" id="festivo-fecha" class="form-control" required />
          </div>
          <div class="form-group">
            <label class="form-label">Descripción / Celebración</label>
            <input type="text" id="festivo-desc" class="form-control" placeholder="Ej: Día del Trabajo" required />
          </div>
          <button type="submit" class="btn btn-primary btn-block">➕ Guardar Día Festivo</button>
        </form>

        <hr style="margin:22px 0; border:none; border-top:1px solid var(--borde);" />

        <div class="card-title" style="margin-bottom:10px;">Carga Automática Festivos de Colombia</div>
        <div style="display:flex; gap:10px;">
          <input type="number" id="festivo-anio-col" class="form-control" value="${currentYear}" min="2020" max="2035" />
          <button type="button" id="btn-cargar-colombia" class="btn btn-action" style="white-space:nowrap;">
            🇨🇴 Cargar Festivos Colombia
          </button>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">Calendario de Festivos (${STATE.festivos.length})</div>
        </div>
        <div class="table-responsive" style="max-height:480px;">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Descripción</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody>
              ${
                STATE.festivos.length === 0
                  ? `<tr><td colspan="3" style="text-align:center; padding:22px;">No hay festivos cargados. Pulsa "Cargar Festivos Colombia".</td></tr>`
                  : STATE.festivos
                      .map(
                        (f) => `
                <tr>
                  <td><strong>${f.fecha}</strong></td>
                  <td>${f.descripcion}</td>
                  <td>
                    <button type="button" class="btn btn-danger btn-sm btn-del-festivo" data-fecha="${f.fecha}">
                      Eliminar
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
// 4. PROCESAR HUELLERO Y GENERAR REPORTES (INDIVIDUALES O AGRUPADOS POR ÁREA)
// Disponible para: Supervisor (su Área), Auditor de Horas Extras (Todas) y Talento Humano (Administrativos o Todas)
// ============================================================================

function renderAdminProcesar() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();
  const prev = STATE.huelleroPreview;
  const isSup = STATE.user.role === "supervisor";

  const selectedArea = isSup ? String(STATE.user.id_area || "") : STATE.huelleroFiltroArea;
  const empleadosDelArea = STATE.empleados.filter(
    (e) => !selectedArea || String(e.id_area || "") === String(selectedArea)
  );

  return `
    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <div class="card-title">
            ⚙️ Validar Horas Extras con Huellero y Generar Reportes (Individual o Agrupado)
          </div>
        </div>
        <form id="form-procesar-huellero">
          <div id="huellero-dropzone" class="dropzone-box">
            <div style="font-size:2.2rem; margin-bottom:6px;">📂</div>
            <div style="font-weight:800; font-size:1rem; color:var(--petroleo);">
              Arrastra y suelta aquí el Excel del Huellero (.xlsx / .xls)
            </div>
            <div style="font-size:0.83rem; color:var(--texto-sec); margin-top:4px;">
              El huellero solo se usa para cruzar marcaciones contra los turnos programados
            </div>
            <input type="file" id="proc-files" accept=".xlsx,.xls" multiple style="display:none;" />
          </div>

          ${
            prev
              ? `
            <div class="alert-banner alert-ok" style="flex-direction:column; align-items:flex-start;">
              <div>
                <strong>✅ Vista Previa del Huellero:</strong> ${prev.total_marcaciones} marcaciones detectadas (${prev.fecha_min || "—"} al ${prev.fecha_max || "—"}).
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
                      <option value="">🏢 Todas las Áreas (Consolidado)</option>
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
                <option value="TODOS">👥 Agrupado (Todos los empleados del área)</option>
                ${empleadosDelArea
                  .map(
                    (e) =>
                      `<option value="${e.id_empleado}" ${STATE.huelleroFiltroEmpleado === e.id_empleado ? "selected" : ""}>👤 Individual: ${e.id_empleado} - ${e.nombre}</option>`
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

          <div class="grid-3">
            <div class="form-group">
              <label class="form-label">Columna ID (Resp: A)</label>
              <input type="text" id="proc-col-id" class="form-control" value="ID_Empleado" />
            </div>
            <div class="form-group">
              <label class="form-label">Columna Fecha (Resp: C)</label>
              <input type="text" id="proc-col-fecha" class="form-control" value="Fecha" />
            </div>
            <div class="form-group">
              <label class="form-label">Columna Hora (Resp: D)</label>
              <input type="text" id="proc-col-hora" class="form-control" value="Hora" />
            </div>
          </div>

          <div class="form-group">
            <label style="display:flex; align-items:center; gap:8px; font-weight:600; cursor:pointer; margin-bottom:6px;">
              <input type="checkbox" id="proc-incluir-app" checked />
              Integrar marcaciones realizadas desde la App de Celular (Reloj GPS)
            </label>
            <label style="display:flex; align-items:center; gap:8px; font-weight:600; cursor:pointer;">
              <input type="checkbox" id="proc-no-programados" checked />
              Incluir auditoría de horas no programadas
            </label>
          </div>

          <button type="submit" id="btn-submit-procesar" class="btn btn-action btn-block" style="padding:14px; font-size:1rem;">
            ⚙️ Validar Horas Extras y Generar Reporte Excel
          </button>
        </form>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">📥 Reportes Excel Generados (${STATE.reportes.length})</div>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Archivo Excel</th>
                <th>Fecha</th>
                <th>Tamaño</th>
                <th>Descargar</th>
              </tr>
            </thead>
            <tbody>
              ${
                STATE.reportes.length === 0
                  ? `<tr><td colspan="4" style="text-align:center; padding:24px;">Aún no hay reportes generados. Puedes generarlos desde el panel izquierdo ahora mismo.</td></tr>`
                  : STATE.reportes
                      .map(
                        (r) => `
                  <tr>
                    <td><strong>${r.nombre}</strong></td>
                    <td>${r.fecha}</td>
                    <td>${r.tamano_kb} KB</td>
                    <td>
                      <a href="${r.url}" download class="btn btn-primary btn-sm">⬇️ Descargar</a>
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
    </div>
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
// 6. BASE DE DATOS DE EMPLEADOS LIGADOS A SU ÁREA (SEPARADA DEL HUELLERO)
// ============================================================================

function renderAdminEmpleados() {
  const qEmp = (STATE.searchEmpleados || "").toLowerCase();
  const empleadosFiltrados = STATE.empleados.filter(
    (e) =>
      e.id_empleado.toLowerCase().includes(qEmp) ||
      e.nombre.toLowerCase().includes(qEmp) ||
      (e.nombre_area || "").toLowerCase().includes(qEmp) ||
      (e.cargo || "").toLowerCase().includes(qEmp)
  );

  return `
    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <div class="card-title">${icon("file-spreadsheet", 18)} <span>Importar Base de Datos de Empleados por Área (Excel)</span></div>
        </div>
        <p style="font-size:0.86rem; color:var(--texto-sec); margin-bottom:10px;">
          Esta base de empleados es independiente del huellero. Puedes subir un Excel con columnas: <code>ID | Nombre | Área | Cargo | PIN</code> o seleccionar un Área por defecto abajo.
        </p>
        <div class="form-group">
          <label class="form-label">Área por defecto para los empleados del archivo (si el Excel no trae columna Área)</label>
          <select id="import-emp-area-default" class="form-control">
            <option value="">-- Detectar columna Área del Excel --</option>
            ${STATE.areas.map((a) => `<option value="${a.id}">${a.nombre}</option>`).join("")}
          </select>
        </div>
        <div id="emp-dropzone" class="dropzone-box" style="padding:18px;">
          <div style="margin-bottom:6px; color:var(--petroleo);">${icon("upload-cloud", 32)}</div>
          <div style="font-weight:800; color:var(--petroleo);">
            Arrastra aquí el Excel de Empleados (.xlsx / .xls) o haz clic para subir
          </div>
          <input type="file" id="import-emp-excel" accept=".xlsx,.xls" style="display:none;" />
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">${icon("user-plus", 18)} <span>Registrar / Actualizar Empleado y su Área</span></div>
        </div>
        <form id="form-empleado">
          <div class="grid-3">
            <div class="form-group">
              <label class="form-label">ID / Código Biométrico</label>
              <input type="text" id="emp-id" class="form-control" placeholder="Ej: 141 o 00000002" required />
            </div>
            <div class="form-group">
              <label class="form-label">Área Asignada</label>
              <select id="emp-area" class="form-control" required>
                <option value="">-- Seleccione Área --</option>
                ${STATE.areas.map((a) => `<option value="${a.id}">${a.nombre}</option>`).join("")}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">PIN App Móvil</label>
              <input type="text" id="emp-pin" class="form-control" value="1234" required />
            </div>
          </div>
          <div class="grid-2">
            <div class="form-group">
              <label class="form-label">Nombre Completo</label>
              <input type="text" id="emp-nombre" class="form-control" placeholder="Apellidos y Nombres" required />
            </div>
            <div class="form-group">
              <label class="form-label">Cargo / Puesto</label>
              <input type="text" id="emp-cargo" class="form-control" value="Operario" />
            </div>
          </div>
          <button type="submit" class="btn btn-primary btn-block">${icon("save", 16)} Guardar Empleado en Base de Datos</button>
        </form>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">${icon("users", 18)} <span>Directorio Maestro de Empleados (${empleadosFiltrados.length} / ${STATE.empleados.length})</span></div>
        <div class="search-input-wrap">
          <input type="text" id="search-empleados-table" class="form-control" placeholder="Buscar por ID, nombre, área o cargo..." value="${STATE.searchEmpleados || ""}" />
        </div>
      </div>
      <div class="table-responsive" style="max-height:460px;">
        <table>
          <thead>
            <tr>
              <th>ID Biométrico</th>
              <th>Nombre Completo</th>
              <th>Área Asignada</th>
              <th>Cargo</th>
              <th>PIN App</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${
              empleadosFiltrados.length === 0
                ? `<tr><td colspan="6" style="text-align:center; padding:22px;">No hay empleados que coincidan con la búsqueda.</td></tr>`
                : empleadosFiltrados
                    .map(
                      (e) => `
              <tr>
                <td><strong>${e.id_empleado}</strong></td>
                <td>${e.nombre}</td>
                <td><span class="badge badge-info">${e.nombre_area || "Sin Área"}</span></td>
                <td>${e.cargo || "Operario"}</td>
                <td><code>${e.pin || "1234"}</code></td>
                <td>
                  <button type="button" class="btn btn-outline btn-sm btn-edit-emp" data-id="${e.id_empleado}" data-nombre="${e.nombre}" data-cargo="${e.cargo || "Operario"}" data-pin="${e.pin || "1234"}" data-area="${e.id_area || ""}">${icon("pencil", 14)} Editar</button>
                  <button type="button" class="btn btn-danger btn-sm btn-del-emp" data-id="${e.id_empleado}">${icon("trash-2", 14)} Eliminar</button>
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
// 7. MAPA GPS Y PERMISOS (CON AVAL DE SUPERVISOR -> TALENTO HUMANO)
// ============================================================================

function renderGpsYSolicitudes() {
  const role = STATE.user.role;
  const isSup = role === "supervisor";
  const isRRHH = role === "talento_humano" || role === "superadmin";

  return `
    <div class="card">
      <div class="card-header">
        <div class="card-title">
          📝 Solicitudes de Permisos (${isSup ? `Mi Área: ${STATE.user.nombre_area}` : "Todas las Áreas"}) (${STATE.solicitudes.length})
        </div>
      </div>
      <div class="table-responsive" style="max-height:380px;">
        <table>
          <thead>
            <tr>
              <th>Empleado / Área</th>
              <th>Tipo / Fechas</th>
              <th>Motivo</th>
              <th>Estado del Flujo</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            ${
              STATE.solicitudes.length === 0
                ? `<tr><td colspan="5" style="text-align:center; padding:22px;">No hay solicitudes de permisos registradas.</td></tr>`
                : STATE.solicitudes
                    .map((s) => {
                      let badge = "badge-warn";
                      if (s.estado === "APROBADA") badge = "badge-ok";
                      else if (s.estado.includes("RECHAZADA")) badge = "badge-danger";
                      else if (s.estado === "AVALADO_SUPERVISOR") badge = "badge-info";

                      let accionesHtml = `<small>${s.respuesta_admin || s.respuesta_supervisor || "En trámite"}</small>`;
                      if (isSup && s.estado === "PENDIENTE_SUPERVISOR") {
                        accionesHtml = `
                          <button type="button" class="btn btn-primary btn-sm btn-resp-sol" data-id="${s.id}" data-estado="AVALADO_SUPERVISOR">
                            ✔ Avalar y Pasar a Talento Humano
                          </button>
                          <button type="button" class="btn btn-danger btn-sm btn-resp-sol" data-id="${s.id}" data-estado="RECHAZADA_SUPERVISOR">
                            ✖ Rechazar
                          </button>
                        `;
                      } else if (isRRHH && s.estado !== "APROBADA" && !s.estado.includes("RECHAZADA")) {
                        accionesHtml = `
                          <button type="button" class="btn btn-primary btn-sm btn-resp-sol" data-id="${s.id}" data-estado="APROBADA">
                            ✔ Aprobación Final RRHH
                          </button>
                          <button type="button" class="btn btn-danger btn-sm btn-resp-sol" data-id="${s.id}" data-estado="RECHAZADA">
                            ✖ Rechazar
                          </button>
                        `;
                      }

                      return `
                  <tr>
                    <td>
                      <strong>${s.nombre_empleado}</strong> (ID: ${s.id_empleado})<br/>
                      <span class="badge badge-info">${s.nombre_area || "Sin Área"}</span>
                    </td>
                    <td><strong>${s.tipo}</strong><br/><small>${s.fecha_inicio} a ${s.fecha_fin}</small></td>
                    <td>${s.motivo}</td>
                    <td><span class="badge ${badge}">${s.estado}</span></td>
                    <td>${accionesHtml}</td>
                  </tr>
                `;
                    })
                    .join("")
            }
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">🗺️ Mapa Interactivo en Vivo de Marcaciones GPS (${STATE.marcacionesMoviles.length})</div>
      </div>
      <div id="gps-leaflet-map" class="gps-map-container"></div>

      <div class="table-responsive" style="max-height:380px;">
        <table>
          <thead>
            <tr>
              <th>Fecha y Hora</th>
              <th>Empleado / Área</th>
              <th>Tipo</th>
              <th>Evidencia / Nota</th>
              <th>Dirección Física Detectada</th>
              <th>Coordenadas GPS</th>
              <th>Mapa</th>
            </tr>
          </thead>
          <tbody>
            ${
              STATE.marcacionesMoviles.length === 0
                ? `<tr><td colspan="7" style="text-align:center; padding:22px;">Aún no hay marcaciones registradas desde celulares.</td></tr>`
                : STATE.marcacionesMoviles
                    .map(
                      (m) => `
                <tr>
                  <td><strong>${m.fecha_hora}</strong></td>
                  <td>
                    <strong>${m.nombre_empleado}</strong> (ID: ${m.id_empleado})<br/>
                    <span class="badge badge-info">${m.nombre_area || "Sin Área"}</span>
                  </td>
                  <td><span class="badge ${m.tipo === "ENTRADA" ? "badge-ok" : "badge-warn"}">${m.tipo}</span></td>
                  <td>
                    ${
                      m.foto_base64
                        ? `<img src="${m.foto_base64}" alt="Selfie" style="width:44px; height:44px; object-fit:cover; border-radius:8px; border:1px solid var(--borde); display:block; margin-bottom:4px;" />`
                        : ""
                    }
                    <small>${m.observaciones || "—"}</small>
                  </td>
                  <td><strong>${m.direccion || "Sin dirección registrada"}</strong></td>
                  <td>${
                    m.latitud != null && m.longitud != null
                      ? `<code>${m.latitud}, ${m.longitud}</code> (±${m.precision_m || 0}m)`
                      : "Sin coordenadas"
                  }</td>
                  <td>
                    ${
                      m.latitud != null && m.longitud != null
                        ? `<a href="https://www.google.com/maps?q=${m.latitud},${m.longitud}" target="_blank" class="btn btn-outline btn-sm">🗺️ Google Maps</a>`
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

  // --- Eventos Gestión de Áreas (Superadmin) ---
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
        await Promise.all([loadAreas(), loadUsuarios(), loadEmpleados()]);
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    document.getElementById("btn-limpiar-area")?.addEventListener("click", () => {
      document.getElementById("area-id").value = "";
      document.getElementById("area-nombre").value = "";
      document.getElementById("area-desc").value = "";
    });

    document.querySelectorAll(".btn-edit-area").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.getElementById("area-id").value = btn.dataset.id;
        document.getElementById("area-nombre").value = btn.dataset.nombre;
        document.getElementById("area-desc").value = btn.dataset.desc;
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
  }

  // --- Eventos Usuarios del Sistema (Superadmin) ---
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
        await Promise.all([loadUsuarios(), loadAreas()]);
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    document.getElementById("btn-limpiar-usr")?.addEventListener("click", () => {
      document.getElementById("usr-username").value = "";
      document.getElementById("usr-nombre").value = "";
      document.getElementById("usr-password").value = "";
      document.getElementById("usr-rol").value = "supervisor";
      document.getElementById("usr-area").value = "";
    });

    document.querySelectorAll(".btn-edit-usr").forEach((btn) => {
      btn.addEventListener("click", () => {
        const u = STATE.usuarios.find((x) => x.username === btn.dataset.user);
        if (!u) return;
        document.getElementById("usr-username").value = u.username;
        document.getElementById("usr-nombre").value = u.nombre;
        document.getElementById("usr-rol").value = u.rol;
        document.getElementById("usr-area").value = u.id_area || "";
        document.getElementById("usr-password").placeholder = "Nueva contraseña";
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
  }

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
        showToast("🔔 Memorando enviado y notificado en tiempo real", "success");
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

  // --- Eventos Catálogo Turnos ---
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
        await Promise.all([loadTurnos(), loadDashboard()]);
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    document.getElementById("btn-limpiar-turno")?.addEventListener("click", () => {
      document.getElementById("turno-id").value = "";
      document.getElementById("turno-nombre").value = "";
    });

    document.querySelectorAll(".btn-edit-turno").forEach((btn) => {
      btn.addEventListener("click", () => {
        const t = STATE.turnos.find((x) => String(x.id) === String(btn.dataset.id));
        if (!t) return;
        document.getElementById("turno-id").value = t.id;
        document.getElementById("turno-nombre").value = t.nombre;
        document.getElementById("turno-entrada").value = t.hora_entrada;
        document.getElementById("turno-salida").value = t.hora_salida;
        document.getElementById("turno-tolerancia").value = t.tolerancia_min;
        document.getElementById("turno-descanso").value = t.descanso_min;
        const areaEl = document.getElementById("turno-area");
        if (areaEl && areaEl.tagName === "SELECT") areaEl.value = t.id_area || "";
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
  }

  // --- Eventos Festivos ---
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
        await loadFestivos();
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
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

  // --- Eventos Base de Empleados (con Área) ---
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
        await Promise.all([loadEmpleados(), loadAreas(), loadDashboard()]);
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    document.querySelectorAll(".btn-edit-emp").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.getElementById("emp-id").value = btn.dataset.id;
        document.getElementById("emp-nombre").value = btn.dataset.nombre;
        document.getElementById("emp-cargo").value = btn.dataset.cargo;
        document.getElementById("emp-pin").value = btn.dataset.pin;
        document.getElementById("emp-area").value = btn.dataset.area || "";
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

    document.getElementById("search-empleados-table")?.addEventListener("input", (e) => {
      STATE.searchEmpleados = e.target.value;
      renderApp();
      const input = document.getElementById("search-empleados-table");
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
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
          <div>
            <div class="topbar-breadcrumb">PORTAL DEL COLABORADOR / ${STATE.user.nombre_area || "GENERAL"}</div>
            <div class="topbar-title">${icon(currentNav.lucide, 20)} <span>${currentNav.label}</span></div>
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            <button type="button" id="btn-emp-notifs" class="btn btn-outline btn-sm">
              ${icon("bell", 16)} <span id="notif-bell-count" class="badge badge-danger" style="display:${
                STATE.notificacionesNoLeidas > 0 ? "inline-flex" : "none"
              };">${STATE.notificacionesNoLeidas}</span>
            </button>
            <button type="button" id="btn-emp-theme" class="btn btn-outline btn-sm">
              ${STATE.darkMode ? icon("sun", 16) : icon("moon", 16)}
            </button>
            <button type="button" id="btn-emp-top-logout" class="btn btn-danger btn-sm">
              ${icon("log-out", 15)} Salir
            </button>
          </div>
        </header>

        <main class="content-container" style="max-width:880px;">
          ${renderNotificationsBanner()}
          ${renderEmpleadoViewContent()}
        </main>
      </div>

      <nav class="bottom-nav">
        ${EMP_NAV.map(
          (item) => `
          <button type="button" class="bottom-nav-item ${STATE.activeView === item.id ? "active" : ""}" data-view="${item.id}">
            ${icon(item.lucide, 18)}
            <span>${item.short}</span>
          </button>
        `
        ).join("")}
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
    const today = new Date().toISOString().slice(0, 10);
    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title">📝 Solicitar Permiso o Cambio de Turno (Enviado a Supervisor → Talento Humano)</div>
        </div>
        <form id="form-emp-solicitud">
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
            <textarea id="sol-motivo" class="form-control" rows="3" placeholder="Describe tu solicitud (la revisará primero tu Supervisor de Área y luego Talento Humano)..." required></textarea>
          </div>
          <button type="submit" class="btn btn-action btn-block">📨 Enviar Solicitud a Mi Supervisor</button>
        </form>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">Mis Solicitudes Enviadas (${r.solicitudes.length})</div>
        </div>
        <div class="table-responsive">
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
                  ? `<tr><td colspan="4" style="text-align:center; padding:18px;">No has enviado solicitudes todavía.</td></tr>`
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

