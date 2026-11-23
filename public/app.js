/* =========================================================================
   STERINOVA - Sistema Web En Línea & App Móvil de Asistencia y Nómina
   Roles separados con Login Unificado Inteligente:
   1) SUPERADMIN: Crea/administra Administradores, Supervisores, sube Empleados
      y tiene acceso completo a todos los módulos.
   2) ADMINISTRADOR: Catálogo de Turnos, Festivos, Asignación, Procesar Huellero,
      Análisis/Reportes Excel, Empleados, Solicitudes y GPS.
   3) SUPERVISOR: Vista operativa (Asignar Turnos, Monitoreo GPS con Dirección
      y Coordenadas, Solicitudes/Permisos del personal y Novedades).
   4) EMPLEADO: Reloj GPS con Dirección y Coordenadas, Mis Turnos, Mis Horas
      Extras/Recargos y Solicitud de Permisos.
   ========================================================================= */

const STATE = {
  user: JSON.parse(localStorage.getItem("sterinova_user") || "null"),
  activeView: "dashboard",
  deferredInstallPrompt: null,
  // Datos compartidos
  dashboard: null,
  usuarios: [],
  turnos: [],
  festivos: [],
  empleados: [],
  asignaciones: [],
  reportes: [],
  solicitudes: [],
  marcacionesMoviles: [],
  // Estado Asignación de Turnos
  calMonth: new Date().toISOString().slice(0, 7),
  selectedEmployees: new Set(),
  selectedDates: new Set(),
  searchEmpAsignacion: "",
  // Estado Análisis
  analisisData: {
    kpis: { horas_extra: 0, minutos_tardanza: 0, ausencias: 0, llegadas_tempranas: 0 },
    filas: [],
    turnos_disponibles: [],
    rango_fechas: { inicio: "", fin: "" }
  },
  analisisFiltros: {
    id_empleado: "TODOS",
    turno: "TODOS",
    fecha_inicio: "",
    fecha_fin: "",
    kpi: ""
  },
  // Estado Portal Empleado
  empResumen: null,
  gpsActual: null
};

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
  if (type === "error") el.style.borderLeftColor = "#B3261E";
  if (type === "success") el.style.borderLeftColor = "#22C55E";
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3800);
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

function setUser(user) {
  STATE.user = user;
  if (user) {
    localStorage.setItem("sterinova_user", JSON.stringify(user));
    if (user.role === "superadmin") STATE.activeView = "usuarios";
    else if (user.role === "admin") STATE.activeView = "dashboard";
    else if (user.role === "supervisor") STATE.activeView = "asignacion";
    else STATE.activeView = "emp_reloj";
    initRoleData();
  } else {
    localStorage.removeItem("sterinova_user");
    renderApp();
  }
}

async function initRoleData() {
  try {
    if (!STATE.user) {
      renderApp();
      return;
    }
    const role = STATE.user.role;
    if (role === "superadmin" || role === "admin" || role === "supervisor") {
      const promises = [
        loadDashboard(),
        loadTurnos(),
        loadFestivos(),
        loadEmpleados(),
        loadSolicitudes(),
        loadReportes(),
        loadMarcacionesMoviles()
      ];
      if (role === "superadmin") {
        promises.push(loadUsuarios());
      }
      await Promise.all(promises);
      if (STATE.empleados.length > 0 && STATE.selectedEmployees.size === 0) {
        STATE.selectedEmployees.add(STATE.empleados[0].id_empleado);
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

async function loadDashboard() {
  STATE.dashboard = await apiFetch("/api/dashboard");
}
async function loadUsuarios() {
  const r = await apiFetch("/api/usuarios");
  STATE.usuarios = r.usuarios || [];
}
async function loadTurnos() {
  const r = await apiFetch("/api/turnos");
  STATE.turnos = r.turnos || [];
}
async function loadFestivos() {
  const r = await apiFetch("/api/festivos");
  STATE.festivos = r.festivos || [];
}
async function loadEmpleados() {
  const r = await apiFetch("/api/empleados");
  STATE.empleados = r.empleados || [];
}
async function loadAsignaciones() {
  const r = await apiFetch(`/api/asignaciones?mes=${encodeURIComponent(STATE.calMonth)}`);
  STATE.asignaciones = r.asignaciones || [];
}
async function loadReportes() {
  const r = await apiFetch("/api/reportes");
  STATE.reportes = r.reportes || [];
}
async function loadSolicitudes() {
  const r = await apiFetch("/api/solicitudes");
  STATE.solicitudes = r.solicitudes || [];
}
async function loadMarcacionesMoviles() {
  const r = await apiFetch("/api/marcaciones-moviles");
  STATE.marcacionesMoviles = r.marcaciones || [];
}
async function loadAnalisis() {
  const f = STATE.analisisFiltros;
  const params = new URLSearchParams();
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
// RENDERIZADO PRINCIPAL SEGÚN ROL
// ============================================================================

function renderApp() {
  const root = document.getElementById("app");
  if (!root) return;

  if (!STATE.user) {
    root.innerHTML = renderLoginScreen();
    bindLoginEvents();
    return;
  }

  if (STATE.user.role === "empleado") {
    root.innerHTML = renderEmpleadoLayout();
    bindEmpleadoEvents();
  } else {
    root.innerHTML = renderManagementLayout();
    bindManagementEvents();
  }
}

// ============================================================================
// LOGIN UNIFICADO INTELIGENTE (SIN PESTAÑAS, DETECTA EL ROL AUTOMÁTICAMENTE)
// ============================================================================

function renderLoginScreen() {
  return `
    <div class="login-wrapper">
      <div class="login-card">
        <img src="/api/branding/logo" alt="Sterinova" class="login-logo" onerror="this.style.display='none'" />
        <div class="login-title">Sistema de Control de Asistencia</div>
        <div class="login-subtitle">Ingreso Unificado En Línea y App Móvil</div>

        <form id="form-login-unificado">
          <div class="form-group">
            <label class="form-label">Usuario o ID de Empleado / Cédula</label>
            <input
              type="text"
              id="login-identificador"
              class="form-control"
              placeholder="Ingrese su usuario o código de empleado"
              autocomplete="username"
              required
            />
          </div>
          <div class="form-group">
            <label class="form-label">Contraseña o PIN</label>
            <input
              type="password"
              id="login-clave"
              class="form-control"
              placeholder="Ingrese su contraseña o PIN"
              autocomplete="current-password"
              required
            />
          </div>
          <button type="submit" class="btn btn-primary btn-block" style="margin-top:12px; padding:14px; font-size:1rem;">
            Iniciar Sesión
          </button>
        </form>

        ${
          STATE.deferredInstallPrompt
            ? `
          <button type="button" id="btn-install-pwa-login" class="btn btn-outline btn-block" style="margin-top:16px;">
            📲 Instalar como App en este Celular / PC
          </button>
        `
            : ""
        }
      </div>
    </div>
  `;
}

function bindLoginEvents() {
  const form = document.getElementById("form-login-unificado");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const identificador = document.getElementById("login-identificador").value;
        const clave = document.getElementById("login-clave").value;
        const res = await apiFetch("/api/login", {
          method: "POST",
          body: JSON.stringify({ identificador, clave })
        });
        const rolEtiqueta = {
          superadmin: "Superadministrador",
          admin: "Administrador",
          supervisor: "Supervisor",
          empleado: "Empleado"
        }[res.user.role] || res.user.role;
        showToast(`Bienvenido (${rolEtiqueta}): ${res.user.nombre}`, "success");
        setUser(res.user);
      } catch (err) {
        showToast(err.message, "error");
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
// NAVEGACIÓN SEPARADA POR ROL (SUPERADMIN, ADMIN, SUPERVISOR)
// ============================================================================

function getMenuForRole(role) {
  if (role === "superadmin") {
    return [
      { id: "usuarios", icon: "👑", label: "Usuarios y Roles", step: "SUPERADMIN", short: "Usuarios" },
      { id: "empleados", icon: "👥", label: "Empleados y Excel", step: "PERSONAL", short: "Empleados" },
      { id: "dashboard", icon: "📊", label: "Inicio y Resumen", step: "MENÚ", short: "Inicio" },
      { id: "turnos", icon: "🕒", label: "Catálogo de Turnos", step: "PASO 1", short: "Turnos" },
      { id: "festivos", icon: "📅", label: "Días Festivos", step: "PASO 2", short: "Festivos" },
      { id: "asignacion", icon: "🗓️", label: "Asignación de Turnos", step: "PASO 3", short: "Asignar" },
      { id: "procesar", icon: "⚙️", label: "Procesar Huellero", step: "PASO 4", short: "Huellero" },
      { id: "analisis", icon: "📈", label: "Análisis y Métricas", step: "PASO 5", short: "Métricas" },
      { id: "gps_solicitudes", icon: "📍", label: "GPS y Solicitudes", step: "MÓVIL", short: "GPS" }
    ];
  }

  if (role === "admin") {
    return [
      { id: "dashboard", icon: "📊", label: "Inicio y Resumen", step: "MENÚ", short: "Inicio" },
      { id: "turnos", icon: "🕒", label: "Catálogo de Turnos", step: "PASO 1", short: "Turnos" },
      { id: "festivos", icon: "📅", label: "Días Festivos", step: "PASO 2", short: "Festivos" },
      { id: "asignacion", icon: "🗓️", label: "Asignación de Turnos", step: "PASO 3", short: "Asignar" },
      { id: "procesar", icon: "⚙️", label: "Procesar Huellero", step: "PASO 4", short: "Huellero" },
      { id: "analisis", icon: "📈", label: "Análisis y Métricas", step: "PASO 5", short: "Métricas" },
      { id: "empleados", icon: "👥", label: "Empleados y Excel", step: "PERSONAL", short: "Empleados" },
      { id: "gps_solicitudes", icon: "📍", label: "GPS y Solicitudes", step: "MÓVIL", short: "GPS" }
    ];
  }

  // Rol: SUPERVISOR (Enfocado en operación de planta, programación de turnos, asistencia GPS y permisos)
  return [
    { id: "asignacion", icon: "🗓️", label: "Asignación de Turnos", step: "TURNOS", short: "Asignar" },
    { id: "gps_solicitudes", icon: "📍", label: "Monitoreo GPS y Permisos", step: "CAMPO", short: "GPS/Permisos" },
    { id: "analisis", icon: "📈", label: "Novedades y Asistencia", step: "CONTROL", short: "Novedades" }
  ];
}

function renderManagementLayout() {
  const role = STATE.user.role;
  const navItems = getMenuForRole(role);
  if (!navItems.some((n) => n.id === STATE.activeView)) {
    STATE.activeView = navItems[0].id;
  }
  const currentNav = navItems.find((n) => n.id === STATE.activeView) || navItems[0];
  const pendientes = STATE.solicitudes.filter((s) => s.estado === "PENDIENTE").length;

  const roleBadgeMap = {
    superadmin: { icon: "👑", text: "Superadministrador" },
    admin: { icon: "🛡️", text: "Administrador" },
    supervisor: { icon: "👷", text: "Supervisor" }
  };
  const roleInfo = roleBadgeMap[role] || { icon: "👤", text: role };

  return `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar-brand">
          <img src="/api/branding/logo" alt="Sterinova" onerror="this.style.display='none'" />
        </div>
        <div class="sidebar-user">
          <div class="avatar-circle">${roleInfo.icon}</div>
          <div>
            <div style="font-weight:700; font-size:0.92rem;">${STATE.user.nombre}</div>
            <div style="font-size:0.76rem; opacity:0.8;">${roleInfo.text} (${STATE.user.id})</div>
          </div>
        </div>
        <nav class="sidebar-nav">
          ${navItems
            .map(
              (item) => `
            <button type="button" class="nav-btn ${STATE.activeView === item.id ? "active" : ""}" data-view="${item.id}">
              <span>${item.icon}</span>
              <span>${item.label}</span>
              <span class="nav-step-badge">${
                item.id === "gps_solicitudes" && pendientes > 0 ? `${pendientes} Nuevas` : item.step
              }</span>
            </button>
          `
            )
            .join("")}
        </nav>
        <div class="sidebar-footer">
          <button type="button" id="btn-logout" class="btn btn-danger btn-block btn-sm">
            Cerrar Sesión
          </button>
        </div>
      </aside>

      <div class="main-area">
        <header class="topbar">
          <div>
            <div class="topbar-title">${currentNav.icon} ${currentNav.label}</div>
          </div>
          <div style="display:flex; gap:10px; align-items:center;">
            ${
              STATE.deferredInstallPrompt
                ? `<button type="button" id="btn-install-pwa" class="btn btn-action btn-sm">📲 Instalar App</button>`
                : ""
            }
            <span class="badge badge-info">${roleInfo.icon} ${roleInfo.text}</span>
            <button type="button" id="btn-top-logout" class="btn btn-danger btn-sm">
              Cerrar Sesión
            </button>
          </div>
        </header>

        <main class="content-container">
          ${renderManagementViewContent()}
        </main>
      </div>

      <nav class="bottom-nav">
        ${navItems
          .slice(0, 6)
          .map(
            (item) => `
          <button type="button" class="bottom-nav-item ${STATE.activeView === item.id ? "active" : ""}" data-view="${item.id}">
            <span class="icon">${item.icon}</span>
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
    case "usuarios":
      return renderSuperadminUsuarios();
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

// --- VISTA EXCLUSIVA SUPERADMIN: GESTIÓN DE USUARIOS (ADMINS Y SUPERVISORES) ---
function renderSuperadminUsuarios() {
  return `
    <div class="alert-banner alert-ok">
      <div>
        <strong>👑 Panel de Superadministrador:</strong> Desde aquí puedes crear las cuentas de <strong>Administradores</strong> y <strong>Supervisores</strong>. Luego ve a <strong>Empleados y Excel</strong> para cargar la plantilla de empleados.
      </div>
      <button type="button" class="btn btn-primary btn-sm" data-goto="empleados">
        Ir a Subir Excel de Empleados →
      </button>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <div class="card-title" id="usr-form-title">Crear / Actualizar Usuario (Administrador o Supervisor)</div>
        </div>
        <form id="form-usuario-sistema">
          <div class="grid-2">
            <div class="form-group">
              <label class="form-label">Usuario de Ingreso (Username)</label>
              <input type="text" id="usr-username" class="form-control" placeholder="Ej: admin_rrhh o sup_planta1" required />
            </div>
            <div class="form-group">
              <label class="form-label">Rol en el Sistema</label>
              <select id="usr-rol" class="form-control">
                <option value="admin">🛡️ Administrador (Gestión y Nómina)</option>
                <option value="supervisor">👷 Supervisor (Turnos, GPS y Permisos)</option>
                <option value="superadmin">👑 Superadministrador (Control Total)</option>
              </select>
            </div>
          </div>
          <div class="grid-2">
            <div class="form-group">
              <label class="form-label">Nombre Completo</label>
              <input type="text" id="usr-nombre" class="form-control" placeholder="Ej: Carlos Pérez" required />
            </div>
            <div class="form-group">
              <label class="form-label">Contraseña</label>
              <input type="password" id="usr-password" class="form-control" placeholder="Asignar contraseña" required />
            </div>
          </div>
          <div style="display:flex; gap:10px;">
            <button type="submit" class="btn btn-primary" style="flex:1;">💾 Guardar Usuario</button>
            <button type="button" id="btn-limpiar-usr" class="btn btn-outline">Limpiar</button>
          </div>
        </form>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">Usuarios Administrativos y Supervisores (${STATE.usuarios.length})</div>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Usuario</th>
                <th>Nombre</th>
                <th>Rol</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${STATE.usuarios
                .map((u) => {
                  const badge =
                    u.rol === "superadmin"
                      ? '<span class="badge badge-danger">👑 Superadmin</span>'
                      : u.rol === "admin"
                      ? '<span class="badge badge-info">🛡️ Administrador</span>'
                      : '<span class="badge badge-ok">👷 Supervisor</span>';
                  return `
                    <tr>
                      <td><strong>${u.username}</strong></td>
                      <td>${u.nombre}</td>
                      <td>${badge}</td>
                      <td>
                        <button type="button" class="btn btn-outline btn-sm btn-edit-usr" data-user="${u.username}">Editar</button>
                        <button type="button" class="btn btn-danger btn-sm btn-del-usr" data-user="${u.username}">Eliminar</button>
                      </td>
                    </tr>
                  `;
                })
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

// --- VISTA: DASHBOARD PRINCIPAL ---
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

  const steps = [
    {
      step: "PASO 1",
      title: "Catálogo de Turnos",
      desc: "Crear y editar plantillas de jornada, cruces de medianoche y descansos.",
      view: "turnos",
      meta: `${d.total_turnos} turnos activos`
    },
    {
      step: "PASO 2",
      title: "Días Festivos",
      desc: "Registrar calendario no laboral o cargar festivos de Colombia con un clic.",
      view: "festivos",
      meta: `${STATE.festivos.length} festivos registrados`
    },
    {
      step: "PASO 3",
      title: "Asignación de Turnos",
      desc: "Asignar turnos o descansos por calendario interactivo o por patrones semanales.",
      view: "asignacion",
      meta: d.ultima_fecha_asignada ? `Hasta ${d.ultima_fecha_asignada}` : "Sin asignaciones"
    },
    {
      step: "PASO 4",
      title: "Procesar Huellero y Exportar",
      desc: "Subir Excel del biométrico + marcaciones de App Móvil y descargar reportes corporativos.",
      view: "procesar",
      meta: `${STATE.reportes.length} reportes Excel`
    },
    {
      step: "PASO 5",
      title: "Análisis y Métricas",
      desc: "Consultar novedades, filtrar por KPI y exportar reporte de 6 pestañas.",
      view: "analisis",
      meta: `${(d.kpis?.horas_extra || 0).toFixed(2)} h extra`
    },
    {
      step: "PERSONAL & GPS",
      title: "Empleados, Reloj GPS y Solicitudes",
      desc: "Subir empleados desde Excel, administrar PIN de celular, marcaciones con dirección GPS y permisos.",
      view: "empleados",
      meta: `${d.total_empleados} empleados registrados`
    }
  ];

  return `
    <div class="alert-banner alert-${d.nivel_alerta || "ok"}">
      <div>
        <strong>Estado de Programación:</strong> ${d.mensaje_alerta}
      </div>
      <button type="button" class="btn btn-primary btn-sm" data-goto="asignacion">
        Ir a Asignar Turnos →
      </button>
    </div>

    <div class="grid-4" style="margin-bottom:20px;">
      <div class="kpi-card" data-goto="empleados">
        <div class="kpi-label">Empleados Registrados</div>
        <div class="kpi-value">${d.total_empleados}</div>
      </div>
      <div class="kpi-card" data-goto="turnos">
        <div class="kpi-label">Turnos del Catálogo</div>
        <div class="kpi-value">${d.total_turnos}</div>
      </div>
      <div class="kpi-card" data-goto="analisis">
        <div class="kpi-label">Total Horas Extras</div>
        <div class="kpi-value">${Number(d.kpis?.horas_extra || 0).toFixed(2)}</div>
      </div>
      <div class="kpi-card" data-goto="gps_solicitudes">
        <div class="kpi-label">Marcaciones GPS / Solicitudes</div>
        <div class="kpi-value">${STATE.marcacionesMoviles.length} / ${STATE.solicitudes.length}</div>
      </div>
    </div>

    <div class="grid-2">
      ${steps
        .map(
          (s) => `
        <div class="card" style="margin-bottom:0; display:flex; flex-direction:column; justify-content:space-between;">
          <div>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
              <span class="badge badge-info" style="color:var(--naranja); background:var(--naranja-light);">${s.step}</span>
              <span class="badge badge-info">${s.meta}</span>
            </div>
            <div class="card-title" style="margin-bottom:6px;">${s.title}</div>
            <p style="font-size:0.9rem; color:var(--texto-sec); margin-bottom:16px;">${s.desc}</p>
          </div>
          <button type="button" class="btn btn-primary btn-block" data-goto="${s.view}">
            Abrir Módulo
          </button>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

// --- VISTA 1: CATÁLOGO DE TURNOS ---
function renderAdminTurnos() {
  return `
    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <div class="card-title" id="turno-form-title">Nuevo Turno / Plantilla de Jornada</div>
        </div>
        <form id="form-turno">
          <input type="hidden" id="turno-id" value="" />
          <div class="form-group">
            <label class="form-label">Nombre del Turno</label>
            <input type="text" id="turno-nombre" class="form-control" placeholder="Ej: Produccion Horario 1" required />
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
              <label class="form-label">Tolerancia (minutos)</label>
              <input type="number" id="turno-tolerancia" class="form-control" value="10" min="0" />
            </div>
            <div class="form-group">
              <label class="form-label">Descanso intermedio (minutos)</label>
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
          <div class="card-title">Turnos Registrados (${STATE.turnos.length})</div>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Entrada</th>
                <th>Salida</th>
                <th>Cruza Medianoche</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${
                STATE.turnos.length === 0
                  ? `<tr><td colspan="5" style="text-align:center; padding:20px;">No hay turnos creados aún.</td></tr>`
                  : STATE.turnos
                      .map(
                        (t) => `
                <tr>
                  <td><strong>${t.nombre}</strong></td>
                  <td>${t.hora_entrada}</td>
                  <td>${t.hora_salida}</td>
                  <td>${
                    t.cruza_medianoche
                      ? '<span class="badge badge-warn">Sí (Nocturno)</span>'
                      : '<span class="badge badge-ok">No</span>'
                  }</td>
                  <td>
                    <button type="button" class="btn btn-outline btn-sm btn-edit-turno" data-id="${t.id}">Editar</button>
                    <button type="button" class="btn btn-danger btn-sm btn-del-turno" data-id="${t.id}">Eliminar</button>
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
                  ? `<tr><td colspan="3" style="text-align:center; padding:20px;">No hay festivos cargados. Pulsa "Cargar Festivos Colombia".</td></tr>`
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

// --- VISTA 3: ASIGNACIÓN DE TURNOS ---
function renderAdminAsignacion() {
  const [year, month] = STATE.calMonth.split("-").map(Number);
  const firstDay = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const startWeekday = (firstDay.getDay() + 6) % 7;

  const festivosSet = new Set(STATE.festivos.map((f) => f.fecha));
  const asigPorFecha = {};
  STATE.asignaciones.forEach((a) => {
    if (STATE.selectedEmployees.has(a.id_empleado)) {
      if (!asigPorFecha[a.fecha]) asigPorFecha[a.fecha] = [];
      asigPorFecha[a.fecha].push(a);
    }
  });

  const cells = [];
  for (let i = 0; i < startWeekday; i++) {
    cells.push(`<div class="cal-day empty"></div>`);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const fechaIso = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const isSelected = STATE.selectedDates.has(fechaIso);
    const isHoliday = festivosSet.has(fechaIso);
    const items = asigPorFecha[fechaIso] || [];
    let etiqueta = "";
    let isRest = false;
    if (items.length > 0) {
      const nombres = [...new Set(items.map((x) => x.nombre_turno))];
      etiqueta = nombres.length === 1 ? nombres[0] : `Varios (${items.length})`;
      isRest = nombres.length === 1 && nombres[0] === "DESCANSO";
      if (STATE.selectedEmployees.size > 1) {
        etiqueta += ` [${items.length}/${STATE.selectedEmployees.size}]`;
      }
    }
    cells.push(`
      <div class="cal-day ${isSelected ? "selected" : ""} ${isHoliday ? "holiday" : ""}" data-date="${fechaIso}">
        <div class="cal-day-num">
          <span>${d}</span>
          ${isHoliday ? '<span title="Festivo" style="color:var(--naranja); font-size:0.72rem;">★</span>' : ""}
        </div>
        ${etiqueta ? `<div class="cal-day-shift ${isRest ? "rest" : ""}">${etiqueta}</div>` : ""}
      </div>
    `);
  }

  const q = STATE.searchEmpAsignacion.toLowerCase();
  const empleadosFiltrados = STATE.empleados.filter(
    (e) => e.id_empleado.toLowerCase().includes(q) || e.nombre.toLowerCase().includes(q)
  );

  return `
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
              ? `<div style="padding:18px; text-align:center; color:var(--texto-sec);">No hay empleados registrados.</div>`
              : empleadosFiltrados
                  .map((e) => {
                    const checked = STATE.selectedEmployees.has(e.id_empleado);
                    return `
                <div class="emp-item ${checked ? "selected" : ""}" data-emp="${e.id_empleado}">
                  <input type="checkbox" ${checked ? "checked" : ""} style="pointer-events:none;" />
                  <div>
                    <div style="font-weight:700;">${e.nombre}</div>
                    <div style="font-size:0.76rem; color:var(--texto-sec);">ID: ${e.id_empleado}</div>
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
            <div class="card-title">2. Seleccione Días en el Calendario (${STATE.selectedDates.size} días marcados en azul)</div>
            <div style="display:flex; gap:8px; align-items:center;">
              <input type="month" id="cal-month-picker" class="form-control" value="${STATE.calMonth}" style="width:170px;" />
              <button type="button" id="btn-clear-dates" class="btn btn-outline btn-sm">Limpiar Días</button>
            </div>
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
            <div style="display:flex; gap:12px; flex-wrap:wrap; margin-top:4px;">
              ${["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]
                .map(
                  (d, idx) => `
                <label style="display:flex; align-items:center; gap:5px; font-weight:600; cursor:pointer;">
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

// --- VISTA 4: PROCESAR HUELLERO ---
function renderAdminProcesar() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();

  return `
    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <div class="card-title">Paso 4: Procesar Excel del Huellero + Marcaciones Móviles</div>
        </div>
        <form id="form-procesar-huellero">
          <div class="form-group">
            <label class="form-label">Archivos Excel del Reloj Biométrico (.xlsx / .xls)</label>
            <input type="file" id="proc-files" class="form-control" accept=".xlsx,.xls" multiple />
            <small style="color:var(--texto-sec); font-size:0.78rem;">
              Puede subir uno o varios archivos Excel del huellero, o dejar vacío para liquidar con las marcaciones de la App Móvil.
            </small>
          </div>

          <div class="grid-2">
            <div class="form-group">
              <label class="form-label">Fecha Inicio del Período</label>
              <input type="date" id="proc-inicio" class="form-control" value="${y}-${m}-01" required />
            </div>
            <div class="form-group">
              <label class="form-label">Fecha Fin del Período (máx 31 días)</label>
              <input type="date" id="proc-fin" class="form-control" value="${y}-${m}-${String(lastDay).padStart(2, "0")}" required />
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
              Incluir empleados no programados (generar auditoría aparte)
            </label>
          </div>

          <button type="submit" id="btn-submit-procesar" class="btn btn-action btn-block" style="padding:14px; font-size:1rem;">
            ⚙️ Procesar Huellero y Generar Reportes Corporativos Excel
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
                  ? `<tr><td colspan="4" style="text-align:center; padding:24px;">Aún no hay reportes generados.</td></tr>`
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

// --- VISTA 5: ANÁLISIS Y MÉTRICAS ---
function renderAdminAnalisis() {
  const { kpis, filas, turnos_disponibles } = STATE.analisisData;
  const f = STATE.analisisFiltros;

  const kpiCards = [
    { key: "horas_extra", label: "Total Horas Extras", val: Number(kpis.horas_extra || 0).toFixed(2) },
    { key: "minutos_tardanza", label: "Minutos de Tardanza", val: kpis.minutos_tardanza || 0 },
    { key: "ausencias", label: "Total Ausencias", val: kpis.ausencias || 0 },
    { key: "llegadas_tempranas", label: "Llegadas Tempranas", val: kpis.llegadas_tempranas || 0 }
  ];

  return `
    <div class="grid-4" style="margin-bottom:18px;">
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

    <div class="card">
      <div class="card-header">
        <div class="card-title">Filtros de Análisis y Exportación</div>
        <button type="button" id="btn-exportar-novedades" class="btn btn-action btn-sm">
          📊 Exportar Reporte de Novedades (6 Pestañas Excel)
        </button>
      </div>
      <div class="grid-4" style="align-items:end;">
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label">Empleado</label>
          <select id="ana-emp" class="form-control">
            <option value="TODOS">TODOS LOS EMPLEADOS</option>
            ${STATE.empleados
              .map(
                (e) =>
                  `<option value="${e.id_empleado}" ${f.id_empleado === e.id_empleado ? "selected" : ""}>${e.id_empleado} - ${e.nombre}</option>`
              )
              .join("")}
          </select>
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label">Turno</label>
          <select id="ana-turno" class="form-control">
            <option value="TODOS">TODOS LOS TURNOS</option>
            ${turnos_disponibles
              .map((t) => `<option value="${t}" ${f.turno === t ? "selected" : ""}>${t}</option>`)
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
                ? `<tr><td colspan="11" style="text-align:center; padding:24px;">No hay registros para los filtros seleccionados.</td></tr>`
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
                      <td>${row.turno}</td>
                      <td>${row.hora_entrada_teorica || "—"}</td>
                      <td>${row.hora_entrada_real || "—"}</td>
                      <td>${row.hora_salida_teorica || "—"}</td>
                      <td>${row.hora_salida_real || "—"}</td>
                      <td><strong>${Number(row.horas_extra).toFixed(2)}</strong></td>
                      <td><span style="font-size:0.8rem; color:var(--petroleo); font-weight:600;">${row.desglose}</span></td>
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

// --- VISTA 6: GESTIÓN DE EMPLEADOS Y SUBIDA DE EXCEL ---
function renderAdminEmpleados() {
  return `
    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <div class="card-title">📥 Subir Excel con los Empleados (Huellero o Listado)</div>
        </div>
        <p style="font-size:0.9rem; color:var(--texto-sec); margin-bottom:14px;">
          Sube el archivo Excel del reloj biométrico o un listado con columnas <strong>ID_Empleado</strong> (Columna A) y <strong>Nombre</strong> (Columna B). A cada empleado se le habilitará su acceso móvil (PIN por defecto: <code>1234</code> o últimos 4 dígitos).
        </p>
        <div class="form-group">
          <label class="form-label">Seleccionar archivo Excel (.xlsx / .xls)</label>
          <input type="file" id="import-emp-excel" class="form-control" accept=".xlsx,.xls" />
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">Registrar / Actualizar Empleado Individual</div>
        </div>
        <form id="form-empleado">
          <div class="grid-2">
            <div class="form-group">
              <label class="form-label">ID Empleado / Código Biométrico</label>
              <input type="text" id="emp-id" class="form-control" placeholder="Ej: 141 o 00000002" required />
            </div>
            <div class="form-group">
              <label class="form-label">PIN de Acceso Celular</label>
              <input type="text" id="emp-pin" class="form-control" value="1234" required />
            </div>
          </div>
          <div class="grid-2">
            <div class="form-group">
              <label class="form-label">Nombre Completo</label>
              <input type="text" id="emp-nombre" class="form-control" placeholder="Apellidos y Nombres" required />
            </div>
            <div class="form-group">
              <label class="form-label">Cargo / Área</label>
              <input type="text" id="emp-cargo" class="form-control" value="Operario" />
            </div>
          </div>
          <button type="submit" class="btn btn-primary btn-block">💾 Guardar Empleado</button>
        </form>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">Directorio de Empleados (${STATE.empleados.length})</div>
      </div>
      <div class="table-responsive" style="max-height:460px;">
        <table>
          <thead>
            <tr>
              <th>ID Biométrico</th>
              <th>Nombre Completo</th>
              <th>Cargo</th>
              <th>PIN App Móvil</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${
              STATE.empleados.length === 0
                ? `<tr><td colspan="5" style="text-align:center; padding:22px;">No hay empleados cargados. Sube el archivo Excel arriba o registra uno manualmente.</td></tr>`
                : STATE.empleados
                    .map(
                      (e) => `
              <tr>
                <td><strong>${e.id_empleado}</strong></td>
                <td>${e.nombre}</td>
                <td>${e.cargo || "Operario"}</td>
                <td><code>${e.pin || "1234"}</code></td>
                <td>
                  <button type="button" class="btn btn-outline btn-sm btn-edit-emp" data-id="${e.id_empleado}" data-nombre="${e.nombre}" data-cargo="${e.cargo || "Operario"}" data-pin="${e.pin || "1234"}">Editar</button>
                  <button type="button" class="btn btn-danger btn-sm btn-del-emp" data-id="${e.id_empleado}">Eliminar</button>
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

// --- VISTA 7: MONITOREO GPS (DIRECCIÓN + COORDENADAS) Y SOLICITUDES ---
function renderGpsYSolicitudes() {
  return `
    <div class="card">
      <div class="card-header">
        <div class="card-title">📍 Marcaciones Móviles GPS con Dirección y Coordenadas (${STATE.marcacionesMoviles.length})</div>
      </div>
      <div class="table-responsive" style="max-height:400px;">
        <table>
          <thead>
            <tr>
              <th>Fecha y Hora</th>
              <th>Empleado</th>
              <th>Tipo</th>
              <th>Dirección Física Detectada</th>
              <th>Coordenadas GPS</th>
              <th>Mapa</th>
            </tr>
          </thead>
          <tbody>
            ${
              STATE.marcacionesMoviles.length === 0
                ? `<tr><td colspan="6" style="text-align:center; padding:22px;">Aún no hay marcaciones registradas desde celulares.</td></tr>`
                : STATE.marcacionesMoviles
                    .map(
                      (m) => `
                <tr>
                  <td><strong>${m.fecha_hora}</strong></td>
                  <td><strong>${m.nombre_empleado}</strong><br/><small>ID: ${m.id_empleado}</small></td>
                  <td><span class="badge ${m.tipo === "ENTRADA" ? "badge-ok" : "badge-warn"}">${m.tipo}</span></td>
                  <td><strong>${m.direccion || "Sin dirección registrada"}</strong></td>
                  <td>${
                    m.latitud != null && m.longitud != null
                      ? `<code>${m.latitud}, ${m.longitud}</code> (±${m.precision_m || 0}m)`
                      : "Sin coordenadas"
                  }</td>
                  <td>
                    ${
                      m.latitud != null && m.longitud != null
                        ? `<a href="https://www.google.com/maps?q=${m.latitud},${m.longitud}" target="_blank" class="btn btn-outline btn-sm">🗺️ Ver Mapa</a>`
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

    <div class="card">
      <div class="card-header">
        <div class="card-title">📝 Solicitudes y Permisos de Empleados (${STATE.solicitudes.length})</div>
      </div>
      <div class="table-responsive" style="max-height:380px;">
        <table>
          <thead>
            <tr>
              <th>Empleado</th>
              <th>Tipo / Fechas</th>
              <th>Motivo</th>
              <th>Estado</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            ${
              STATE.solicitudes.length === 0
                ? `<tr><td colspan="5" style="text-align:center; padding:22px;">No hay solicitudes pendientes ni históricas.</td></tr>`
                : STATE.solicitudes
                    .map(
                      (s) => `
                <tr>
                  <td><strong>${s.nombre_empleado}</strong><br/><small>ID: ${s.id_empleado}</small></td>
                  <td><strong>${s.tipo}</strong><br/><small>${s.fecha_inicio} a ${s.fecha_fin}</small></td>
                  <td>${s.motivo}</td>
                  <td>
                    <span class="badge ${
                      s.estado === "APROBADA"
                        ? "badge-ok"
                        : s.estado === "RECHAZADA"
                        ? "badge-danger"
                        : "badge-warn"
                    }">${s.estado}</span>
                  </td>
                  <td>
                    ${
                      s.estado === "PENDIENTE"
                        ? `
                      <button type="button" class="btn btn-primary btn-sm btn-resp-sol" data-id="${s.id}" data-estado="APROBADA">✔ Aprobar</button>
                      <button type="button" class="btn btn-danger btn-sm btn-resp-sol" data-id="${s.id}" data-estado="RECHAZADA">✖ Rechazar</button>
                    `
                        : `<small>${s.respuesta_admin || "Procesada"}</small>`
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

// ============================================================================
// EVENTOS DE GESTIÓN (SUPERADMIN, ADMIN, SUPERVISOR)
// ============================================================================

function bindManagementEvents() {
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
            rol: document.getElementById("usr-rol").value
          })
        });
        showToast("Usuario guardado correctamente", "success");
        await loadUsuarios();
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    document.getElementById("btn-limpiar-usr")?.addEventListener("click", () => {
      document.getElementById("usr-username").value = "";
      document.getElementById("usr-nombre").value = "";
      document.getElementById("usr-password").value = "";
      document.getElementById("usr-rol").value = "admin";
    });

    document.querySelectorAll(".btn-edit-usr").forEach((btn) => {
      btn.addEventListener("click", () => {
        const u = STATE.usuarios.find((x) => x.username === btn.dataset.user);
        if (!u) return;
        document.getElementById("usr-username").value = u.username;
        document.getElementById("usr-nombre").value = u.nombre;
        document.getElementById("usr-rol").value = u.rol;
        document.getElementById("usr-password").placeholder = "Nueva contraseña (o repetir actual)";
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
          await loadUsuarios();
          renderApp();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    });
  }

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
        await apiFetch("/api/turnos", {
          method: "POST",
          body: JSON.stringify({ id: id || null, nombre, hora_entrada, hora_salida, tolerancia_min, descanso_min })
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
      document.getElementById("turno-form-title").textContent = "Nuevo Turno / Plantilla de Jornada";
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
        document.getElementById("turno-form-title").textContent = `Editando: ${t.nombre}`;
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
        const fecha = document.getElementById("festivo-fecha").value;
        const descripcion = document.getElementById("festivo-desc").value;
        await apiFetch("/api/festivos", {
          method: "POST",
          body: JSON.stringify({ fecha, descripcion })
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

  // --- Eventos Asignación de Turnos ---
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

  // --- Eventos Procesar Huellero ---
  const formProc = document.getElementById("form-procesar-huellero");
  if (formProc) {
    formProc.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("btn-submit-procesar");
      try {
        btn.disabled = true;
        btn.textContent = "⏳ Procesando marcaciones y generando reportes Excel...";
        const inputFiles = document.getElementById("proc-files").files;
        const archivos = [];
        for (const f of inputFiles) {
          const b64 = await fileToBase64(f);
          archivos.push({ filename: f.name, content_base64: b64 });
        }
        const payload = {
          archivos,
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
        showToast(`¡Éxito! ${res.filas_generadas} jornadas calculadas y ${res.reportes.length} archivos Excel listos`, "success");
        await Promise.all([loadReportes(), loadDashboard(), loadAnalisis()]);
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
        btn.disabled = false;
        btn.textContent = "⚙️ Procesar Huellero y Generar Reportes Corporativos Excel";
      }
    });
  }

  // --- Eventos Análisis y Métricas ---
  document.querySelectorAll("[data-kpi]").forEach((card) => {
    card.addEventListener("click", async () => {
      const key = card.dataset.kpi;
      STATE.analisisFiltros.kpi = STATE.analisisFiltros.kpi === key ? "" : key;
      await loadAnalisis();
      renderApp();
    });
  });

  document.getElementById("btn-aplicar-analisis")?.addEventListener("click", async () => {
    STATE.analisisFiltros.id_empleado = document.getElementById("ana-emp").value;
    STATE.analisisFiltros.turno = document.getElementById("ana-turno").value;
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

  // --- Eventos Empleados ---
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
            pin: document.getElementById("emp-pin").value
          })
        });
        showToast("Empleado guardado", "success");
        await Promise.all([loadEmpleados(), loadDashboard()]);
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    document.getElementById("import-emp-excel")?.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const b64 = await fileToBase64(file);
        const res = await apiFetch("/api/empleados/importar-excel", {
          method: "POST",
          body: JSON.stringify({ filename: file.name, content_base64: b64 })
        });
        showToast(`¡Se importaron ${res.importados} empleados desde el Excel!`, "success");
        await Promise.all([loadEmpleados(), loadDashboard()]);
        if (STATE.empleados.length > 0 && STATE.selectedEmployees.size === 0) {
          STATE.selectedEmployees.add(STATE.empleados[0].id_empleado);
        }
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
          await Promise.all([loadEmpleados(), loadDashboard()]);
          renderApp();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    });
  }

  // --- Eventos Responder Solicitudes ---
  document.querySelectorAll(".btn-resp-sol").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await apiFetch("/api/solicitudes/responder", {
          method: "POST",
          body: JSON.stringify({
            id: Number(btn.dataset.id),
            estado: btn.dataset.estado,
            respuesta_admin: `Revisado por ${STATE.user.nombre} (${STATE.user.role})`
          })
        });
        showToast(`Solicitud ${btn.dataset.estado}`, "success");
        await Promise.all([loadSolicitudes(), loadDashboard()]);
        renderApp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  });
}

// ============================================================================
// PORTAL / APP MÓVIL DEL EMPLEADO
// ============================================================================

const EMP_NAV = [
  { id: "emp_reloj", icon: "⏱️", label: "Reloj & Turno Hoy", short: "Marcar" },
  { id: "emp_turnos", icon: "🗓️", label: "Mis Turnos", short: "Mis Turnos" },
  { id: "emp_horas", icon: "💰", label: "Horas Extra y Recargos", short: "Mis Horas" },
  { id: "emp_permisos", icon: "📝", label: "Solicitar Permiso", short: "Permisos" }
];

function renderEmpleadoLayout() {
  const currentNav = EMP_NAV.find((n) => n.id === STATE.activeView) || EMP_NAV[0];

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
            <div style="font-size:0.75rem; opacity:0.8;">Empleado (ID: ${STATE.user.id})</div>
          </div>
        </div>
        <nav class="sidebar-nav">
          ${EMP_NAV.map(
            (item) => `
            <button type="button" class="nav-btn ${STATE.activeView === item.id ? "active" : ""}" data-view="${item.id}">
              <span>${item.icon}</span>
              <span>${item.label}</span>
            </button>
          `
          ).join("")}
        </nav>
        <div class="sidebar-footer">
          <button type="button" id="btn-emp-logout" class="btn btn-danger btn-block btn-sm">
            Cerrar Sesión
          </button>
        </div>
      </aside>

      <div class="main-area">
        <header class="topbar">
          <div>
            <div class="topbar-title">${currentNav.icon} ${currentNav.label}</div>
            <div style="font-size:0.78rem; color:var(--texto-sec);">${STATE.user.nombre} (ID: ${STATE.user.id})</div>
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            <span class="badge badge-info">📱 Empleado</span>
            <button type="button" id="btn-emp-top-logout" class="btn btn-danger btn-sm">Cerrar Sesión</button>
          </div>
        </header>

        <main class="content-container" style="max-width:860px;">
          ${renderEmpleadoViewContent()}
        </main>
      </div>

      <nav class="bottom-nav">
        ${EMP_NAV.map(
          (item) => `
          <button type="button" class="bottom-nav-item ${STATE.activeView === item.id ? "active" : ""}" data-view="${item.id}">
            <span class="icon">${item.icon}</span>
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
    solicitudes: []
  };

  if (STATE.activeView === "emp_reloj") {
    const now = new Date();
    const timeStr = now.toTimeString().slice(0, 8);
    const dateStr = now.toLocaleDateString("es-CO", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    });

    return `
      <div class="clock-widget">
        <div style="font-size:0.85rem; text-transform:uppercase; letter-spacing:1px; opacity:0.85;">
          Reloj Biométrico Móvil Sterinova
        </div>
        <div class="clock-time" id="live-clock-time">${timeStr}</div>
        <div class="clock-date">${dateStr}</div>
        <div id="gps-status-badge" style="font-size:0.83rem; margin-bottom:16px; opacity:0.95; line-height:1.5;">
          ${
            STATE.gpsActual
              ? `📍 <strong>Coordenadas:</strong> ${STATE.gpsActual.latitud}, ${STATE.gpsActual.longitud} (±${STATE.gpsActual.precision_m}m)<br/>🏠 <strong>Dirección:</strong> ${STATE.gpsActual.direccion || "Calculando..."}`
              : "📍 Obteniendo coordenadas GPS y dirección física..."
          }
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
          <div class="card-title">📲 Mis Últimas Marcaciones (Dirección y Coordenadas) (${r.marcaciones_moviles.length})</div>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Fecha y Hora</th>
                <th>Tipo</th>
                <th>Dirección Física</th>
                <th>Coordenadas GPS</th>
              </tr>
            </thead>
            <tbody>
              ${
                r.marcaciones_moviles.length === 0
                  ? `<tr><td colspan="4" style="text-align:center; padding:18px;">Pulsa "Marcar Entrada" o "Marcar Salida" arriba para registrar tu asistencia con dirección y coordenadas.</td></tr>`
                  : r.marcaciones_moviles
                      .map(
                        (m) => `
                  <tr>
                    <td><strong>${m.fecha_hora}</strong></td>
                    <td>
                      <span class="badge ${m.tipo === "ENTRADA" ? "badge-ok" : "badge-warn"}">${m.tipo}</span>
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
          <div class="card-title">📝 Solicitar Permiso, Cambio de Turno o Reportar Novedad</div>
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
            <textarea id="sol-motivo" class="form-control" rows="3" placeholder="Describe brevemente tu solicitud..." required></textarea>
          </div>
          <button type="submit" class="btn btn-action btn-block">📨 Enviar Solicitud</button>
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
                <th>Estado</th>
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
                          : s.estado === "RECHAZADA"
                          ? "badge-danger"
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
  document.querySelectorAll("[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      STATE.activeView = btn.dataset.view;
      renderApp();
    });
  });

  const logout = () => setUser(null);
  document.getElementById("btn-emp-logout")?.addEventListener("click", logout);
  document.getElementById("btn-emp-top-logout")?.addEventListener("click", logout);

  document.querySelectorAll("[data-punch]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        const tipo = btn.dataset.punch;
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
          dispositivo: navigator.userAgent.includes("Mobile") ? "App Celular" : "Navegador Web"
        };
        const res = await apiFetch("/api/empleado/marcar", {
          method: "POST",
          body: JSON.stringify(payload)
        });
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
        showToast("Solicitud enviada correctamente", "success");
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
