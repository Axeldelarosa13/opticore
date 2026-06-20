import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  browserLocalPersistence,
  setPersistence,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore,
  enableIndexedDbPersistence,
  collection,
  doc,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  writeBatch,
  serverTimestamp,
  increment
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const APP_VERSION = "opticore-1.3.1";
const BRANCHES = ["Alcalá", "Ortiz", "Lupitas"];
const ROLES = ["Administrador", "Optometrista", "Recepción"];
const DEFAULT_ADMIN = {
  displayName: "Isaac Ortiz",
  username: "isaacortiz",
  email: "isaacortiz@optica.com"
};
const ADMIN_VIEWS = new Set(["inventory", "purchases", "pos", "reports", "admin"]);
const BUSINESS_COLLECTIONS = [
  "patients",
  "appointments",
  "doctors",
  "inventory",
  "purchases",
  "sales",
  "orders",
  "exams",
  "followUps"
];
const ADMIN_ONLY_COLLECTIONS = ["inventory", "purchases", "sales"];
const CLINICAL_COLLECTIONS = BUSINESS_COLLECTIONS.filter((name) => !ADMIN_ONLY_COLLECTIONS.includes(name));

const NAV_ITEMS = [
  { id: "home", label: "Inicio", icon: "layout-dashboard" },
  { id: "appointments", label: "Agenda", icon: "calendar-days" },
  { id: "patients", label: "Expedientes", icon: "folder-heart" },
  { id: "exam", label: "Consulta", icon: "clipboard-pen" },
  { id: "lab", label: "Laboratorio", icon: "flask-conical" },
  { id: "inventory", label: "Inventario", icon: "boxes", admin: true },
  { id: "purchases", label: "Compras", icon: "truck", admin: true },
  { id: "pos", label: "Caja POS", icon: "shopping-cart", admin: true },
  { id: "reports", label: "Reportes", icon: "bar-chart-3", admin: true },
  { id: "admin", label: "Admin", icon: "settings", admin: true }
];

const STATUS_BADGE = {
  Programada: "badge",
  Confirmada: "badge green",
  "En consulta": "badge amber",
  Completada: "badge green",
  Cancelada: "badge red",
  Pendiente: "badge amber",
  "En laboratorio": "badge",
  Lista: "badge green",
  Entregada: "badge green",
  Bajo: "badge red",
  Activo: "badge green",
  Inactivo: "badge red"
};

let firebaseApp;
let auth;
let db;
let mount;
let modalRoot;
let toastHost;
let reminderTimer;
let runtimeGuardsReady = false;

const state = {
  bootstrapping: false,
  needsBootstrap: false,
  user: null,
  profile: null,
  branch: "Global",
  view: "home",
  selectedPatientId: "",
  selectedExamPatientId: "",
  filters: {
    appointmentDate: toDateInput(new Date()),
    patientSearch: "",
    stockSearch: "",
    reportRange: "30"
  },
  sync: "Conectando",
  cart: [],
  data: Object.fromEntries(BUSINESS_COLLECTIONS.concat("users").map((name) => [name, []])),
  unsubs: [],
  bootstrapWarning: ""
};

document.addEventListener("DOMContentLoaded", boot);
document.addEventListener("click", handleClick);
document.addEventListener("submit", handleSubmit);
document.addEventListener("change", handleChange);
document.addEventListener("input", handleInput);

async function boot() {
  mount = document.getElementById("appMount");
  modalRoot = document.getElementById("modalRoot");
  toastHost = document.getElementById("toastHost");
  setupRuntimeGuards();
  registerServiceWorker();

  if (!hasUsableConfig()) {
    renderMissingConfig();
    return;
  }

  try {
    firebaseApp = initializeApp(window.OPTI_FIREBASE_CONFIG);
    auth = getAuth(firebaseApp);
    db = getFirestore(firebaseApp);
    await setPersistence(auth, browserLocalPersistence);
    enableIndexedDbPersistence(db).catch(() => {});
    await detectBootstrapState();

    onAuthStateChanged(auth, async (user) => {
      if (state.bootstrapping) return;
      if (!user) {
        resetSession();
        renderAuth();
        return;
      }
      await loadSession(user);
    });
  } catch (error) {
    renderFatalError(error);
  }
}

function setupRuntimeGuards() {
  if (runtimeGuardsReady) return;
  runtimeGuardsReady = true;

  window.addEventListener("online", () => {
    state.sync = "Reconectando";
    showToast("Conexión recuperada. Sincronizando datos...", "success");
    renderApp(false);
  });

  window.addEventListener("offline", () => {
    state.sync = "Sin conexión";
    showToast("Sin conexión. Puedes seguir consultando datos ya cargados.", "error");
    renderApp(false);
  });

  window.addEventListener("error", (event) => {
    console.error(event.error || event.message);
    showToast("Ocurrió un error inesperado. Recarga si la pantalla no responde.", "error");
  });

  window.addEventListener("unhandledrejection", (event) => {
    console.error(event.reason);
    showToast(readableError(event.reason), "error");
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  });
}

function hasUsableConfig() {
  const config = window.OPTI_FIREBASE_CONFIG || {};
  return Boolean(
    config.apiKey &&
    config.projectId &&
    config.appId &&
    !String(config.apiKey).startsWith("TU_") &&
    !String(config.projectId).startsWith("TU_")
  );
}

async function detectBootstrapState() {
  try {
    const snap = await withTimeout(
      getDoc(doc(db, "app", "config")),
      8000,
      "No pude leer Firestore todavía. Revisa que Firestore esté creado y que las reglas estén desplegadas."
    );
    state.needsBootstrap = !snap.exists();
    state.bootstrapWarning = "";
  } catch (error) {
    state.needsBootstrap = false;
    state.bootstrapWarning = readableError(error);
  }
}

function resetSession() {
  cleanupListeners();
  state.user = null;
  state.profile = null;
  state.branch = "Global";
  state.view = "home";
  state.cart = [];
  state.sync = "Conectando";
  Object.keys(state.data).forEach((key) => {
    state.data[key] = [];
  });
  if (reminderTimer) clearInterval(reminderTimer);
}

async function loadSession(user) {
  try {
    const profileSnap = await getDoc(doc(db, "users", user.uid));
    if (!profileSnap.exists()) {
      await signOut(auth);
      showToast("Tu usuario existe en Auth, pero todavía no tiene acceso al sistema.", "error");
      return;
    }

    const profile = { id: user.uid, ...profileSnap.data() };
    if (!profile.active) {
      await signOut(auth);
      showToast("Usuario inactivo. Pide al administrador que reactive tu acceso.", "error");
      return;
    }

    state.user = user;
    state.profile = profile;
    state.branch = isAdmin() ? "Global" : profile.branch || "Alcalá";
    await startRealtime();
    startReminderLoop();
    renderApp();
  } catch (error) {
    showToast(readableError(error), "error");
    await signOut(auth);
  }
}

async function startRealtime() {
  cleanupListeners();
  const collections = isAdmin() ? BUSINESS_COLLECTIONS.concat("users") : CLINICAL_COLLECTIONS;
  collections.forEach((name) => {
    const source = !isAdmin() && BUSINESS_COLLECTIONS.includes(name)
      ? query(collection(db, name), where("branch", "==", state.profile.branch || ""))
      : collection(db, name);
    const unsubscribe = onSnapshot(
      source,
      { includeMetadataChanges: true },
      (snapshot) => {
        state.data[name] = snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }));
        sortCollection(name);
        state.sync = snapshot.metadata.fromCache ? "Modo offline" : "En tiempo real";
        renderApp(false);
        queueReminderCheck();
      },
      (error) => {
        state.sync = "Error de sync";
        showToast(`${name}: ${readableError(error)}`, "error");
        renderApp(false);
      }
    );
    state.unsubs.push(unsubscribe);
  });

  if (!isAdmin()) {
    state.data.users = [state.profile];
  }
}

function cleanupListeners() {
  state.unsubs.forEach((unsubscribe) => unsubscribe());
  state.unsubs = [];
}

function sortCollection(name) {
  const rows = state.data[name] || [];
  if (name === "appointments") {
    rows.sort((a, b) => new Date(a.startsAt || 0) - new Date(b.startsAt || 0));
    return;
  }
  if (["patients", "doctors", "inventory", "users"].includes(name)) {
    rows.sort((a, b) => String(a.name || a.displayName || "").localeCompare(String(b.name || b.displayName || ""), "es"));
    return;
  }
  rows.sort((a, b) => dateValue(b.createdAt) - dateValue(a.createdAt));
}

function renderMissingConfig() {
  mount.className = "app-loading";
  mount.innerHTML = `
    <section class="config-card">
      <div class="brand" style="background:#08111f;border-radius:8px;margin-bottom:18px;padding:14px;">
        <div class="brand-mark">OC</div>
        <div>
          <h1>OptiCore ERP</h1>
          <p>Configuración pendiente</p>
        </div>
      </div>
      <h2>Primero pega la configuración de Firebase</h2>
      <p class="hint">Esta versión está lista para GitHub Pages, Firebase Authentication y Firestore en tiempo real. Para conectarla, reemplaza los valores de <strong>firebase-config.js</strong> con la configuración de tu Web App de Firebase.</p>
      <div class="card" style="box-shadow:none;margin:16px 0;background:#f8fafc;">
        <p class="eyebrow">Pasos rápidos</p>
        <ol class="hint" style="line-height:1.8;margin-bottom:0;">
          <li>Crea un proyecto Firebase.</li>
          <li>Activa Authentication con Email/Password.</li>
          <li>Activa Cloud Firestore.</li>
          <li>Copia la configuración Web App en <strong>firebase-config.js</strong>.</li>
          <li>Publica las reglas de Firestore.</li>
        </ol>
      </div>
      <button class="btn btn-primary" data-action="reload"><i data-lucide="refresh-cw"></i> Ya pegué la configuración</button>
      <p class="created-by">Creada por delarosaleyva.shop</p>
    </section>
  `;
  renderIcons();
}

function renderFatalError(error) {
  mount.className = "app-loading";
  mount.innerHTML = `
    <section class="config-card">
      <h2>No se pudo iniciar Firebase</h2>
      <p class="hint">${escapeHtml(readableError(error))}</p>
      <button class="btn btn-primary" data-action="reload">Reintentar</button>
    </section>
  `;
}

function renderAuth() {
  mount.className = "";
  mount.innerHTML = `
    <main class="auth-layout">
      <section class="auth-visual">
        <div class="brand" style="border-bottom:0;padding:0;">
          <div class="brand-mark">OC</div>
          <div>
            <h1>OptiCore</h1>
            <p>ERP clínico óptico</p>
          </div>
        </div>
        <div>
          <h1>Control profesional para ópticas, consultas y caja.</h1>
          <p>Agenda, expedientes, preguntas clínicas, recetas, laboratorio, inventario, caja y administración conectados a Firestore en tiempo real.</p>
        </div>
        <p class="created-by">Creada por delarosaleyva.shop</p>
      </section>
      <section class="auth-card">
        <p class="eyebrow">${state.needsBootstrap ? "Primer acceso" : "Acceso seguro"}</p>
        <h2>${state.needsBootstrap ? "Crear administrador inicial" : "Iniciar sesión"}</h2>
        <p class="hint">${state.needsBootstrap ? "Este formulario aparece porque el proyecto aún no tiene configuración inicial. Crea el primer admin y después todo se administra desde la app." : "Usa el correo y contraseña creados para cada doctor o administrador."}</p>
        ${state.bootstrapWarning ? `<div class="chip warn" style="margin:12px 0;align-items:flex-start;line-height:1.4;">${escapeHtml(state.bootstrapWarning)} Si es el primer acceso, despliega primero las reglas con firebase deploy --only firestore.</div>` : ""}
        <form class="stack" data-form="${state.needsBootstrap ? "bootstrap" : "login"}">
          ${state.needsBootstrap ? `
            <label class="field"><span>Nombre</span><input class="input" name="displayName" required autocomplete="name" value="${escapeAttr(DEFAULT_ADMIN.displayName)}"></label>
            <label class="field"><span>Usuario interno</span><input class="input" name="username" required autocomplete="username" value="${escapeAttr(DEFAULT_ADMIN.username)}"></label>
          ` : ""}
          <label class="field"><span>Correo</span><input class="input" type="email" name="email" required autocomplete="email" value="${state.needsBootstrap ? escapeAttr(DEFAULT_ADMIN.email) : ""}"></label>
          <label class="field"><span>Contraseña</span><input class="input" type="password" name="password" required minlength="6" autocomplete="${state.needsBootstrap ? "new-password" : "current-password"}"></label>
          <button class="btn btn-primary" type="submit"><i data-lucide="${state.needsBootstrap ? "shield-plus" : "log-in"}"></i>${state.needsBootstrap ? "Crear admin y entrar" : "Entrar"}</button>
        </form>
        <p class="created-by">Creada por delarosaleyva.shop</p>
      </section>
    </main>
  `;
  renderIcons();
}

function renderApp(keepView = true) {
  if (!state.profile) return;

  const allowed = allowedNavItems();
  if (!keepView || !allowed.some((item) => item.id === state.view)) {
    state.view = allowed.some((item) => item.id === state.view) ? state.view : "home";
  }

  mount.className = "";
  mount.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">OC</div>
          <div>
            <h1>OptiCore</h1>
            <p>Powered by delarosaleyva.shop</p>
          </div>
        </div>
        <nav class="nav" aria-label="Navegación principal">
          ${allowed.map((item) => `
            <button class="nav-button ${item.id === state.view ? "active" : ""}" type="button" data-action="navigate" data-view="${item.id}" title="${item.label}">
              <i data-lucide="${item.icon}"></i>
              <span>${item.label}</span>
            </button>
          `).join("")}
        </nav>
        <div class="sidebar-footer">
          <strong>${escapeHtml(state.profile.displayName || state.profile.email || "Usuario")}</strong>
          <span>${escapeHtml(state.profile.role || "Rol")} · ${escapeHtml(state.profile.branch || "Sin sucursal")}</span>
          <button class="btn btn-quiet" style="width:100%;margin-top:12px;" type="button" data-action="open-profile"><i data-lucide="user-cog"></i> Mi perfil</button>
          <span style="margin-top:10px;">${escapeHtml(APP_VERSION)}</span>
          <p class="created-by">Creada por delarosaleyva.shop</p>
        </div>
      </aside>
      <section class="workspace">
        <header class="topbar">
          <div>
            <h2>${currentTitle()}</h2>
            <div class="topbar-meta">
              <span>${formatLongDate(new Date())}</span>
              <span>·</span>
              <span>${isAdmin() ? "Administrador" : escapeHtml(state.profile.branch || "")}</span>
              <span class="${syncClass()}">${state.sync}</span>
            </div>
          </div>
          <div class="topbar-actions">
            ${isAdmin() ? branchSelector() : ""}
            <button class="btn btn-quiet" type="button" data-action="enable-notifications"><i data-lucide="bell-ring"></i> Recordatorios</button>
            ${canAccessView("patients") ? `<button class="btn btn-primary" type="button" data-action="modal" data-modal="patient"><i data-lucide="user-plus"></i> Paciente</button>` : ""}
          </div>
        </header>
        <main class="content">
          ${renderCurrentView()}
        </main>
      </section>
    </div>
  `;
  renderIcons();
}

function allowedNavItems() {
  return NAV_ITEMS.filter((item) => canAccessView(item.id));
}

function canAccessView(view) {
  const item = NAV_ITEMS.find((entry) => entry.id === view);
  if (!item) return false;
  if (item.admin) return isAdmin();
  if (isAdmin() || view === "home") return true;
  const permissions = state.profile?.permissions || {};
  if (view === "appointments") return permissions.appointments !== false;
  if (view === "patients" || view === "exam") return permissions.patients !== false;
  if (view === "lab") return permissions.lab !== false;
  return true;
}

function canOpenModal(type) {
  if (type === "profile") return true;
  if (["inventory", "purchase", "user", "doctor"].includes(type)) return isAdmin();
  if (type === "appointment") return canAccessView("appointments");
  if (type === "patient" || type === "followUp") return canAccessView("patients");
  if (type === "order") return canAccessView("lab");
  return true;
}

function canRunAction(action) {
  const adminActions = new Set([
    "cart-add",
    "cart-qty",
    "cart-remove",
    "cart-clear",
    "checkout",
    "stock-adjust",
    "password-reset",
    "user-toggle",
    "user-delete",
    "export-backup",
    "export-patients-csv",
    "export-sales-csv"
  ]);
  if (adminActions.has(action)) return isAdmin();
  if (["appointment-delete", "agenda-shift", "agenda-today"].includes(action)) return canAccessView("appointments");
  if (["order-delete", "order-payoff", "export-lab-csv"].includes(action)) return canAccessView("lab");
  if (["followup-done", "followup-delete"].includes(action)) return canAccessView("patients");
  if (action === "receipt-print") return isAdmin();
  return true;
}

function canSubmitForm(name) {
  if (["login", "bootstrap", "profile"].includes(name)) return true;
  if (["inventory", "purchase", "user", "doctor"].includes(name)) return isAdmin();
  if (name === "appointment") return canAccessView("appointments");
  if (name === "patient" || name === "followUp") return canAccessView("patients");
  if (name === "exam") return canAccessView("exam");
  if (name === "order") return canAccessView("lab");
  return true;
}

function currentTitle() {
  const found = NAV_ITEMS.find((item) => item.id === state.view);
  return found ? found.label : "Inicio";
}

function branchSelector() {
  const options = ["Global"].concat(BRANCHES).map((branch) => `<option value="${branch}" ${state.branch === branch ? "selected" : ""}>${branch === "Global" ? "Vista global" : branch}</option>`);
  return `<select class="select" data-action="switch-branch" aria-label="Sucursal">${options.join("")}</select>`;
}

function syncClass() {
  const value = String(state.sync || "").toLowerCase();
  if (value.includes("error") || value.includes("sin conexión")) return "chip danger";
  if (value.includes("offline") || value.includes("reconectando")) return "chip warn";
  return "chip";
}

function renderCurrentView() {
  const views = {
    home: renderHome,
    appointments: renderAppointments,
    patients: renderPatients,
    exam: renderExam,
    lab: renderLab,
    inventory: renderInventory,
    purchases: renderPurchases,
    pos: renderPOS,
    reports: renderReports,
    admin: renderAdmin
  };
  return `<div class="view">${(views[state.view] || renderHome)()}</div>`;
}

function renderHome() {
  const appointments = visibleRows("appointments");
  const patients = visibleRows("patients");
  const inventory = visibleRows("inventory");
  const orders = visibleRows("orders");
  const sales = visibleRows("sales");
  const exams = visibleRows("exams");
  const today = toDateInput(new Date());
  const todayAppointments = appointments.filter((item) => toDateInput(new Date(item.startsAt)) === today);
  const next = appointments.find((item) => new Date(item.startsAt) >= new Date() && !["Completada", "Cancelada"].includes(item.status));
  const lowStock = inventory.filter((item) => Number(item.stock || 0) <= Number(item.minStock || 2));
  const pendingOrders = orders.filter((item) => !["Entregada", "Cancelada"].includes(item.status));
  const followUps = visibleRows("followUps").filter((item) => item.done !== true);
  const overdueFollowUps = followUps.filter((item) => item.dueDate && new Date(`${item.dueDate}T23:59:59`) < new Date());
  const dueSoonOrders = pendingOrders.filter((item) => item.dueDate && new Date(`${item.dueDate}T23:59:59`) <= addDays(new Date(), 2));
  const monthSales = sales
    .filter((sale) => daysBetween(new Date(), dateValue(sale.createdAt)) <= 30)
    .reduce((sum, sale) => sum + Number(sale.total || 0), 0);

  return `
    <section class="hero-panel">
      <div>
        <p class="eyebrow">Panel operativo</p>
        <h2>${greeting()}, ${escapeHtml(firstName(state.profile.displayName || "equipo"))}</h2>
        <p>Tu agenda, expedientes, laboratorio y operación comercial están conectados en tiempo real. Los optometristas ven solo el flujo clínico; administración controla inventario, compras, caja, reportes y usuarios.</p>
      </div>
      <div class="focus-list">
        ${focusItem("Próxima cita", next ? `${formatTime(next.startsAt)} · ${escapeHtml(next.patientName || "Paciente")}` : "Sin citas próximas")}
        ${focusItem("Pendientes de laboratorio", `${pendingOrders.length} órdenes activas`)}
        ${isAdmin() ? focusItem("Alertas de stock", `${lowStock.length} productos por revisar`) : focusItem("Seguimientos vencidos", `${overdueFollowUps.length} por revisar`)}
      </div>
    </section>
    ${renderActionCenter({ todayAppointments, overdueFollowUps, dueSoonOrders, lowStock })}
    <section class="grid grid-4" style="margin-top:16px;">
      ${statCard("Citas de hoy", todayAppointments.length, "calendar-check")}
      ${statCard("Expedientes", patients.length, "folder-heart")}
      ${isAdmin() ? statCard("Ventas 30 días", currency(monthSales), "banknote") : statCard("Consultas", exams.length, "clipboard-pen")}
      ${isAdmin() ? statCard("Stock crítico", lowStock.length, "triangle-alert") : statCard("Órdenes activas", pendingOrders.length, "flask-conical")}
    </section>
    <section class="grid grid-2" style="margin-top:16px;">
      <div class="card">
        <div class="card-head">
          <div>
            <p class="eyebrow">Agenda</p>
            <h3>Hoy</h3>
          </div>
          <button class="btn btn-quiet" type="button" data-action="modal" data-modal="appointment"><i data-lucide="calendar-plus"></i> Cita</button>
        </div>
        ${todayAppointments.length ? todayAppointments.map(appointmentRow).join("") : emptyState("No hay citas para hoy.")}
      </div>
      <div class="card">
        <div class="card-head">
          <div>
            <p class="eyebrow">Recordatorios</p>
            <h3>Seguimiento clínico</h3>
          </div>
          <button class="btn btn-quiet" type="button" data-action="modal" data-modal="followUp"><i data-lucide="bell-plus"></i> Crear</button>
        </div>
        ${renderReminderList()}
      </div>
    </section>
  `;
}

function statCard(label, value, icon) {
  return `
    <article class="card stat">
      <span><i data-lucide="${icon}"></i> ${label}</span>
      <strong>${value}</strong>
    </article>
  `;
}

function focusItem(label, value) {
  return `
    <div class="focus-item">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(value)}</span>
    </div>
  `;
}

function renderActionCenter({ todayAppointments, overdueFollowUps, dueSoonOrders, lowStock }) {
  const activeAppointments = todayAppointments
    .filter((item) => !["Completada", "Cancelada"].includes(item.status))
    .slice(0, 3);
  const alerts = [
    ...activeAppointments.map((item) => alertLine("Cita de hoy", `${formatTime(item.startsAt)} · ${item.patientName || "Paciente"}`, "calendar-clock")),
    ...overdueFollowUps.slice(0, 3).map((item) => alertLine("Seguimiento vencido", `${item.patientName || "Paciente"} · ${item.title || "Recordatorio"}`, "bell-ring", "danger")),
    ...dueSoonOrders.slice(0, 3).map((item) => alertLine("Laboratorio", `${item.patientName || "Paciente"} · entrega ${item.dueDate || "pronto"}`, "flask-conical", "warn")),
    ...(isAdmin() ? lowStock.slice(0, 3).map((item) => alertLine("Stock bajo", `${item.name || "Producto"} · ${Number(item.stock || 0)} pzas`, "triangle-alert", "danger")) : [])
  ].slice(0, 5);

  return `
    <section class="grid grid-2 home-actions">
      <div class="card">
        <div class="card-head">
          <div>
            <p class="eyebrow">Accesos rápidos</p>
            <h3>Trabajo diario</h3>
          </div>
        </div>
        <div class="quick-actions">
          ${canAccessView("appointments") ? quickAction("calendar-plus", "Nueva cita", "modal", "appointment") : ""}
          ${canAccessView("patients") ? quickAction("user-plus", "Paciente", "modal", "patient") : ""}
          ${canAccessView("exam") ? `<button class="quick-action" type="button" data-action="navigate" data-view="exam"><i data-lucide="clipboard-pen"></i><span>Consulta</span></button>` : ""}
          ${canAccessView("patients") ? quickAction("bell-plus", "Recordatorio", "modal", "followUp") : ""}
          ${isAdmin() ? `<button class="quick-action" type="button" data-action="navigate" data-view="pos"><i data-lucide="shopping-cart"></i><span>Caja</span></button>` : ""}
          <button class="quick-action" type="button" data-action="enable-notifications"><i data-lucide="bell"></i><span>Notificaciones</span></button>
        </div>
      </div>
      <div class="card">
        <div class="card-head">
          <div>
            <p class="eyebrow">Prioridad</p>
            <h3>Qué revisar ahora</h3>
          </div>
        </div>
        <div class="stack">
          ${alerts.length ? alerts.join("") : emptyState("Todo está tranquilo por ahora.")}
        </div>
      </div>
    </section>
  `;
}

function quickAction(icon, label, action, modal) {
  return `<button class="quick-action" type="button" data-action="${action}" data-modal="${modal}"><i data-lucide="${icon}"></i><span>${label}</span></button>`;
}

function alertLine(label, value, icon, tone = "") {
  return `
    <div class="alert-line ${tone}">
      <i data-lucide="${icon}"></i>
      <div>
        <strong>${escapeHtml(label)}</strong>
        <span>${escapeHtml(value)}</span>
      </div>
    </div>
  `;
}

function renderAppointments() {
  const date = state.filters.appointmentDate;
  const rows = visibleRows("appointments").filter((item) => toDateInput(new Date(item.startsAt)) === date);
  return `
    <div class="toolbar">
      <div>
        <p class="eyebrow">Agenda clínica</p>
        <h3>${formatLongDate(new Date(`${date}T12:00:00`))}</h3>
      </div>
      <div class="row-actions">
        <button class="btn btn-quiet btn-icon" type="button" data-action="agenda-shift" data-days="-1" title="Día anterior"><i data-lucide="chevron-left"></i></button>
        <button class="btn btn-quiet" type="button" data-action="agenda-today"><i data-lucide="calendar-check"></i> Hoy</button>
        <input class="input" type="date" data-filter="appointmentDate" value="${date}">
        <button class="btn btn-quiet btn-icon" type="button" data-action="agenda-shift" data-days="1" title="Día siguiente"><i data-lucide="chevron-right"></i></button>
        <button class="btn btn-primary" type="button" data-action="modal" data-modal="appointment"><i data-lucide="calendar-plus"></i> Nueva cita</button>
      </div>
    </div>
    <section class="grid">
      ${rows.length ? rows.map(appointmentRow).join("") : emptyState("No hay citas en esta fecha.")}
    </section>
  `;
}

function appointmentRow(item) {
  const patient = state.data.patients.find((entry) => entry.id === item.patientId);
  const doctor = state.data.doctors.find((entry) => entry.id === item.doctorId);
  const phone = patient?.phone || "";
  return `
    <article class="row-item">
      <div>
        <span class="${badgeClass(item.status)}">${escapeHtml(item.status || "Programada")}</span>
        <strong style="margin-top:8px;">${formatTime(item.startsAt)} · ${escapeHtml(item.patientName || patient?.name || "Paciente")}</strong>
        <span class="hint">${escapeHtml(item.type || "Consulta")} · ${escapeHtml(item.branch || "")} · ${escapeHtml(item.doctorName || doctor?.name || "Sin doctor")}</span>
        ${item.notes ? `<p class="hint" style="margin:6px 0 0;">${escapeHtml(item.notes)}</p>` : ""}
      </div>
      <div class="row-actions">
        <button class="btn btn-quiet" type="button" data-action="modal" data-modal="appointment" data-id="${item.id}"><i data-lucide="pencil"></i> Editar</button>
        <select class="select" data-action="appointment-status" data-id="${item.id}">
          ${["Programada", "Confirmada", "En consulta", "Completada", "Cancelada"].map((status) => `<option ${status === item.status ? "selected" : ""}>${status}</option>`).join("")}
        </select>
        ${phone ? `<a class="btn btn-quiet" target="_blank" rel="noopener" href="${appointmentWhatsAppUrl(item, patient)}"><i data-lucide="message-circle"></i> Avisar</a>` : ""}
        <button class="btn btn-quiet" type="button" data-action="select-patient" data-id="${item.patientId}"><i data-lucide="folder-open"></i> Expediente</button>
        <button class="btn btn-danger btn-icon" type="button" data-action="appointment-delete" data-id="${item.id}" title="Eliminar cita"><i data-lucide="trash-2"></i></button>
      </div>
    </article>
  `;
}

function renderPatients() {
  const patients = filteredPatients();
  const selected = selectedPatient(patients);
  return `
    <div class="toolbar">
      <div>
        <p class="eyebrow">Expedientes</p>
        <h3>Clientes y registro médico</h3>
      </div>
      <div class="row-actions">
        <input class="input" type="search" data-live-filter="patientSearch" placeholder="Buscar paciente o teléfono" value="${escapeAttr(state.filters.patientSearch)}">
        <button class="btn btn-primary" type="button" data-action="modal" data-modal="patient"><i data-lucide="user-plus"></i> Paciente</button>
      </div>
    </div>
    <section class="split">
      <div id="clientList" class="grid">
        ${patients.length ? patients.map(patientCard).join("") : emptyState("No encontré pacientes con ese filtro.")}
      </div>
      <aside id="clientDetail" class="detail-panel">
        ${selected ? patientDetail(selected) : emptyState("Selecciona un paciente para ver su expediente.")}
      </aside>
    </section>
  `;
}

function patientCard(patient) {
  const lastExam = latestExam(patient.id);
  return `
    <article class="row-item ${state.selectedPatientId === patient.id ? "active" : ""}">
      <div>
        <span class="badge gray">${escapeHtml(patient.branch || "")}</span>
        <strong style="margin-top:8px;">${escapeHtml(patient.name || "Paciente")}</strong>
        <span class="hint">${escapeHtml(patient.phone || "Sin teléfono")} · ${escapeHtml(patient.email || "Sin correo")}</span>
        <p class="hint" style="margin:6px 0 0;">${lastExam ? `Última consulta: ${formatDate(lastExam.createdAt)}` : "Sin consulta registrada"}</p>
      </div>
      <div class="row-actions">
        <button class="btn btn-quiet" type="button" data-action="select-patient" data-id="${patient.id}"><i data-lucide="eye"></i> Ver</button>
        <button class="btn btn-quiet" type="button" data-action="modal" data-modal="appointment" data-id="${patient.id}"><i data-lucide="calendar-plus"></i> Cita</button>
        <button class="btn btn-primary" type="button" data-action="start-exam" data-id="${patient.id}"><i data-lucide="clipboard-pen"></i> Consulta</button>
        <button class="btn btn-quiet" type="button" data-action="modal" data-modal="patient" data-id="${patient.id}"><i data-lucide="pencil"></i> Editar</button>
      </div>
    </article>
  `;
}

function patientDetail(patient) {
  const allExams = state.data.exams.filter((exam) => exam.patientId === patient.id);
  const exams = allExams.slice(0, 4);
  const appointments = state.data.appointments.filter((item) => item.patientId === patient.id);
  const activeOrders = state.data.orders.filter((item) => item.patientId === patient.id && !["Entregada", "Cancelada"].includes(item.status));
  const sales = state.data.sales.filter((item) => item.patientId === patient.id);
  const nextAppt = nextAppointment(patient.id);
  const lastSale = latestSale(patient.id);
  const annualReview = nextAnnualReview(patient.id);
  const medical = patient.medical || {};
  const lens = patient.lensUse || {};
  const timeline = patientTimeline(patient.id);
  return `
    <div class="card-head">
      <div>
        <p class="eyebrow">Expediente</p>
        <h3>${escapeHtml(patient.name || "Paciente")}</h3>
      </div>
      <button class="btn btn-quiet btn-icon" type="button" data-action="modal" data-modal="patient" data-id="${patient.id}" title="Editar"><i data-lucide="pencil"></i></button>
    </div>
    <div class="contact-strip">
      ${patient.phone ? `<a class="btn btn-quiet" href="tel:${phoneDigits(patient.phone)}"><i data-lucide="phone"></i> Llamar</a>` : ""}
      ${patient.phone ? `<a class="btn btn-quiet" target="_blank" rel="noopener" href="https://wa.me/${whatsAppNumber(patient.phone)}"><i data-lucide="message-circle"></i> WhatsApp</a>` : ""}
      ${patient.email ? `<a class="btn btn-quiet" href="mailto:${escapeAttr(patient.email)}"><i data-lucide="mail"></i> Correo</a>` : ""}
    </div>
    <div class="metric-strip">
      ${miniMetric("Consultas", allExams.length, "clipboard-pen")}
      ${miniMetric("Citas", appointments.length, "calendar-days")}
      ${miniMetric("Laboratorio", activeOrders.length, "flask-conical")}
      ${miniMetric("Compras", sales.length, "receipt")}
    </div>
    <div class="detail-list">
      <div><span>Teléfono</span><strong>${escapeHtml(patient.phone || "-")}</strong></div>
      <div><span>Correo</span><strong>${escapeHtml(patient.email || "-")}</strong></div>
      <div><span>Nacimiento</span><strong>${escapeHtml(patient.birthDate || "-")}</strong></div>
      <div><span>Edad</span><strong>${escapeHtml(patientAge(patient.birthDate) || "-")}</strong></div>
      <div><span>Próxima cita</span><strong>${nextAppt ? `${formatDate(nextAppt.startsAt)} · ${formatTime(nextAppt.startsAt)}` : "-"}</strong></div>
      <div><span>Revisión anual</span><strong>${annualReview ? `${escapeHtml(annualReview.dueDate || "")} · ${escapeHtml(annualReview.title || "Seguimiento")}` : "-"}</strong></div>
      <div><span>Última compra</span><strong>${lastSale ? `${formatDate(lastSale.createdAt)} · ${currency(lastSale.total || 0)}` : "-"}</strong></div>
      <div><span>Ocupación</span><strong>${escapeHtml(patient.occupation || "-")}</strong></div>
      <div><span>Diabetes</span><strong>${yesNo(medical.diabetes)}</strong></div>
      <div><span>Hipertensión</span><strong>${yesNo(medical.hypertension)}</strong></div>
      <div><span>Alergias</span><strong>${escapeHtml(medical.allergies || "-")}</strong></div>
      <div><span>Medicamentos</span><strong>${escapeHtml(medical.medications || "-")}</strong></div>
      <div><span>Pantalla</span><strong>${escapeHtml(medical.screenHours || "-")}</strong></div>
      <div><span>Uso principal</span><strong>${escapeHtml(lens.useCase || "-")}</strong></div>
      <div><span>Tipo de lente</span><strong>${escapeHtml(lens.type || "-")}</strong></div>
      <div><span>Material</span><strong>${escapeHtml(lens.material || "-")}</strong></div>
    </div>
    <div class="row-actions" style="margin-top:14px;">
      <button class="btn btn-primary" type="button" data-action="start-exam" data-id="${patient.id}"><i data-lucide="clipboard-pen"></i> Nueva consulta</button>
      <button class="btn btn-quiet" type="button" data-action="modal" data-modal="appointment" data-id="${patient.id}"><i data-lucide="calendar-plus"></i> Cita</button>
      <button class="btn btn-quiet" type="button" data-action="modal" data-modal="followUp"><i data-lucide="bell-plus"></i> Recordatorio</button>
    </div>
    <hr style="border:0;border-top:1px solid var(--line);margin:16px 0;">
    <p class="eyebrow">Historial</p>
    ${exams.length ? exams.map((exam) => `
      <div class="mini-row">
        <strong>${formatDate(exam.createdAt)} · ${escapeHtml(exam.lensRecommendation || "Receta")}</strong>
        <span class="hint">OD ${escapeHtml(exam.odEsf || "-")} / ${escapeHtml(exam.odCil || "-")} · OI ${escapeHtml(exam.oiEsf || "-")} / ${escapeHtml(exam.oiCil || "-")}</span>
      </div>
    `).join("") : emptyState("Aún no hay consultas.")}
    <hr style="border:0;border-top:1px solid var(--line);margin:16px 0;">
    <p class="eyebrow">Línea de tiempo</p>
    ${timeline.length ? timeline.map(timelineRow).join("") : emptyState("Sin movimientos todavía.")}
  `;
}

function miniMetric(label, value, icon) {
  return `
    <div class="mini-metric">
      <i data-lucide="${icon}"></i>
      <strong>${escapeHtml(value)}</strong>
      <span>${escapeHtml(label)}</span>
    </div>
  `;
}

function patientTimeline(patientId) {
  const rows = [
    ...state.data.exams.filter((item) => item.patientId === patientId).map((item) => ({
      type: "Consulta",
      icon: "clipboard-pen",
      title: item.lensRecommendation || "Receta guardada",
      detail: `OD ${item.odEsf || "-"} / OI ${item.oiEsf || "-"}`,
      date: dateValue(item.createdAt)
    })),
    ...state.data.appointments.filter((item) => item.patientId === patientId).map((item) => ({
      type: "Cita",
      icon: "calendar-days",
      title: `${item.status || "Programada"} · ${item.type || "Consulta"}`,
      detail: item.doctorName || item.branch || "",
      date: new Date(item.startsAt)
    })),
    ...state.data.orders.filter((item) => item.patientId === patientId).map((item) => ({
      type: "Laboratorio",
      icon: "flask-conical",
      title: `${item.status || "Pendiente"} · ${item.lensType || "Lentes"}`,
      detail: [item.dueDate ? `Entrega ${item.dueDate}` : "", orderBalance(item) > 0 ? `Saldo ${currency(orderBalance(item))}` : ""].filter(Boolean).join(" · "),
      date: dateValue(item.createdAt)
    })),
    ...state.data.sales.filter((item) => item.patientId === patientId).map((item) => ({
      type: "Venta",
      icon: "receipt",
      title: currency(item.total || 0),
      detail: item.paymentMethod || "",
      date: dateValue(item.createdAt)
    }))
  ];
  return rows
    .filter((item) => !Number.isNaN(item.date.getTime()))
    .sort((a, b) => b.date - a.date)
    .slice(0, 8);
}

function timelineRow(item) {
  return `
    <div class="timeline-row">
      <span class="timeline-icon"><i data-lucide="${item.icon}"></i></span>
      <div>
        <strong>${escapeHtml(item.type)} · ${escapeHtml(item.title)}</strong>
        <span class="hint">${formatDate(item.date)}${item.detail ? ` · ${escapeHtml(item.detail)}` : ""}</span>
      </div>
    </div>
  `;
}

function renderExam() {
  const patients = visibleRows("patients");
  const selectedId = state.selectedExamPatientId || state.selectedPatientId || patients[0]?.id || "";
  const selected = patients.find((patient) => patient.id === selectedId);
  const history = selected ? state.data.exams.filter((exam) => exam.patientId === selected.id).slice(0, 5) : [];
  return `
    <div class="toolbar">
      <div>
        <p class="eyebrow">Consulta optométrica</p>
        <h3>Receta y recomendación de lentes</h3>
      </div>
      <select class="select" data-action="exam-patient">
        ${patients.map((patient) => `<option value="${patient.id}" ${patient.id === selectedId ? "selected" : ""}>${escapeHtml(patient.name || "Paciente")}</option>`).join("")}
      </select>
    </div>
    ${selected ? `
      <section class="grid grid-2">
        <form class="card stack" data-form="exam">
          <input type="hidden" name="patientId" value="${selected.id}">
          <div class="card-head">
            <div>
              <p class="eyebrow">Paciente</p>
              <h3>${escapeHtml(selected.name || "Paciente")}</h3>
            </div>
            <span class="badge gray">${escapeHtml(selected.branch || "")}</span>
          </div>
          <div class="rx-grid">
            <div></div>
            <label class="field"><span>Esfera</span></label>
            <label class="field"><span>Cilindro</span></label>
            <label class="field"><span>Eje</span></label>
            <label class="field"><span>Add</span></label>
            <div class="rx-label">OD</div>
            <input class="input" name="odEsf" placeholder="-0.25">
            <input class="input" name="odCil" placeholder="-0.50">
            <input class="input" name="odEje" placeholder="180">
            <input class="input" name="odAdd" placeholder="+1.50">
            <div class="rx-label">OI</div>
            <input class="input" name="oiEsf" placeholder="-0.25">
            <input class="input" name="oiCil" placeholder="-0.50">
            <input class="input" name="oiEje" placeholder="180">
            <input class="input" name="oiAdd" placeholder="+1.50">
          </div>
          <div class="form-grid">
            <label class="field"><span>Agudeza visual</span><input class="input" name="visualAcuity" placeholder="20/20"></label>
            <label class="field"><span>Distancia pupilar</span><input class="input" name="pd" placeholder="62 mm"></label>
            <label class="field full"><span>Diagnóstico</span><textarea class="textarea" name="diagnosis" placeholder="Miopía, astigmatismo, presbicia..."></textarea></label>
            <label class="field"><span>Tipo de lente</span>${lensTypeSelect("lensRecommendation")}</label>
            <label class="field"><span>Material</span>${materialSelect("material")}</label>
            <label class="field"><span>Entrega laboratorio</span><input class="input" type="date" name="orderDueDate" value="${toDateInput(addDays(new Date(), 5))}"></label>
            <label class="check-row"><input type="checkbox" name="createOrder" checked><span>Crear orden de laboratorio</span></label>
            <label class="check-row full"><input type="checkbox" name="createAnnualReview" checked><span>Recordar revisión y renovación de lentes en 1 año</span></label>
            <label class="field full"><span>Notas para laboratorio</span><textarea class="textarea" name="labNotes" placeholder="Tratamientos, alturas, armazón, observaciones..."></textarea></label>
          </div>
          <button class="btn btn-primary" type="submit"><i data-lucide="save"></i> Guardar consulta</button>
        </form>
        <aside class="card">
          <div class="card-head">
            <div>
              <p class="eyebrow">Historial</p>
              <h3>Últimas consultas</h3>
            </div>
          </div>
          ${history.length ? history.map((exam) => `
            <div class="mini-row">
              <strong>${formatDate(exam.createdAt)} · ${escapeHtml(exam.lensRecommendation || "Receta")}</strong>
              <span class="hint">OD ${escapeHtml(exam.odEsf || "-")} ${escapeHtml(exam.odCil || "")} · OI ${escapeHtml(exam.oiEsf || "-")} ${escapeHtml(exam.oiCil || "")}</span>
              ${exam.diagnosis ? `<p class="hint">${escapeHtml(exam.diagnosis)}</p>` : ""}
            </div>
          `).join("") : emptyState("Sin consultas registradas.")}
        </aside>
      </section>
    ` : emptyState("Registra un paciente para iniciar una consulta.")}
  `;
}

function renderLab() {
  const orders = visibleRows("orders");
  const activeOrders = orders.filter((order) => !["Entregada", "Cancelada"].includes(order.status));
  const overdueOrders = activeOrders.filter((order) => order.dueDate && new Date(`${order.dueDate}T23:59:59`) < new Date());
  const pendingBalance = activeOrders.reduce((sum, order) => sum + orderBalance(order), 0);
  return `
    <div class="toolbar">
      <div>
        <p class="eyebrow">Laboratorio</p>
        <h3>Órdenes de lentes</h3>
      </div>
      <div class="row-actions">
        <button class="btn btn-quiet" type="button" data-action="export-lab-csv"><i data-lucide="file-spreadsheet"></i> CSV</button>
        <button class="btn btn-primary" type="button" data-action="modal" data-modal="order"><i data-lucide="file-plus"></i> Nueva orden</button>
      </div>
    </div>
    <section class="grid grid-4" style="margin-bottom:16px;">
      ${statCard("Órdenes activas", activeOrders.length, "flask-conical")}
      ${statCard("Entregas vencidas", overdueOrders.length, "triangle-alert")}
      ${statCard("Saldo pendiente", currency(pendingBalance), "wallet-cards")}
    </section>
    <section class="grid">
      ${orders.length ? orders.map((order) => `
        <article class="row-item">
          <div>
            <span class="${badgeClass(order.status)}">${escapeHtml(order.status || "Pendiente")}</span>
            <span class="${orderBalance(order) > 0 ? "badge amber" : "badge green"}" style="margin-left:6px;">${orderBalance(order) > 0 ? `Saldo ${currency(orderBalance(order))}` : "Pagado"}</span>
            <strong style="margin-top:8px;">${escapeHtml(order.patientName || "Paciente")} · ${escapeHtml(order.lensType || "Lentes")}</strong>
            <span class="hint">${escapeHtml(order.branch || "")} · Entrega: ${escapeHtml(order.dueDate || "Sin fecha")} · Total ${currency(order.total || 0)} · Anticipo ${currency(order.deposit || 0)}</span>
            ${order.frameModel || order.labName ? `<p class="hint" style="margin:6px 0 0;">${escapeHtml([order.frameModel, order.labName].filter(Boolean).join(" · "))}</p>` : ""}
            ${order.notes ? `<p class="hint" style="margin:6px 0 0;">${escapeHtml(order.notes)}</p>` : ""}
          </div>
          <div class="row-actions">
            <button class="btn btn-quiet" type="button" data-action="modal" data-modal="order" data-id="${order.id}"><i data-lucide="pencil"></i> Editar</button>
            ${orderBalance(order) > 0 ? `<button class="btn btn-quiet" type="button" data-action="order-payoff" data-id="${order.id}"><i data-lucide="badge-check"></i> Liquidar</button>` : ""}
            <select class="select" data-action="order-status" data-id="${order.id}">
              ${["Pendiente", "En laboratorio", "Lista", "Entregada", "Cancelada"].map((status) => `<option ${status === order.status ? "selected" : ""}>${status}</option>`).join("")}
            </select>
            <button class="btn btn-danger btn-icon" type="button" data-action="order-delete" data-id="${order.id}" title="Eliminar orden"><i data-lucide="trash-2"></i></button>
          </div>
        </article>
      `).join("") : emptyState("No hay órdenes de laboratorio.")}
    </section>
  `;
}

function renderInventory() {
  const rows = visibleRows("inventory").filter((item) => {
    const term = normalize(state.filters.stockSearch);
    return !term || normalize(`${item.name} ${item.category}`).includes(term);
  });
  return `
    <div class="toolbar">
      <div>
        <p class="eyebrow">Administración</p>
        <h3>Inventario</h3>
      </div>
      <div class="row-actions">
        <input class="input" type="search" data-live-filter="stockSearch" placeholder="Buscar producto" value="${escapeAttr(state.filters.stockSearch)}">
        <button class="btn btn-primary" type="button" data-action="modal" data-modal="inventory"><i data-lucide="plus"></i> Producto</button>
      </div>
    </div>
    <section class="grid grid-3">
      ${rows.length ? rows.map((item) => `
        <article class="card">
          <div class="card-head">
            <div>
              <p class="eyebrow">${escapeHtml(item.category || "Producto")}</p>
              <h3>${escapeHtml(item.name || "Producto")}</h3>
            </div>
            <span class="${Number(item.stock || 0) <= Number(item.minStock || 2) ? "badge red" : "badge green"}">${Number(item.stock || 0)} pzas</span>
          </div>
          <p class="hint">${escapeHtml(item.branch || "")} · Mínimo ${Number(item.minStock || 0)}</p>
          <strong style="font-size:24px;">${currency(item.price || 0)}</strong>
          <div class="row-actions compact-actions" style="margin-top:12px;">
            <button class="btn btn-quiet btn-icon" type="button" data-action="stock-adjust" data-id="${item.id}" data-delta="-1" title="Restar stock"><i data-lucide="minus"></i></button>
            <span class="badge gray">${Number(item.stock || 0)} en stock</span>
            <button class="btn btn-quiet btn-icon" type="button" data-action="stock-adjust" data-id="${item.id}" data-delta="1" title="Sumar stock"><i data-lucide="plus"></i></button>
          </div>
          <div class="row-actions" style="margin-top:14px;">
            <button class="btn btn-quiet" type="button" data-action="modal" data-modal="inventory" data-id="${item.id}"><i data-lucide="pencil"></i> Editar</button>
            <button class="btn btn-primary" type="button" data-action="cart-add" data-id="${item.id}"><i data-lucide="shopping-cart"></i> Vender</button>
          </div>
        </article>
      `).join("") : emptyState("No hay productos en esta vista.")}
    </section>
  `;
}

function renderPurchases() {
  const purchases = visibleRows("purchases");
  const lowStock = visibleRows("inventory").filter((item) => Number(item.stock || 0) <= Number(item.minStock || 2));
  return `
    <div class="toolbar">
      <div>
        <p class="eyebrow">Administración</p>
        <h3>Compras y reabasto</h3>
      </div>
      <button class="btn btn-primary" type="button" data-action="modal" data-modal="purchase"><i data-lucide="truck"></i> Registrar compra</button>
    </div>
    <section class="grid grid-2">
      <div class="card">
        <div class="card-head">
          <div>
            <p class="eyebrow">Sugerencias</p>
            <h3>Stock bajo</h3>
          </div>
        </div>
        ${lowStock.length ? lowStock.map((item) => `
          <div class="mini-row">
            <strong>${escapeHtml(item.name || "Producto")}</strong>
            <span class="hint">${escapeHtml(item.branch || "")} · Stock ${Number(item.stock || 0)} · mínimo ${Number(item.minStock || 0)}</span>
          </div>
        `).join("") : emptyState("Sin alertas de compra.")}
      </div>
      <div class="card">
        <div class="card-head">
          <div>
            <p class="eyebrow">Historial</p>
            <h3>Últimas compras</h3>
          </div>
        </div>
        ${purchases.length ? purchases.map((item) => `
          <div class="mini-row">
            <strong>${escapeHtml(item.supplier || "Proveedor")} · ${currency(item.total || 0)}</strong>
            <span class="hint">${formatDate(item.createdAt)} · ${escapeHtml(item.branch || "")}</span>
          </div>
        `).join("") : emptyState("Aún no hay compras registradas.")}
      </div>
    </section>
  `;
}

function renderPOS() {
  const products = visibleRows("inventory").filter((item) => item.active !== false && Number(item.stock || 0) > 0);
  const patients = visibleRows("patients");
  const total = state.cart.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.qty || 1), 0);
  return `
    <div class="toolbar">
      <div>
        <p class="eyebrow">Caja</p>
        <h3>Punto de venta</h3>
      </div>
      <span class="chip">Total ${currency(total)}</span>
    </div>
    <section class="split">
      <div class="grid grid-3">
        ${products.length ? products.map((item) => `
          <button class="card" style="text-align:left;" type="button" data-action="cart-add" data-id="${item.id}">
            <p class="eyebrow">${escapeHtml(item.category || "Producto")}</p>
            <h3>${escapeHtml(item.name || "Producto")}</h3>
            <p class="hint">${escapeHtml(item.branch || "")} · ${Number(item.stock || 0)} disponibles</p>
            <strong>${currency(item.price || 0)}</strong>
          </button>
        `).join("") : emptyState("No hay productos disponibles.")}
      </div>
      <aside class="detail-panel">
        <div class="card-head">
          <div>
            <p class="eyebrow">Venta</p>
            <h3>Carrito</h3>
          </div>
          <button class="btn btn-quiet btn-icon" type="button" data-action="cart-clear" title="Vaciar"><i data-lucide="trash-2"></i></button>
        </div>
        <div class="stack">
          ${state.cart.length ? state.cart.map((item) => `
            <div class="cart-line">
              <div>
                <strong>${escapeHtml(item.name)}</strong>
                <span class="hint">${currency(item.price || 0)} c/u</span>
              </div>
              <div class="row-actions compact-actions">
                <button class="btn btn-quiet btn-icon" type="button" data-action="cart-qty" data-id="${item.id}" data-delta="-1" title="Restar"><i data-lucide="minus"></i></button>
                <span class="badge gray">x${Number(item.qty || 1)}</span>
                <button class="btn btn-quiet btn-icon" type="button" data-action="cart-qty" data-id="${item.id}" data-delta="1" title="Sumar"><i data-lucide="plus"></i></button>
                <button class="btn btn-danger btn-icon" type="button" data-action="cart-remove" data-id="${item.id}" title="Quitar"><i data-lucide="x"></i></button>
              </div>
              <span>${currency(Number(item.price || 0) * Number(item.qty || 1))}</span>
            </div>
          `).join("") : emptyState("Agrega productos para cobrar.")}
          <label class="field"><span>Paciente opcional</span><select class="select" id="posPatient">${patientOptions(patients, "")}</select></label>
          <label class="field"><span>Método de pago</span><select class="select" id="posPayment"><option>Efectivo</option><option>Tarjeta</option><option>Transferencia</option><option>Mixto</option></select></label>
          <div class="row-item"><strong>Total</strong><strong>${currency(total)}</strong></div>
          <button class="btn btn-primary" type="button" data-action="checkout" ${state.cart.length ? "" : "disabled"}><i data-lucide="check-circle"></i> Finalizar venta</button>
        </div>
      </aside>
    </section>
  `;
}

function renderReports() {
  const sales = visibleRows("sales");
  const appointments = visibleRows("appointments");
  const patients = visibleRows("patients");
  const labBalance = visibleRows("orders")
    .filter((order) => !["Entregada", "Cancelada"].includes(order.status))
    .reduce((sum, order) => sum + orderBalance(order), 0);
  const range = Number(state.filters.reportRange || 30);
  const filteredSales = sales.filter((sale) => daysBetween(new Date(), dateValue(sale.createdAt)) <= range);
  const total = filteredSales.reduce((sum, sale) => sum + Number(sale.total || 0), 0);
  const recentSales = filteredSales
    .slice()
    .sort((a, b) => dateValue(b.createdAt) - dateValue(a.createdAt))
    .slice(0, 8);
  const byBranch = BRANCHES.map((branch) => ({
    branch,
    total: sales.filter((sale) => sale.branch === branch).reduce((sum, sale) => sum + Number(sale.total || 0), 0)
  }));
  const max = Math.max(1, ...byBranch.map((row) => row.total));
  return `
    <div class="toolbar">
      <div>
        <p class="eyebrow">Administración</p>
        <h3>Reportes</h3>
      </div>
      <select class="select" data-filter="reportRange">
        ${[7, 30, 90, 365].map((days) => `<option value="${days}" ${range === days ? "selected" : ""}>Últimos ${days} días</option>`).join("")}
      </select>
    </div>
    <section class="grid grid-4">
      ${statCard("Ventas", currency(total), "banknote")}
      ${statCard("Tickets", filteredSales.length, "receipt")}
      ${statCard("Saldos lab", currency(labBalance), "wallet-cards")}
      ${statCard("Citas", appointments.length, "calendar-days")}
    </section>
    <section class="card" style="margin-top:16px;">
      <div class="card-head">
        <div>
          <p class="eyebrow">Sucursales</p>
          <h3>Ventas acumuladas</h3>
        </div>
      </div>
      <div class="stack">
        ${byBranch.map((row) => `
          <div>
            <div class="row-item" style="box-shadow:none;margin-bottom:8px;"><strong>${row.branch}</strong><span>${currency(row.total)}</span></div>
            <div class="progress"><span style="width:${Math.max(4, Math.round((row.total / max) * 100))}%"></span></div>
          </div>
        `).join("")}
      </div>
    </section>
    <section class="card" style="margin-top:16px;">
      <div class="card-head">
        <div>
          <p class="eyebrow">Caja</p>
          <h3>Ventas recientes</h3>
        </div>
        <button class="btn btn-quiet" type="button" data-action="export-sales-csv"><i data-lucide="file-spreadsheet"></i> CSV</button>
      </div>
      <div class="stack">
        ${recentSales.length ? recentSales.map(saleRow).join("") : emptyState("Sin ventas en este rango.")}
      </div>
    </section>
  `;
}

function saleRow(sale) {
  const itemCount = Array.isArray(sale.items) ? sale.items.reduce((sum, item) => sum + Number(item.qty || 1), 0) : 0;
  return `
    <div class="row-item">
      <div>
        <span class="badge gray">${escapeHtml(sale.branch || "")}</span>
        <strong style="margin-top:8px;">${currency(sale.total || 0)} · ${escapeHtml(sale.paymentMethod || "Pago")}</strong>
        <span class="hint">${formatDate(sale.createdAt)} · ${escapeHtml(sale.patientName || "Venta mostrador")} · ${itemCount} piezas</span>
      </div>
      <div class="row-actions">
        <button class="btn btn-quiet" type="button" data-action="receipt-print" data-id="${sale.id}"><i data-lucide="printer"></i> Recibo</button>
      </div>
    </div>
  `;
}

function renderAdmin() {
  const users = state.data.users || [];
  const doctors = visibleRows("doctors");
  return `
    <div class="toolbar">
      <div>
        <p class="eyebrow">Sistema</p>
        <h3>Usuarios, doctores y accesos</h3>
      </div>
      <div class="row-actions">
        <button class="btn btn-primary" type="button" data-action="modal" data-modal="user"><i data-lucide="user-plus"></i> Usuario</button>
        <button class="btn btn-quiet" type="button" data-action="modal" data-modal="doctor"><i data-lucide="stethoscope"></i> Doctor</button>
      </div>
    </div>
    <section class="grid grid-3" style="margin-bottom:16px;">
      <article class="card">
        <p class="eyebrow">Respaldo</p>
        <h3>Base completa</h3>
        <p class="hint">Descarga un JSON con los datos visibles para el administrador.</p>
        <button class="btn btn-primary" type="button" data-action="export-backup"><i data-lucide="download"></i> Descargar respaldo</button>
      </article>
      <article class="card">
        <p class="eyebrow">Excel / Sheets</p>
        <h3>Pacientes</h3>
        <p class="hint">Exporta expedientes básicos y preferencias de lentes en CSV.</p>
        <button class="btn btn-quiet" type="button" data-action="export-patients-csv"><i data-lucide="file-spreadsheet"></i> Exportar pacientes</button>
      </article>
      <article class="card">
        <p class="eyebrow">Caja</p>
        <h3>Ventas</h3>
        <p class="hint">Exporta tickets, sucursal, método de pago y total.</p>
        <button class="btn btn-quiet" type="button" data-action="export-sales-csv"><i data-lucide="receipt-text"></i> Exportar ventas</button>
      </article>
      <article class="card">
        <p class="eyebrow">Laboratorio</p>
        <h3>Órdenes</h3>
        <p class="hint">Exporta paciente, entrega, saldo, estado y notas de laboratorio.</p>
        <button class="btn btn-quiet" type="button" data-action="export-lab-csv"><i data-lucide="flask-conical"></i> Exportar laboratorio</button>
      </article>
    </section>
    ${renderDataHealth()}
    <section class="grid grid-2">
      <div class="table-card">
        <div class="card" style="box-shadow:none;border:0;border-bottom:1px solid var(--line);">
          <p class="eyebrow">Accesos</p>
          <h3>Usuarios</h3>
          <p class="hint">Aquí editas datos internos, rol, sucursal, permisos y estado. El correo de acceso y la contraseña viven en Firebase Authentication.</p>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Usuario</th><th>Contacto</th><th>Rol</th><th>Sucursal</th><th>Estado</th><th></th></tr></thead>
            <tbody>
              ${users.map((user) => `
                <tr>
                  <td data-label="Usuario"><strong>${escapeHtml(user.displayName || user.email || "")}</strong><br><span class="hint">${escapeHtml(user.email || "")} · ${escapeHtml(user.username || "")}</span></td>
                  <td data-label="Contacto">${escapeHtml(user.phone || "-")}<br><span class="hint">${escapeHtml(user.jobTitle || user.employeeCode || "")}</span></td>
                  <td data-label="Rol">${escapeHtml(user.role || "")}</td>
                  <td data-label="Sucursal">${escapeHtml(user.branch || "")}</td>
                  <td data-label="Estado"><span class="${user.active ? "badge green" : "badge red"}">${user.active ? "Activo" : "Inactivo"}</span></td>
                  <td data-label="Acciones" class="row-actions">
                    <button class="btn btn-quiet btn-icon" type="button" data-action="modal" data-modal="user" data-id="${user.id}" title="Editar"><i data-lucide="pencil"></i></button>
                    <button class="btn btn-quiet btn-icon" type="button" data-action="password-reset" data-email="${escapeAttr(user.email || "")}" title="Reset contraseña"><i data-lucide="key-round"></i></button>
                    <button class="btn btn-quiet btn-icon" type="button" data-action="user-toggle" data-id="${user.id}" data-active="${user.active ? "false" : "true"}" title="${user.active ? "Desactivar" : "Reactivar"}"><i data-lucide="${user.active ? "user-x" : "user-check"}"></i></button>
                    <button class="btn btn-danger btn-icon" type="button" data-action="user-delete" data-id="${user.id}" title="Eliminar acceso"><i data-lucide="trash-2"></i></button>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
      <div class="table-card">
        <div class="card" style="box-shadow:none;border:0;border-bottom:1px solid var(--line);">
          <p class="eyebrow">Equipo clínico</p>
          <h3>Doctores por óptica</h3>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Doctor</th><th>Sucursal</th><th>Especialidad</th><th>Estado</th><th></th></tr></thead>
            <tbody>
              ${doctors.map((doctor) => `
                <tr>
                  <td data-label="Doctor"><strong>${escapeHtml(doctor.name || "")}</strong><br><span class="hint">${escapeHtml(doctor.phone || "")}</span></td>
                  <td data-label="Sucursal">${escapeHtml(doctor.branch || "")}</td>
                  <td data-label="Especialidad">${escapeHtml(doctor.specialty || "Optometría")}</td>
                  <td data-label="Estado"><span class="${doctor.active !== false ? "badge green" : "badge red"}">${doctor.active !== false ? "Activo" : "Inactivo"}</span></td>
                  <td data-label="Acciones"><button class="btn btn-quiet btn-icon" type="button" data-action="modal" data-modal="doctor" data-id="${doctor.id}" title="Editar"><i data-lucide="pencil"></i></button></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `;
}

function renderDataHealth() {
  const patients = visibleRows("patients");
  const duplicateGroups = patientDuplicateGroups(patients);
  const missingPhones = patients.filter((patient) => phoneDigits(patient.phone).length < 8);
  const overdueOrders = visibleRows("orders").filter((order) => !["Entregada", "Cancelada"].includes(order.status) && order.dueDate && new Date(`${order.dueDate}T23:59:59`) < new Date());
  const pendingBalance = visibleRows("orders")
    .filter((order) => !["Entregada", "Cancelada"].includes(order.status))
    .reduce((sum, order) => sum + orderBalance(order), 0);
  const inactiveUsers = (state.data.users || []).filter((user) => user.active === false);

  return `
    <section class="card data-health">
      <div class="card-head">
        <div>
          <p class="eyebrow">Auditoría rápida</p>
          <h3>Salud de datos</h3>
        </div>
        <span class="${duplicateGroups.length || missingPhones.length || overdueOrders.length ? "badge amber" : "badge green"}">${duplicateGroups.length || missingPhones.length || overdueOrders.length ? "Revisar" : "Todo bien"}</span>
      </div>
      <div class="grid grid-4">
        ${healthCard("Duplicados", duplicateGroups.length, "copy-check", duplicateGroups.length ? duplicateGroups.slice(0, 3).map((group) => group.map((patient) => patient.name || "Paciente").join(" / ")).join(" · ") : "Sin coincidencias fuertes")}
        ${healthCard("Teléfonos", missingPhones.length, "phone-off", missingPhones.length ? missingPhones.slice(0, 3).map((patient) => patient.name || "Paciente").join(" · ") : "Expedientes completos")}
        ${healthCard("Entregas", overdueOrders.length, "calendar-x", overdueOrders.length ? overdueOrders.slice(0, 3).map((order) => order.patientName || "Paciente").join(" · ") : "Sin entregas vencidas")}
        ${healthCard("Saldos", currency(pendingBalance), "wallet-cards", inactiveUsers.length ? `${inactiveUsers.length} usuarios inactivos` : "Usuarios activos revisados")}
      </div>
    </section>
  `;
}

function healthCard(label, value, icon, detail) {
  return `
    <article class="health-card">
      <div>
        <i data-lucide="${icon}"></i>
        <span>${escapeHtml(label)}</span>
      </div>
      <strong>${escapeHtml(value)}</strong>
      <p>${escapeHtml(detail)}</p>
    </article>
  `;
}

function renderReminderList() {
  const now = new Date();
  const appointments = visibleRows("appointments")
    .filter((item) => {
      const start = new Date(item.startsAt);
      return start >= now && start - now <= 1000 * 60 * 60 * 24 && !["Completada", "Cancelada"].includes(item.status);
    })
    .slice(0, 5);
  const followUps = visibleRows("followUps")
    .filter((item) => new Date(`${item.dueDate}T23:59:00`) >= now && item.done !== true)
    .slice(0, 5);

  const rows = appointments.map((item) => `
    <div class="mini-row">
      <strong>${formatTime(item.startsAt)} · ${escapeHtml(item.patientName || "Paciente")}</strong>
      <span class="hint">Cita ${escapeHtml(item.type || "consulta")} en ${escapeHtml(item.branch || "")}</span>
    </div>
  `).concat(followUps.map((item) => `
    <div class="mini-row">
      ${item.type === "annualReview" ? `<span class="badge green">Revisión anual</span>` : ""}
      <strong>${escapeHtml(item.title || "Seguimiento")} · ${escapeHtml(item.dueDate || "")}</strong>
      <span class="hint">${escapeHtml(item.patientName || "")}</span>
      ${item.notes ? `<p class="hint">${escapeHtml(item.notes)}</p>` : ""}
      <div class="row-actions compact-actions" style="margin-top:8px;">
        <button class="btn btn-quiet" type="button" data-action="followup-done" data-id="${item.id}"><i data-lucide="check"></i> Hecho</button>
        <button class="btn btn-danger btn-icon" type="button" data-action="followup-delete" data-id="${item.id}" title="Eliminar"><i data-lucide="trash-2"></i></button>
      </div>
    </div>
  `));

  return rows.length ? rows.join("") : emptyState("Sin recordatorios próximos.");
}

function renderModal(type, id = "") {
  const content = {
    patient: modalPatient,
    appointment: modalAppointment,
    followUp: modalFollowUp,
    order: modalOrder,
    inventory: modalInventory,
    purchase: modalPurchase,
    user: modalUser,
    doctor: modalDoctor,
    profile: modalProfile
  }[type];

  if (!content) return;
  modalRoot.innerHTML = content(id);
  modalRoot.classList.add("open");
  modalRoot.setAttribute("aria-hidden", "false");
  renderIcons();
}

function closeModal() {
  modalRoot.classList.remove("open");
  modalRoot.setAttribute("aria-hidden", "true");
  modalRoot.innerHTML = "";
}

function modalShell(title, subtitle, body) {
  return `
    <section class="modal-card" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
      <div class="modal-head">
        <div>
          <p class="eyebrow">${escapeHtml(subtitle)}</p>
          <h3>${escapeHtml(title)}</h3>
        </div>
        <button class="btn btn-quiet btn-icon" type="button" data-action="close-modal" title="Cerrar"><i data-lucide="x"></i></button>
      </div>
      ${body}
    </section>
  `;
}

function modalPatient(id) {
  const patient = state.data.patients.find((entry) => entry.id === id) || {};
  const medical = patient.medical || {};
  const lens = patient.lensUse || {};
  return modalShell(patient.id ? "Editar paciente" : "Nuevo paciente", "Expediente clínico", `
    <form class="stack" data-form="patient">
      <input type="hidden" name="id" value="${escapeAttr(patient.id || "")}">
      <div class="form-grid">
        <label class="field"><span>Nombre completo</span><input class="input" name="name" required value="${escapeAttr(patient.name || "")}"></label>
        <label class="field"><span>Teléfono</span><input class="input" name="phone" required value="${escapeAttr(patient.phone || "")}"></label>
        <label class="field"><span>Correo</span><input class="input" type="email" name="email" value="${escapeAttr(patient.email || "")}"></label>
        <label class="field"><span>Sucursal</span>${branchSelect("branch", patient.branch || currentWriteBranch())}</label>
        <label class="field"><span>Fecha de nacimiento</span><input class="input" type="date" name="birthDate" value="${escapeAttr(patient.birthDate || "")}"></label>
        <label class="field"><span>Ocupación</span><input class="input" name="occupation" value="${escapeAttr(patient.occupation || "")}"></label>
      </div>
      <div class="card" style="box-shadow:none;background:#f8fafc;">
        <p class="eyebrow">Preguntas médicas</p>
        <div class="form-grid">
          <label class="field"><span>Diabetes</span>${yesNoSelect("diabetes", medical.diabetes)}</label>
          <label class="field"><span>Hipertensión</span>${yesNoSelect("hypertension", medical.hypertension)}</label>
          <label class="field"><span>Cirugías oculares</span><input class="input" name="surgery" value="${escapeAttr(medical.surgery || "")}"></label>
          <label class="field"><span>Enfermedad ocular</span><input class="input" name="eyeDisease" value="${escapeAttr(medical.eyeDisease || "")}"></label>
          <label class="field"><span>Alergias</span><input class="input" name="allergies" value="${escapeAttr(medical.allergies || "")}"></label>
          <label class="field"><span>Medicamentos</span><input class="input" name="medications" value="${escapeAttr(medical.medications || "")}"></label>
          <label class="field"><span>Antecedentes familiares</span><input class="input" name="familyHistory" value="${escapeAttr(medical.familyHistory || "")}"></label>
          <label class="field"><span>Horas frente a pantalla</span><input class="input" name="screenHours" value="${escapeAttr(medical.screenHours || "")}" placeholder="8 horas"></label>
        </div>
      </div>
      <div class="card" style="box-shadow:none;background:#f8fafc;">
        <p class="eyebrow">Uso de lentes</p>
        <div class="form-grid">
          <label class="field"><span>Uso principal</span><select class="select" name="useCase">${optionList(["Trabajo en pantalla", "Lectura", "Manejo", "Uso diario", "Deportivo", "Protección solar"], lens.useCase)}</select></label>
          <label class="field"><span>Tipo recomendado</span>${lensTypeSelect("lensType", lens.type)}</label>
          <label class="field"><span>Material</span>${materialSelect("material", lens.material)}</label>
          <label class="field"><span>Antirreflejante</span>${yesNoSelect("antiReflective", lens.antiReflective)}</label>
          <label class="field"><span>Filtro azul</span>${yesNoSelect("blueFilter", lens.blueFilter)}</label>
          <label class="field"><span>Fotocromático</span>${yesNoSelect("photochromic", lens.photochromic)}</label>
        </div>
      </div>
      <label class="field"><span>Notas</span><textarea class="textarea" name="notes">${escapeHtml(patient.notes || "")}</textarea></label>
      <button class="btn btn-primary" type="submit"><i data-lucide="save"></i> Guardar expediente</button>
    </form>
  `);
}

function modalAppointment(contextId) {
  const appointment = state.data.appointments.find((entry) => entry.id === contextId) || {};
  const editing = Boolean(appointment.id);
  const patient = editing
    ? state.data.patients.find((entry) => entry.id === appointment.patientId) || {}
    : state.data.patients.find((entry) => entry.id === contextId) || {};
  const selectedPatientId = appointment.patientId || patient.id || "";
  return modalShell(editing ? "Editar cita" : "Nueva cita", "Agenda clínica", `
    <form class="stack" data-form="appointment">
      <input type="hidden" name="id" value="${escapeAttr(appointment.id || "")}">
      <div class="form-grid">
        <label class="field"><span>Paciente</span><select class="select" name="patientId" required>${patientOptions(visibleRows("patients"), selectedPatientId)}</select></label>
        <label class="field"><span>Doctor</span><select class="select" name="doctorId">${doctorOptions(visibleRows("doctors"), appointment.doctorId || "")}</select></label>
        <label class="field"><span>Sucursal</span>${branchSelect("branch", appointment.branch || patient.branch || currentWriteBranch())}</label>
        <label class="field"><span>Fecha y hora</span><input class="input" type="datetime-local" name="startsAt" required value="${appointment.startsAt ? toDateTimeInput(appointment.startsAt) : defaultDateTimeLocal()}"></label>
        <label class="field"><span>Tipo</span><select class="select" name="type">${optionList(["Consulta", "Entrega", "Ajuste", "Garantía", "Seguimiento"], appointment.type || "Consulta")}</select></label>
        <label class="field"><span>Recordar antes</span><select class="select" name="reminderMinutes">${optionList(["15", "30", "60", "120", "1440"], String(appointment.reminderMinutes || 60), (value) => `${value} min`)}</select></label>
        ${editing ? `<label class="field full"><span>Estado</span><select class="select" name="status">${optionList(["Programada", "Confirmada", "En consulta", "Completada", "Cancelada"], appointment.status || "Programada")}</select></label>` : ""}
      </div>
      <label class="field"><span>Notas</span><textarea class="textarea" name="notes">${escapeHtml(appointment.notes || "")}</textarea></label>
      <div class="row-actions">
        <button class="btn btn-primary" type="submit"><i data-lucide="calendar-plus"></i> ${editing ? "Actualizar cita" : "Guardar cita"}</button>
        ${editing ? `<button class="btn btn-danger" type="button" data-action="appointment-delete" data-id="${appointment.id}"><i data-lucide="trash-2"></i> Eliminar cita</button>` : ""}
      </div>
    </form>
  `);
}

function modalFollowUp() {
  return modalShell("Nuevo recordatorio", "Seguimiento", `
    <form class="stack" data-form="followUp">
      <div class="form-grid">
        <label class="field"><span>Paciente</span><select class="select" name="patientId">${patientOptions(visibleRows("patients"), state.selectedPatientId)}</select></label>
        <label class="field"><span>Fecha</span><input class="input" type="date" name="dueDate" required value="${toDateInput(addDays(new Date(), 7))}"></label>
        <label class="field full"><span>Título</span><input class="input" name="title" required placeholder="Llamar para confirmar adaptación"></label>
        <label class="field full"><span>Notas</span><textarea class="textarea" name="notes"></textarea></label>
      </div>
      <button class="btn btn-primary" type="submit"><i data-lucide="bell-plus"></i> Guardar recordatorio</button>
    </form>
  `);
}

function modalOrder(id = "") {
  const order = state.data.orders.find((entry) => entry.id === id) || {};
  const editing = Boolean(order.id);
  return modalShell(editing ? "Editar orden" : "Nueva orden", "Laboratorio", `
    <form class="stack" data-form="order">
      <input type="hidden" name="id" value="${escapeAttr(order.id || "")}">
      <div class="form-grid">
        <label class="field"><span>Paciente</span><select class="select" name="patientId" required>${patientOptions(visibleRows("patients"), order.patientId || state.selectedPatientId)}</select></label>
        <label class="field"><span>Sucursal</span>${branchSelect("branch", order.branch || currentWriteBranch())}</label>
        <label class="field"><span>Tipo de lente</span>${lensTypeSelect("lensType", order.lensType || "Monofocal")}</label>
        <label class="field"><span>Entrega estimada</span><input class="input" type="date" name="dueDate" value="${escapeAttr(order.dueDate || toDateInput(addDays(new Date(), 5)))}"></label>
        <label class="field"><span>Total de orden</span><input class="input" type="number" min="0" step="0.01" name="total" value="${escapeAttr(order.total ?? "")}" placeholder="0.00"></label>
        <label class="field"><span>Anticipo</span><input class="input" type="number" min="0" step="0.01" name="deposit" value="${escapeAttr(order.deposit ?? "")}" placeholder="0.00"></label>
        <label class="field"><span>Armazón / modelo</span><input class="input" name="frameModel" value="${escapeAttr(order.frameModel || "")}" placeholder="Marca, color, modelo"></label>
        <label class="field"><span>Laboratorio</span><input class="input" name="labName" value="${escapeAttr(order.labName || "")}" placeholder="Nombre del laboratorio"></label>
        ${editing ? `<label class="field full"><span>Estado</span><select class="select" name="status">${optionList(["Pendiente", "En laboratorio", "Lista", "Entregada", "Cancelada"], order.status || "Pendiente")}</select></label>` : ""}
        <label class="field full"><span>Notas de laboratorio</span><textarea class="textarea" name="notes">${escapeHtml(order.notes || "")}</textarea></label>
      </div>
      <div class="row-actions">
        <button class="btn btn-primary" type="submit"><i data-lucide="file-plus"></i> ${editing ? "Actualizar orden" : "Guardar orden"}</button>
        ${editing ? `<button class="btn btn-danger" type="button" data-action="order-delete" data-id="${order.id}"><i data-lucide="trash-2"></i> Eliminar orden</button>` : ""}
      </div>
    </form>
  `);
}

function modalInventory(id) {
  const item = state.data.inventory.find((entry) => entry.id === id) || {};
  return modalShell(item.id ? "Editar producto" : "Nuevo producto", "Inventario", `
    <form class="stack" data-form="inventory">
      <input type="hidden" name="id" value="${escapeAttr(item.id || "")}">
      <div class="form-grid">
        <label class="field"><span>Producto</span><input class="input" name="name" required value="${escapeAttr(item.name || "")}"></label>
        <label class="field"><span>Categoría</span><select class="select" name="category">${optionList(["Armazón", "Mica", "Tratamiento", "Accesorio", "Servicio"], item.category || "Armazón")}</select></label>
        <label class="field"><span>Sucursal</span>${branchSelect("branch", item.branch || currentWriteBranch())}</label>
        <label class="field"><span>Precio venta</span><input class="input" type="number" min="0" step="0.01" name="price" value="${escapeAttr(item.price || "")}"></label>
        <label class="field"><span>Costo</span><input class="input" type="number" min="0" step="0.01" name="cost" value="${escapeAttr(item.cost || "")}"></label>
        <label class="field"><span>Stock</span><input class="input" type="number" min="0" name="stock" value="${escapeAttr(item.stock ?? "")}"></label>
        <label class="field"><span>Stock mínimo</span><input class="input" type="number" min="0" name="minStock" value="${escapeAttr(item.minStock ?? "2")}"></label>
        <label class="field"><span>Estado</span>${activeSelect("active", item.active !== false)}</label>
      </div>
      <button class="btn btn-primary" type="submit"><i data-lucide="save"></i> Guardar producto</button>
    </form>
  `);
}

function modalPurchase() {
  return modalShell("Registrar compra", "Compras", `
    <form class="stack" data-form="purchase">
      <div class="form-grid">
        <label class="field"><span>Proveedor</span><input class="input" name="supplier" required></label>
        <label class="field"><span>Sucursal</span>${branchSelect("branch", currentWriteBranch())}</label>
        <label class="field"><span>Total</span><input class="input" type="number" min="0" step="0.01" name="total" required></label>
        <label class="field"><span>Estatus</span><select class="select" name="status">${optionList(["Solicitada", "Pagada", "Recibida"], "Solicitada")}</select></label>
        <label class="field full"><span>Notas</span><textarea class="textarea" name="notes"></textarea></label>
      </div>
      <button class="btn btn-primary" type="submit"><i data-lucide="save"></i> Guardar compra</button>
    </form>
  `);
}

function modalUser(id) {
  const user = state.data.users.find((entry) => entry.id === id) || {};
  const editing = Boolean(user.id);
  const permissions = user.permissions || {};
  return modalShell(editing ? "Editar usuario" : "Nuevo usuario", "Accesos", `
    <form class="stack" data-form="user">
      <input type="hidden" name="id" value="${escapeAttr(user.id || "")}">
      <div class="form-grid">
        <label class="field"><span>Nombre</span><input class="input" name="displayName" required value="${escapeAttr(user.displayName || "")}"></label>
        <label class="field"><span>Usuario interno</span><input class="input" name="username" required value="${escapeAttr(user.username || "")}"></label>
        <label class="field"><span>${editing ? "Correo de acceso no editable" : "Correo"}</span><input class="input" type="email" name="email" required value="${escapeAttr(user.email || "")}" ${editing ? "readonly aria-readonly=\"true\"" : ""}></label>
        ${editing ? "" : `<label class="field"><span>Contraseña temporal</span><input class="input" type="password" name="password" required minlength="6"></label>`}
        <label class="field"><span>Teléfono</span><input class="input" name="phone" value="${escapeAttr(user.phone || "")}"></label>
        <label class="field"><span>Puesto</span><input class="input" name="jobTitle" value="${escapeAttr(user.jobTitle || "")}" placeholder="Optometrista, recepción..."></label>
        <label class="field"><span>Código interno</span><input class="input" name="employeeCode" value="${escapeAttr(user.employeeCode || "")}"></label>
        <label class="field"><span>Doctor asociado</span><select class="select" name="doctorId">${doctorOptions(state.data.doctors || [], user.doctorId || "")}</select></label>
        <label class="field"><span>Rol</span><select class="select" name="role">${optionList(ROLES, user.role || "Optometrista")}</select></label>
        <label class="field"><span>Sucursal</span>${branchSelect("branch", user.branch || "Alcalá", user.role === "Administrador")}</label>
        <label class="field"><span>Estado</span>${activeSelect("active", user.active !== false)}</label>
        <label class="field"><span>Agenda</span>${yesNoSelect("canManageAppointments", permissions.appointments !== false)}</label>
        <label class="field"><span>Expedientes</span>${yesNoSelect("canManagePatients", permissions.patients !== false)}</label>
        <label class="field"><span>Laboratorio</span>${yesNoSelect("canManageLab", permissions.lab !== false)}</label>
        <label class="field"><span>Reportes</span>${yesNoSelect("canManageReports", permissions.reports === true)}</label>
        <label class="field full"><span>Notas internas</span><textarea class="textarea" name="adminNotes">${escapeHtml(user.adminNotes || "")}</textarea></label>
      </div>
      ${editing ? `<p class="hint">Firebase Authentication no permite cambiar desde esta app el correo de acceso de otro usuario. Para corregirlo, crea un usuario nuevo con el correo correcto y cambia este usuario a Inactivo.</p>` : ""}
      <div class="row-actions">
        <button class="btn btn-primary" type="submit"><i data-lucide="save"></i> ${editing ? "Guardar usuario" : "Crear acceso"}</button>
        ${editing && user.id !== state.profile.id ? `<button class="btn btn-danger" type="button" data-action="user-delete" data-id="${user.id}"><i data-lucide="trash-2"></i> Eliminar acceso</button>` : ""}
      </div>
    </form>
  `);
}

function modalDoctor(id) {
  const doctor = state.data.doctors.find((entry) => entry.id === id) || {};
  return modalShell(doctor.id ? "Editar doctor" : "Nuevo doctor", "Equipo clínico", `
    <form class="stack" data-form="doctor">
      <input type="hidden" name="id" value="${escapeAttr(doctor.id || "")}">
      <div class="form-grid">
        <label class="field"><span>Nombre</span><input class="input" name="name" required value="${escapeAttr(doctor.name || "")}"></label>
        <label class="field"><span>Teléfono</span><input class="input" name="phone" value="${escapeAttr(doctor.phone || "")}"></label>
        <label class="field"><span>Sucursal</span>${branchSelect("branch", doctor.branch || currentWriteBranch())}</label>
        <label class="field"><span>Especialidad</span><input class="input" name="specialty" value="${escapeAttr(doctor.specialty || "Optometría")}"></label>
        <label class="field"><span>Cédula / licencia</span><input class="input" name="license" value="${escapeAttr(doctor.license || "")}"></label>
        <label class="field"><span>Estado</span>${activeSelect("active", doctor.active !== false)}</label>
      </div>
      <button class="btn btn-primary" type="submit"><i data-lucide="save"></i> Guardar doctor</button>
    </form>
  `);
}

function modalProfile() {
  return modalShell("Mi perfil", "Cuenta", `
    <form class="stack" data-form="profile">
      <div class="form-grid">
        <label class="field"><span>Nombre</span><input class="input" name="displayName" value="${escapeAttr(state.profile.displayName || "")}" ${isAdmin() ? "" : "readonly"}></label>
        <label class="field"><span>Usuario</span><input class="input" name="username" value="${escapeAttr(state.profile.username || "")}" ${isAdmin() ? "" : "readonly"}></label>
        <label class="field full"><span>Nueva contraseña</span><input class="input" type="password" name="password" minlength="6" placeholder="Solo si deseas cambiarla"></label>
      </div>
      <p class="hint">Por seguridad, Firebase puede pedir que vuelvas a iniciar sesión antes de cambiar tu contraseña.</p>
      <button class="btn btn-primary" type="submit"><i data-lucide="save"></i> Actualizar perfil</button>
    </form>
  `);
}

async function handleClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const { action } = target.dataset;

  if (action === "reload") {
    location.reload();
    return;
  }
  if (!canRunAction(action)) {
    showToast("Tu rol no tiene permiso para esta acción.", "error");
    return;
  }
  if (action === "navigate") {
    const nextView = target.dataset.view;
    if (!canAccessView(nextView)) {
      showToast("Tu rol no tiene acceso a esta sección.", "error");
      state.view = "home";
      renderApp();
      return;
    }
    state.view = nextView;
    renderApp();
    return;
  }
  if (action === "modal") {
    const modal = target.dataset.modal;
    if (!canOpenModal(modal)) {
      showToast("Tu rol no tiene permiso para esta acción.", "error");
      return;
    }
    renderModal(modal, target.dataset.id || "");
    return;
  }
  if (action === "close-modal") {
    closeModal();
    return;
  }
  if (action === "open-profile") {
    renderModal("profile");
    return;
  }
  if (action === "select-patient") {
    if (!canAccessView("patients")) {
      showToast("Tu rol no tiene acceso a expedientes.", "error");
      return;
    }
    state.selectedPatientId = target.dataset.id || "";
    state.view = "patients";
    renderApp();
    return;
  }
  if (action === "start-exam") {
    if (!canAccessView("exam")) {
      showToast("Tu rol no tiene acceso a consulta.", "error");
      return;
    }
    state.selectedPatientId = target.dataset.id || "";
    state.selectedExamPatientId = target.dataset.id || "";
    state.view = "exam";
    renderApp();
    return;
  }
  if (action === "agenda-shift") {
    const current = new Date(`${state.filters.appointmentDate}T12:00:00`);
    state.filters.appointmentDate = toDateInput(addDays(current, Number(target.dataset.days || 0)));
    state.view = "appointments";
    renderApp();
    return;
  }
  if (action === "agenda-today") {
    state.filters.appointmentDate = toDateInput(new Date());
    state.view = "appointments";
    renderApp();
    return;
  }
  if (action === "cart-add") {
    addToCart(target.dataset.id);
    return;
  }
  if (action === "cart-qty") {
    changeCartQty(target.dataset.id, Number(target.dataset.delta || 0));
    return;
  }
  if (action === "cart-remove") {
    removeFromCart(target.dataset.id);
    return;
  }
  if (action === "cart-clear") {
    state.cart = [];
    renderApp();
    return;
  }
  if (action === "checkout") {
    await checkout();
    return;
  }
  if (action === "receipt-print") {
    printReceipt(target.dataset.id);
    return;
  }
  if (action === "appointment-delete") {
    await deleteAppointment(target.dataset.id);
    return;
  }
  if (action === "order-delete") {
    await deleteOrder(target.dataset.id);
    return;
  }
  if (action === "order-payoff") {
    await payoffOrder(target.dataset.id);
    return;
  }
  if (action === "stock-adjust") {
    await adjustStock(target.dataset.id, Number(target.dataset.delta || 0));
    return;
  }
  if (action === "followup-done") {
    await completeFollowUp(target.dataset.id);
    return;
  }
  if (action === "followup-delete") {
    await deleteFollowUp(target.dataset.id);
    return;
  }
  if (action === "password-reset") {
    await sendReset(target.dataset.email);
    return;
  }
  if (action === "user-toggle") {
    await toggleUserStatus(target.dataset.id, target.dataset.active === "true");
    return;
  }
  if (action === "user-delete") {
    await deleteUserAccess(target.dataset.id);
    return;
  }
  if (action === "export-backup") {
    exportBackup();
    return;
  }
  if (action === "export-patients-csv") {
    exportPatientsCsv();
    return;
  }
  if (action === "export-sales-csv") {
    exportSalesCsv();
    return;
  }
  if (action === "export-lab-csv") {
    exportLabCsv();
    return;
  }
  if (action === "enable-notifications") {
    await enableNotifications();
    return;
  }
}

async function handleSubmit(event) {
  const form = event.target.closest("[data-form]");
  if (!form) return;
  event.preventDefault();
  const name = form.dataset.form;
  if (!canSubmitForm(name)) {
    showToast("Tu rol no tiene permiso para guardar este formulario.", "error");
    return;
  }
  const submitter = form.querySelector("button[type='submit']");
  setBusy(submitter, true);

  try {
    const handlers = {
      login: submitLogin,
      bootstrap: submitBootstrap,
      patient: submitPatient,
      appointment: submitAppointment,
      followUp: submitFollowUp,
      exam: submitExam,
      order: submitOrder,
      inventory: submitInventory,
      purchase: submitPurchase,
      user: submitUser,
      doctor: submitDoctor,
      profile: submitProfile
    };
    await handlers[name]?.(new FormData(form), form);
  } catch (error) {
    showToast(readableError(error), "error");
  } finally {
    setBusy(submitter, false);
  }
}

async function handleChange(event) {
  const target = event.target;
  if (target.dataset.action === "switch-branch") {
    if (!isAdmin()) {
      showToast("Solo administrador puede cambiar la vista de sucursal.", "error");
      return;
    }
    state.branch = target.value;
    renderApp();
    return;
  }
  if (target.dataset.action === "appointment-status") {
    if (!canAccessView("appointments")) {
      showToast("Tu rol no tiene permiso para actualizar citas.", "error");
      renderApp(false);
      return;
    }
    const payload = {
      status: target.value,
      updatedAt: serverTimestamp()
    };
    if (target.value === "Completada") payload.completedAt = serverTimestamp();
    if (target.value === "Cancelada") payload.cancelledAt = serverTimestamp();
    await updateDoc(doc(db, "appointments", target.dataset.id), payload);
    showToast("Estatus de cita actualizado.", "success");
    return;
  }
  if (target.dataset.action === "order-status") {
    if (!canAccessView("lab")) {
      showToast("Tu rol no tiene permiso para actualizar laboratorio.", "error");
      renderApp(false);
      return;
    }
    const order = state.data.orders.find((item) => item.id === target.dataset.id);
    if (target.value === "Entregada" && orderBalance(order || {}) > 0 && !confirm(`Esta orden tiene saldo pendiente de ${currency(orderBalance(order))}. ¿Marcarla como entregada de todos modos?`)) {
      renderApp(false);
      return;
    }
    const payload = {
      status: target.value,
      updatedAt: serverTimestamp()
    };
    if (target.value === "Lista") payload.readyAt = serverTimestamp();
    if (target.value === "Entregada") payload.deliveredAt = serverTimestamp();
    if (target.value === "Cancelada") payload.cancelledAt = serverTimestamp();
    await updateDoc(doc(db, "orders", target.dataset.id), payload);
    showToast("Orden actualizada.", "success");
    return;
  }
  if (target.dataset.action === "exam-patient") {
    state.selectedExamPatientId = target.value;
    renderApp();
    return;
  }
  if (target.dataset.filter) {
    state.filters[target.dataset.filter] = target.value;
    renderApp();
  }
}

function handleInput(event) {
  const target = event.target;
  if (!target.dataset.liveFilter) return;
  state.filters[target.dataset.liveFilter] = target.value;
  if (target.dataset.liveFilter === "patientSearch" && state.view === "patients") {
    refreshPatientsOnly();
  }
  if (target.dataset.liveFilter === "stockSearch" && state.view === "inventory") {
    renderApp();
  }
}

async function submitLogin(form) {
  const email = clean(form.get("email"));
  const password = String(form.get("password") || "");
  await signInWithEmailAndPassword(auth, email, password);
}

async function submitBootstrap(form) {
  state.bootstrapping = true;
  const email = clean(form.get("email"));
  const password = String(form.get("password") || "");
  const displayName = clean(form.get("displayName"));
  const username = clean(form.get("username"));

  try {
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    await setDoc(doc(db, "users", credential.user.uid), {
      displayName,
      username,
      email,
      role: "Administrador",
      branch: "Global",
      active: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    await setDoc(doc(db, "app", "config"), {
      initialized: true,
      appVersion: APP_VERSION,
      createdAt: serverTimestamp(),
      createdBy: credential.user.uid,
      branches: BRANCHES
    });
    await seedInitialData();
    state.needsBootstrap = false;
    state.bootstrapping = false;
    await loadSession(credential.user);
    showToast("Administrador inicial creado.", "success");
  } catch (error) {
    state.bootstrapping = false;
    throw error;
  }
}

async function submitPatient(form) {
  const id = clean(form.get("id"));
  const phone = clean(form.get("phone"));
  if (phoneDigits(phone).length < 8) {
    throw new Error("Captura un teléfono válido para el expediente.");
  }
  const payload = {
    name: clean(form.get("name")),
    phone,
    email: clean(form.get("email")),
    branch: clean(form.get("branch")) || currentWriteBranch(),
    birthDate: clean(form.get("birthDate")),
    occupation: clean(form.get("occupation")),
    medical: {
      diabetes: form.get("diabetes") === "true",
      hypertension: form.get("hypertension") === "true",
      surgery: clean(form.get("surgery")),
      eyeDisease: clean(form.get("eyeDisease")),
      allergies: clean(form.get("allergies")),
      medications: clean(form.get("medications")),
      familyHistory: clean(form.get("familyHistory")),
      screenHours: clean(form.get("screenHours"))
    },
    lensUse: {
      useCase: clean(form.get("useCase")),
      type: clean(form.get("lensType")),
      material: clean(form.get("material")),
      antiReflective: form.get("antiReflective") === "true",
      blueFilter: form.get("blueFilter") === "true",
      photochromic: form.get("photochromic") === "true"
    },
    notes: clean(form.get("notes")),
    updatedAt: serverTimestamp()
  };

  const duplicate = duplicatePatient(payload, id);
  if (duplicate && !confirm(`Ya existe un expediente parecido: ${duplicate.name || "Paciente"} (${duplicate.phone || "sin teléfono"}). ¿Guardar de todos modos?`)) {
    return;
  }

  if (id) {
    await updateDoc(doc(db, "patients", id), payload);
    state.selectedPatientId = id;
  } else {
    payload.createdAt = serverTimestamp();
    const created = await addDoc(collection(db, "patients"), payload);
    state.selectedPatientId = created.id;
  }
  closeModal();
  showToast("Expediente guardado.", "success");
}

async function submitAppointment(form) {
  const id = clean(form.get("id"));
  const patient = state.data.patients.find((item) => item.id === form.get("patientId"));
  const doctor = state.data.doctors.find((item) => item.id === form.get("doctorId"));
  const startsAt = new Date(String(form.get("startsAt")));
  if (!patient) {
    throw new Error("Selecciona un paciente para la cita.");
  }
  if (Number.isNaN(startsAt.getTime())) {
    throw new Error("Selecciona una fecha y hora válida para la cita.");
  }
  const payload = {
    patientId: patient?.id || "",
    patientName: patient?.name || "Paciente",
    doctorId: doctor?.id || "",
    doctorName: doctor?.name || "",
    branch: clean(form.get("branch")) || patient?.branch || currentWriteBranch(),
    startsAt: startsAt.toISOString(),
    type: clean(form.get("type")) || "Consulta",
    status: clean(form.get("status")) || "Programada",
    reminderMinutes: Number(form.get("reminderMinutes") || 60),
    notes: clean(form.get("notes")),
    updatedAt: serverTimestamp()
  };

  const conflict = conflictingAppointment(payload, id);
  if (conflict && !confirm(`Ya hay una cita cercana: ${conflict.patientName || "Paciente"} a las ${formatTime(conflict.startsAt)}. ¿Guardar de todos modos?`)) {
    return;
  }

  if (id) {
    await updateDoc(doc(db, "appointments", id), payload);
  } else {
    await addDoc(collection(db, "appointments"), {
      ...payload,
      createdAt: serverTimestamp()
    });
  }
  closeModal();
  showToast(id ? "Cita actualizada." : "Cita guardada con recordatorio.", "success");
}

function conflictingAppointment(payload, currentId = "") {
  const start = new Date(payload.startsAt);
  if (Number.isNaN(start.getTime())) return null;
  return visibleRows("appointments").find((item) => {
    if (item.id === currentId) return false;
    if (["Completada", "Cancelada"].includes(item.status)) return false;
    if (item.branch && payload.branch && item.branch !== payload.branch) return false;
    if (item.doctorId && payload.doctorId && item.doctorId !== payload.doctorId) return false;
    const other = new Date(item.startsAt);
    if (Number.isNaN(other.getTime())) return false;
    return Math.abs(other.getTime() - start.getTime()) < 45 * 60 * 1000;
  });
}

function duplicatePatient(payload, currentId = "") {
  const phone = phoneDigits(payload.phone);
  const email = normalize(payload.email);
  const name = normalize(payload.name);
  return visibleRows("patients").find((patient) => {
    if (patient.id === currentId) return false;
    if (patient.branch && payload.branch && patient.branch !== payload.branch) return false;
    const samePhone = phone.length >= 8 && phoneDigits(patient.phone).endsWith(phone.slice(-8));
    const sameEmail = email && normalize(patient.email) === email;
    const sameName = name && normalize(patient.name) === name;
    return samePhone || sameEmail || sameName;
  });
}

function patientDuplicateGroups(patients) {
  const buckets = new Map();
  patients.forEach((patient) => {
    const keys = [
      phoneDigits(patient.phone).length >= 8 ? `tel:${phoneDigits(patient.phone).slice(-8)}` : "",
      normalize(patient.email) ? `mail:${normalize(patient.email)}` : "",
      normalize(patient.name) ? `name:${normalize(patient.name)}:${patient.branch || ""}` : ""
    ].filter(Boolean);
    keys.forEach((key) => {
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(patient);
    });
  });
  const seen = new Set();
  return [...buckets.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const ids = group.map((patient) => patient.id).sort().join("|");
      if (seen.has(ids)) return null;
      seen.add(ids);
      return group;
    })
    .filter(Boolean);
}

async function deleteAppointment(appointmentId) {
  if (!appointmentId) return;
  const appointment = state.data.appointments.find((item) => item.id === appointmentId);
  const label = appointment?.patientName || "esta cita";
  if (!confirm(`¿Eliminar la cita de ${label}?`)) return;
  await deleteDoc(doc(db, "appointments", appointmentId));
  closeModal();
  showToast("Cita eliminada.", "success");
}

async function adjustStock(productId, delta) {
  if (!productId || !delta) return;
  const product = state.data.inventory.find((item) => item.id === productId);
  if (!product) return;
  if (delta < 0 && Number(product.stock || 0) <= 0) {
    showToast("El stock ya está en cero.", "error");
    return;
  }
  await updateDoc(doc(db, "inventory", productId), {
    stock: increment(delta),
    updatedAt: serverTimestamp()
  });
  showToast(delta > 0 ? "Stock aumentado." : "Stock reducido.", "success");
}

async function submitFollowUp(form) {
  const patient = state.data.patients.find((item) => item.id === form.get("patientId"));
  if (!patient) {
    throw new Error("Selecciona un paciente para el recordatorio.");
  }
  await addDoc(collection(db, "followUps"), {
    patientId: patient?.id || "",
    patientName: patient?.name || "",
    title: clean(form.get("title")),
    branch: patient?.branch || currentWriteBranch(),
    dueDate: clean(form.get("dueDate")),
    notes: clean(form.get("notes")),
    done: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  closeModal();
  showToast("Recordatorio guardado.", "success");
}

async function completeFollowUp(followUpId) {
  if (!followUpId) return;
  await updateDoc(doc(db, "followUps", followUpId), {
    done: true,
    completedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  showToast("Seguimiento completado.", "success");
}

async function deleteFollowUp(followUpId) {
  if (!followUpId) return;
  if (!confirm("¿Eliminar este recordatorio?")) return;
  await deleteDoc(doc(db, "followUps", followUpId));
  showToast("Recordatorio eliminado.", "success");
}

async function scheduleAnnualLensReview(patient, form) {
  const dueDate = toDateInput(addDays(new Date(), 365));
  const risk = healthRiskLabels(patient);
  const lens = clean(form.get("lensRecommendation")) || patient.lensUse?.type || "lentes";
  const material = clean(form.get("material")) || patient.lensUse?.material || "";
  const title = "Revisión anual de lentes";
  const notes = [
    `Recomendar nueva valoración y renovación de ${lens}${material ? ` (${material})` : ""}.`,
    risk.length ? `Prioridad por salud: ${risk.join(", ")}.` : "Control anual recomendado para mantener graduación y adaptación.",
    "Contactar al cliente antes de la fecha para agendar consulta."
  ].join(" ");
  const existing = nextAnnualReview(patient.id);
  const payload = {
    patientId: patient.id,
    patientName: patient.name || "",
    title,
    branch: patient.branch || currentWriteBranch(),
    dueDate,
    notes,
    type: "annualReview",
    done: false,
    updatedAt: serverTimestamp()
  };
  if (existing) {
    await updateDoc(doc(db, "followUps", existing.id), payload);
  } else {
    await addDoc(collection(db, "followUps"), {
      ...payload,
      createdAt: serverTimestamp()
    });
  }
}

async function submitExam(form, formElement) {
  const patient = state.data.patients.find((item) => item.id === form.get("patientId"));
  if (!patient) throw new Error("Selecciona un paciente.");
  const examValues = ["odEsf", "odCil", "odEje", "odAdd", "oiEsf", "oiCil", "oiEje", "oiAdd", "visualAcuity", "pd", "diagnosis", "labNotes"]
    .map((name) => clean(form.get(name)));
  if (!examValues.some(Boolean)) {
    throw new Error("Captura al menos un dato de receta, diagnóstico o nota clínica.");
  }
  await addDoc(collection(db, "exams"), {
    patientId: patient.id,
    patientName: patient.name,
    branch: patient.branch || currentWriteBranch(),
    odEsf: clean(form.get("odEsf")),
    odCil: clean(form.get("odCil")),
    odEje: clean(form.get("odEje")),
    odAdd: clean(form.get("odAdd")),
    oiEsf: clean(form.get("oiEsf")),
    oiCil: clean(form.get("oiCil")),
    oiEje: clean(form.get("oiEje")),
    oiAdd: clean(form.get("oiAdd")),
    visualAcuity: clean(form.get("visualAcuity")),
    pd: clean(form.get("pd")),
    diagnosis: clean(form.get("diagnosis")),
    lensRecommendation: clean(form.get("lensRecommendation")),
    material: clean(form.get("material")),
    labNotes: clean(form.get("labNotes")),
    doctorId: state.profile.id,
    doctorName: state.profile.displayName || "",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  await updateDoc(doc(db, "patients", patient.id), {
    "lensUse.type": clean(form.get("lensRecommendation")),
    "lensUse.material": clean(form.get("material")),
    updatedAt: serverTimestamp()
  });
  if (form.get("createOrder") === "on") {
    await addDoc(collection(db, "orders"), {
      patientId: patient.id,
      patientName: patient.name,
      branch: patient.branch || currentWriteBranch(),
      lensType: clean(form.get("lensRecommendation")),
      dueDate: clean(form.get("orderDueDate")) || toDateInput(addDays(new Date(), 5)),
      total: 0,
      deposit: 0,
      balance: 0,
      status: "Pendiente",
      notes: clean(form.get("labNotes")),
      createdFromExam: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  }
  if (form.get("createAnnualReview") === "on") {
    await scheduleAnnualLensReview(patient, form);
  }
  formElement.reset();
  const extras = [form.get("createOrder") === "on" ? "orden" : "", form.get("createAnnualReview") === "on" ? "recordatorio anual" : ""].filter(Boolean).join(" y ");
  showToast(extras ? `Consulta, ${extras} guardados.` : "Consulta guardada.", "success");
}

async function submitOrder(form) {
  const id = clean(form.get("id"));
  const patient = state.data.patients.find((item) => item.id === form.get("patientId"));
  const total = moneyValue(form.get("total"));
  const requestedDeposit = moneyValue(form.get("deposit"));
  const deposit = Math.min(requestedDeposit, total || requestedDeposit);
  if (!patient) {
    throw new Error("Selecciona un paciente para la orden.");
  }
  if (requestedDeposit > total && total > 0) {
    throw new Error("El anticipo no puede ser mayor al total de la orden.");
  }
  const payload = {
    patientId: patient?.id || "",
    patientName: patient?.name || "Paciente",
    branch: clean(form.get("branch")) || patient?.branch || currentWriteBranch(),
    lensType: clean(form.get("lensType")),
    dueDate: clean(form.get("dueDate")),
    total,
    deposit,
    balance: Math.max(0, total - deposit),
    frameModel: clean(form.get("frameModel")),
    labName: clean(form.get("labName")),
    status: clean(form.get("status")) || "Pendiente",
    notes: clean(form.get("notes")),
    updatedAt: serverTimestamp()
  };
  if (id) {
    await updateDoc(doc(db, "orders", id), payload);
  } else {
    await addDoc(collection(db, "orders"), {
      ...payload,
      createdAt: serverTimestamp()
    });
  }
  closeModal();
  showToast(id ? "Orden actualizada." : "Orden de laboratorio guardada.", "success");
}

async function deleteOrder(orderId) {
  if (!orderId) return;
  const order = state.data.orders.find((item) => item.id === orderId);
  const label = order?.patientName || "esta orden";
  if (!confirm(`¿Eliminar la orden de ${label}?`)) return;
  await deleteDoc(doc(db, "orders", orderId));
  closeModal();
  showToast("Orden eliminada.", "success");
}

async function payoffOrder(orderId) {
  if (!orderId) return;
  const order = state.data.orders.find((item) => item.id === orderId);
  if (!order) return;
  const total = moneyValue(order.total);
  if (!total || orderBalance(order) <= 0) return;
  if (!confirm(`¿Marcar como liquidada la orden de ${order.patientName || "Paciente"} por ${currency(total)}?`)) return;
  await updateDoc(doc(db, "orders", orderId), {
    deposit: total,
    balance: 0,
    paidAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  showToast("Orden liquidada.", "success");
}

async function submitInventory(form) {
  const id = clean(form.get("id"));
  const payload = {
    name: clean(form.get("name")),
    category: clean(form.get("category")),
    branch: clean(form.get("branch")) || currentWriteBranch(),
    price: Number(form.get("price") || 0),
    cost: Number(form.get("cost") || 0),
    stock: Number(form.get("stock") || 0),
    minStock: Number(form.get("minStock") || 0),
    active: form.get("active") === "true",
    updatedAt: serverTimestamp()
  };
  if (id) {
    await updateDoc(doc(db, "inventory", id), payload);
  } else {
    payload.createdAt = serverTimestamp();
    await addDoc(collection(db, "inventory"), payload);
  }
  closeModal();
  showToast("Producto guardado.", "success");
}

async function submitPurchase(form) {
  await addDoc(collection(db, "purchases"), {
    supplier: clean(form.get("supplier")),
    branch: clean(form.get("branch")) || currentWriteBranch(),
    total: Number(form.get("total") || 0),
    status: clean(form.get("status")),
    notes: clean(form.get("notes")),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  closeModal();
  showToast("Compra registrada.", "success");
}

async function submitUser(form) {
  const id = clean(form.get("id"));
  const role = clean(form.get("role"));
  let branch = clean(form.get("branch"));
  if (role === "Administrador") branch = "Global";
  if (role !== "Administrador" && branch === "Global") {
    throw new Error("Un trabajador debe pertenecer a una sucursal especifica.");
  }
  const payload = {
    displayName: clean(form.get("displayName")),
    username: clean(form.get("username")),
    phone: clean(form.get("phone")),
    jobTitle: clean(form.get("jobTitle")),
    employeeCode: clean(form.get("employeeCode")),
    doctorId: clean(form.get("doctorId")),
    role,
    branch,
    active: form.get("active") === "true",
    permissions: {
      appointments: form.get("canManageAppointments") === "true",
      patients: form.get("canManagePatients") === "true",
      lab: form.get("canManageLab") === "true",
      reports: form.get("canManageReports") === "true"
    },
    adminNotes: clean(form.get("adminNotes")),
    updatedAt: serverTimestamp()
  };

  if (id) {
    const duplicateUsername = state.data.users.find((user) => user.id !== id && normalize(user.username) === normalize(payload.username));
    if (duplicateUsername) {
      throw new Error("Ya existe otro usuario con ese usuario interno.");
    }
    await updateDoc(doc(db, "users", id), payload);
  } else {
    const email = clean(form.get("email"));
    const password = String(form.get("password") || "");
    const duplicate = state.data.users.find((user) => normalize(user.email) === normalize(email) || normalize(user.username) === normalize(payload.username));
    if (duplicate) {
      throw new Error("Ese correo o usuario interno ya existe.");
    }
    const secondaryApp = initializeApp(window.OPTI_FIREBASE_CONFIG, `secondary-${Date.now()}`);
    const secondaryAuth = getAuth(secondaryApp);
    try {
      const credential = await createUserWithEmailAndPassword(secondaryAuth, email, password);
      await setDoc(doc(db, "users", credential.user.uid), {
        ...payload,
        email,
        createdAt: serverTimestamp()
      });
      await signOut(secondaryAuth);
    } finally {
      await deleteApp(secondaryApp);
    }
  }

  closeModal();
  showToast("Usuario guardado.", "success");
}

async function submitDoctor(form) {
  const id = clean(form.get("id"));
  const payload = {
    name: clean(form.get("name")),
    phone: clean(form.get("phone")),
    branch: clean(form.get("branch")),
    specialty: clean(form.get("specialty")) || "Optometría",
    license: clean(form.get("license")),
    active: form.get("active") === "true",
    updatedAt: serverTimestamp()
  };
  if (id) {
    await updateDoc(doc(db, "doctors", id), payload);
  } else {
    payload.createdAt = serverTimestamp();
    await addDoc(collection(db, "doctors"), payload);
  }
  closeModal();
  showToast("Doctor guardado.", "success");
}

async function submitProfile(form) {
  const password = String(form.get("password") || "");
  if (isAdmin()) {
    await updateDoc(doc(db, "users", state.profile.id), {
      displayName: clean(form.get("displayName")),
      username: clean(form.get("username")),
      updatedAt: serverTimestamp()
    });
  }
  if (password) {
    await updatePassword(auth.currentUser, password);
  }
  closeModal();
  showToast("Perfil actualizado.", "success");
}

async function sendReset(email) {
  if (!email) return;
  await sendPasswordResetEmail(auth, email);
  showToast(`Envié reset de contraseña a ${email}.`, "success");
}

async function toggleUserStatus(userId, active) {
  if (!isAdmin() || !userId) return;
  if (userId === state.profile.id && !active) {
    showToast("No puedes desactivar tu propio acceso mientras estás dentro.", "error");
    return;
  }
  try {
    await updateDoc(doc(db, "users", userId), {
      active,
      updatedAt: serverTimestamp()
    });
    showToast(active ? "Usuario reactivado." : "Usuario desactivado.", "success");
  } catch (error) {
    showToast(`No pude cambiar el estado: ${readableError(error)}`, "error");
  }
}

async function deleteUserAccess(userId) {
  if (!isAdmin()) return;
  if (!userId) return;
  if (userId === state.profile.id) {
    showToast("No puedes eliminar tu propio acceso mientras estás dentro.", "error");
    return;
  }
  const user = state.data.users.find((entry) => entry.id === userId);
  const label = user?.displayName || user?.email || "este usuario";
  if (!confirm(`¿Eliminar el acceso de ${label}? Ya no podrá entrar al sistema.`)) return;
  try {
    await deleteDoc(doc(db, "users", userId));
    closeModal();
    showToast("Acceso eliminado. Si quieres borrar también el Auth, hazlo en Firebase Authentication.", "success");
  } catch (error) {
    try {
      await updateDoc(doc(db, "users", userId), {
        active: false,
        deletedAt: serverTimestamp(),
        deletedBy: state.profile.id,
        updatedAt: serverTimestamp()
      });
      closeModal();
      showToast(`No se pudo borrar físicamente (${readableError(error)}), pero quedó inactivo y ya no podrá entrar.`, "success");
    } catch (fallbackError) {
      showToast(`No pude borrar ni desactivar: ${readableError(fallbackError)}`, "error");
    }
  }
}

function exportBackup() {
  const payload = {
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    branch: state.branch,
    exportedBy: {
      id: state.profile?.id || "",
      name: state.profile?.displayName || "",
      email: state.profile?.email || ""
    },
    data: state.data
  };
  downloadText(`opticore-respaldo-${fileDateStamp()}.json`, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
  showToast("Respaldo descargado.", "success");
}

function exportPatientsCsv() {
  const rows = visibleRows("patients").map((patient) => ({
    nombre: patient.name || "",
    telefono: patient.phone || "",
    correo: patient.email || "",
    sucursal: patient.branch || "",
    nacimiento: patient.birthDate || "",
    ocupacion: patient.occupation || "",
    diabetes: yesNo(patient.medical?.diabetes),
    hipertension: yesNo(patient.medical?.hypertension),
    alergias: patient.medical?.allergies || "",
    medicamentos: patient.medical?.medications || "",
    uso_lentes: patient.lensUse?.useCase || "",
    tipo_lente: patient.lensUse?.type || "",
    material: patient.lensUse?.material || "",
    notas: patient.notes || ""
  }));
  downloadText(`opticore-pacientes-${fileDateStamp()}.csv`, toCsv(rows), "text/csv;charset=utf-8");
  showToast("Pacientes exportados.", "success");
}

function exportSalesCsv() {
  const rows = visibleRows("sales").map((sale) => ({
    fecha: formatDate(sale.createdAt),
    sucursal: sale.branch || "",
    paciente: sale.patientName || "",
    metodo_pago: sale.paymentMethod || "",
    articulos: Array.isArray(sale.items) ? sale.items.map((item) => `${item.name} x${item.qty || 1}`).join(" | ") : "",
    total: Number(sale.total || 0)
  }));
  downloadText(`opticore-ventas-${fileDateStamp()}.csv`, toCsv(rows), "text/csv;charset=utf-8");
  showToast("Ventas exportadas.", "success");
}

function exportLabCsv() {
  const rows = visibleRows("orders").map((order) => ({
    paciente: order.patientName || "",
    sucursal: order.branch || "",
    lente: order.lensType || "",
    entrega: order.dueDate || "",
    estado: order.status || "",
    total: Number(order.total || 0),
    anticipo: Number(order.deposit || 0),
    saldo: orderBalance(order),
    armazon: order.frameModel || "",
    laboratorio: order.labName || "",
    notas: order.notes || "",
    creado: formatDate(order.createdAt)
  }));
  downloadText(`opticore-laboratorio-${fileDateStamp()}.csv`, toCsv(rows), "text/csv;charset=utf-8");
  showToast("Laboratorio exportado.", "success");
}

function printReceipt(saleId) {
  const sale = state.data.sales.find((item) => item.id === saleId);
  if (!sale) {
    showToast("No encontré esa venta.", "error");
    return;
  }
  const popup = window.open("", "_blank", "width=420,height=680");
  if (!popup) {
    showToast("Permite ventanas emergentes para imprimir el recibo.", "error");
    return;
  }
  popup.document.write(receiptHtml(sale));
  popup.document.close();
  popup.focus();
  popup.print();
}

function receiptHtml(sale) {
  const items = Array.isArray(sale.items) ? sale.items : [];
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Recibo ${escapeHtml(sale.ticket || sale.id || "")}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 18px; color: #111827; font: 13px/1.4 Arial, sans-serif; }
    .ticket { max-width: 340px; margin: 0 auto; }
    h1 { margin: 0; font-size: 20px; letter-spacing: -0.03em; }
    .muted { color: #64748b; }
    .center { text-align: center; }
    .mark { width: 42px; height: 42px; margin: 0 auto 8px; border-radius: 8px; background: #0f766e; color: white; display: grid; place-items: center; font-weight: 900; }
    .line { border-top: 1px dashed #94a3b8; margin: 12px 0; }
    .row { display: flex; justify-content: space-between; gap: 12px; margin: 6px 0; }
    .row strong:last-child { text-align: right; }
    .total { font-size: 18px; font-weight: 900; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <main class="ticket">
    <div class="center">
      <div class="mark">OC</div>
      <h1>OptiCore</h1>
      <div class="muted">Powered by delarosaleyva.shop</div>
    </div>
    <div class="line"></div>
    <div class="row"><span>Folio</span><strong>${escapeHtml(sale.ticket || sale.id || "-")}</strong></div>
    <div class="row"><span>Fecha</span><strong>${escapeHtml(formatDate(sale.createdAt))}</strong></div>
    <div class="row"><span>Sucursal</span><strong>${escapeHtml(sale.branch || "-")}</strong></div>
    <div class="row"><span>Paciente</span><strong>${escapeHtml(sale.patientName || "Mostrador")}</strong></div>
    <div class="row"><span>Pago</span><strong>${escapeHtml(sale.paymentMethod || "-")}</strong></div>
    <div class="row"><span>Cajero</span><strong>${escapeHtml(sale.cashierName || "-")}</strong></div>
    <div class="line"></div>
    ${items.map((item) => `
      <div class="row"><span>${escapeHtml(item.name || "Producto")} x${Number(item.qty || 1)}</span><strong>${currency(Number(item.price || 0) * Number(item.qty || 1))}</strong></div>
    `).join("")}
    <div class="line"></div>
    <div class="row total"><span>Total</span><strong>${currency(sale.total || 0)}</strong></div>
    <p class="center muted">Gracias por su compra.</p>
  </main>
</body>
</html>`;
}

function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escapeCell = (value) => {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [headers.join(","), ...rows.map((row) => headers.map((header) => escapeCell(row[header])).join(","))].join("\r\n");
}

function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function fileDateStamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

function addToCart(productId) {
  const product = state.data.inventory.find((item) => item.id === productId);
  if (!product) return;
  if (product.active === false || Number(product.stock || 0) <= 0) {
    showToast("Producto no disponible para venta.", "error");
    return;
  }
  const existing = state.cart.find((item) => item.id === productId);
  if (existing) {
    if (Number(existing.qty || 1) >= Number(product.stock || 0)) {
      showToast("No hay suficiente stock para agregar más.", "error");
      return;
    }
    existing.qty += 1;
  } else {
    state.cart.push({ id: product.id, name: product.name, price: Number(product.price || 0), qty: 1, branch: product.branch });
  }
  state.view = "pos";
  renderApp();
}

function changeCartQty(productId, delta) {
  const item = state.cart.find((entry) => entry.id === productId);
  if (!item || !delta) return;
  const product = state.data.inventory.find((entry) => entry.id === productId);
  const nextQty = Number(item.qty || 1) + delta;
  if (nextQty <= 0) {
    removeFromCart(productId);
    return;
  }
  if (product && nextQty > Number(product.stock || 0)) {
    showToast("No hay suficiente stock para esa cantidad.", "error");
    return;
  }
  item.qty = nextQty;
  renderApp();
}

function removeFromCart(productId) {
  state.cart = state.cart.filter((item) => item.id !== productId);
  renderApp();
}

async function checkout() {
  if (!state.cart.length) return;
  const unavailable = state.cart.find((item) => {
    const product = state.data.inventory.find((entry) => entry.id === item.id);
    return !product || product.active === false || Number(item.qty || 1) > Number(product.stock || 0);
  });
  if (unavailable) {
    showToast(`Revisa stock antes de cobrar: ${unavailable.name}.`, "error");
    return;
  }
  const patientId = document.getElementById("posPatient")?.value || "";
  const patient = state.data.patients.find((item) => item.id === patientId);
  const paymentMethod = document.getElementById("posPayment")?.value || "Efectivo";
  const total = state.cart.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.qty || 1), 0);
  const branch = state.branch === "Global" ? state.cart[0]?.branch || "Alcalá" : state.branch;

  const batch = writeBatch(db);
  const saleRef = doc(collection(db, "sales"));
  batch.set(saleRef, {
    ticket: saleRef.id.slice(0, 8).toUpperCase(),
    branch,
    patientId,
    patientName: patient?.name || "",
    paymentMethod,
    items: state.cart,
    total,
    createdBy: state.profile.id,
    cashierName: state.profile.displayName || "",
    createdAt: serverTimestamp()
  });
  state.cart.forEach((item) => {
    batch.update(doc(db, "inventory", item.id), {
      stock: increment(-Number(item.qty || 1)),
      updatedAt: serverTimestamp()
    });
  });
  await batch.commit();
  state.cart = [];
  renderApp();
  showToast("Venta finalizada.", "success");
}

async function enableNotifications() {
  if (!("Notification" in window)) {
    showToast("Este navegador no permite notificaciones.", "error");
    return;
  }
  const permission = await Notification.requestPermission();
  showToast(permission === "granted" ? "Recordatorios activados en este equipo." : "No se activaron notificaciones.", permission === "granted" ? "success" : "error");
}

function startReminderLoop() {
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = setInterval(queueReminderCheck, 60000);
  queueReminderCheck();
}

function queueReminderCheck() {
  const due = dueAppointments();
  due.slice(0, 2).forEach((appointment) => {
    const key = `opticore-reminder-${appointment.id}`;
    const last = Number(localStorage.getItem(key) || 0);
    if (Date.now() - last < 1000 * 60 * 20) return;
    localStorage.setItem(key, String(Date.now()));
    const message = `${appointment.patientName || "Paciente"} a las ${formatTime(appointment.startsAt)}`;
    showToast(`Recordatorio: ${message}`, "success");
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("OptiCore · Cita próxima", { body: message });
    }
  });
}

function dueAppointments() {
  const now = new Date();
  return visibleRows("appointments").filter((appointment) => {
    if (["Completada", "Cancelada"].includes(appointment.status)) return false;
    const start = new Date(appointment.startsAt);
    const minutes = Number(appointment.reminderMinutes || 60);
    return start >= now && start - now <= minutes * 60 * 1000;
  });
}

async function seedInitialData() {
  const batch = writeBatch(db);
  BRANCHES.forEach((branch, index) => {
    const doctorRef = doc(collection(db, "doctors"));
    batch.set(doctorRef, {
      name: ["Dr. Arturo Alcalá", "Dra. Valeria Ortiz", "Dra. Lupita Ramos"][index],
      phone: ["5511223344", "5544332211", "5599887766"][index],
      branch,
      specialty: "Optometría",
      active: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  });

  [
    { name: "Roberto Gómez", phone: "5511223344", branch: "Alcalá", lens: "Monofocal" },
    { name: "Ana Martínez", phone: "5544332211", branch: "Ortiz", lens: "Progresivo" },
    { name: "María López", phone: "5588776655", branch: "Lupitas", lens: "Ocupacional" }
  ].forEach((patient) => {
    const patientRef = doc(collection(db, "patients"));
    batch.set(patientRef, {
      name: patient.name,
      phone: patient.phone,
      email: "",
      branch: patient.branch,
      medical: {
        diabetes: false,
        hypertension: false,
        allergies: "",
        medications: "",
        surgery: "",
        eyeDisease: "",
        familyHistory: "",
        screenHours: "6 horas"
      },
      lensUse: {
        useCase: "Uso diario",
        type: patient.lens,
        material: "Policarbonato",
        antiReflective: true,
        blueFilter: false,
        photochromic: false
      },
      notes: "Registro inicial de demostración.",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  });

  [
    { name: "Ray-Ban Wayfarer", category: "Armazón", branch: "Alcalá", price: 3450, cost: 1850, stock: 8, minStock: 3 },
    { name: "Oakley Gascan", category: "Armazón", branch: "Alcalá", price: 2900, cost: 1550, stock: 3, minStock: 4 },
    { name: "Mica policarbonato AR", category: "Mica", branch: "Ortiz", price: 1200, cost: 520, stock: 18, minStock: 6 },
    { name: "Tratamiento filtro azul", category: "Tratamiento", branch: "Lupitas", price: 650, cost: 180, stock: 25, minStock: 8 }
  ].forEach((product) => {
    const productRef = doc(collection(db, "inventory"));
    batch.set(productRef, {
      ...product,
      active: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  });

  await batch.commit();
}

function refreshPatientsOnly() {
  const list = document.getElementById("clientList");
  const detail = document.getElementById("clientDetail");
  if (!list || !detail) return;
  const patients = filteredPatients();
  const selected = selectedPatient(patients);
  list.innerHTML = patients.length ? patients.map(patientCard).join("") : emptyState("No encontré pacientes con ese filtro.");
  detail.innerHTML = selected ? patientDetail(selected) : emptyState("Selecciona un paciente para ver su expediente.");
  renderIcons();
}

function filteredPatients() {
  const term = normalize(state.filters.patientSearch);
  return visibleRows("patients").filter((patient) => !term || normalize(`${patient.name} ${patient.phone} ${patient.email}`).includes(term));
}

function selectedPatient(rows = visibleRows("patients")) {
  if (!rows.length) return null;
  const selected = rows.find((patient) => patient.id === state.selectedPatientId);
  if (selected) return selected;
  state.selectedPatientId = rows[0].id;
  return rows[0];
}

function latestExam(patientId) {
  return state.data.exams
    .filter((exam) => exam.patientId === patientId)
    .sort((a, b) => dateValue(b.createdAt) - dateValue(a.createdAt))[0];
}

function latestSale(patientId) {
  return state.data.sales
    .filter((sale) => sale.patientId === patientId)
    .sort((a, b) => dateValue(b.createdAt) - dateValue(a.createdAt))[0];
}

function nextAppointment(patientId) {
  const now = new Date();
  return state.data.appointments
    .filter((appointment) => appointment.patientId === patientId && !["Completada", "Cancelada"].includes(appointment.status))
    .filter((appointment) => new Date(appointment.startsAt) >= now)
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))[0];
}

function nextAnnualReview(patientId) {
  const today = toDateInput(new Date());
  return state.data.followUps
    .filter((item) => item.patientId === patientId && item.type === "annualReview" && item.done !== true)
    .filter((item) => !item.dueDate || item.dueDate >= today)
    .sort((a, b) => String(a.dueDate || "").localeCompare(String(b.dueDate || "")))[0];
}

function visibleRows(collectionName) {
  const rows = state.data[collectionName] || [];
  if (isAdmin() && state.branch === "Global") return rows;
  const branch = isAdmin() ? state.branch : state.profile?.branch;
  return rows.filter((row) => !row.branch || row.branch === branch);
}

function isAdmin() {
  return state.profile?.role === "Administrador";
}

function currentWriteBranch() {
  if (!isAdmin()) return state.profile?.branch || "Alcalá";
  return state.branch === "Global" ? "Alcalá" : state.branch;
}

function branchSelect(name, selected, includeGlobal = false) {
  const options = (includeGlobal ? ["Global"].concat(BRANCHES) : BRANCHES)
    .map((branch) => `<option value="${branch}" ${branch === selected ? "selected" : ""}>${branch === "Global" ? "Vista global" : branch}</option>`);
  return `<select class="select" name="${name}">${options.join("")}</select>`;
}

function yesNoSelect(name, selected) {
  return `<select class="select" name="${name}"><option value="false" ${selected ? "" : "selected"}>No</option><option value="true" ${selected ? "selected" : ""}>Sí</option></select>`;
}

function activeSelect(name, selected) {
  return `<select class="select" name="${name}"><option value="true" ${selected ? "selected" : ""}>Activo</option><option value="false" ${selected ? "" : "selected"}>Inactivo</option></select>`;
}

function lensTypeSelect(name, selected = "Monofocal") {
  return `<select class="select" name="${name}">${optionList(["Monofocal", "Bifocal", "Progresivo", "Ocupacional", "Lectura", "Sol graduado"], selected)}</select>`;
}

function materialSelect(name, selected = "Policarbonato") {
  return `<select class="select" name="${name}">${optionList(["CR-39", "Policarbonato", "High Index", "Trivex", "Cristal"], selected)}</select>`;
}

function patientOptions(patients, selected) {
  return `<option value="">Selecciona</option>${patients.map((patient) => `<option value="${patient.id}" ${patient.id === selected ? "selected" : ""}>${escapeHtml(patient.name || "Paciente")}</option>`).join("")}`;
}

function doctorOptions(doctors, selected) {
  return `<option value="">Sin asignar</option>${doctors.filter((doctor) => doctor.active !== false).map((doctor) => `<option value="${doctor.id}" ${doctor.id === selected ? "selected" : ""}>${escapeHtml(doctor.name || "Doctor")}</option>`).join("")}`;
}

function optionList(values, selected, labeler = (value) => value) {
  return values.map((value) => `<option value="${escapeAttr(value)}" ${String(value) === String(selected) ? "selected" : ""}>${escapeHtml(labeler(value))}</option>`).join("");
}

function badgeClass(status) {
  return STATUS_BADGE[status] || "badge gray";
}

function emptyState(message) {
  return `<div class="empty">${escapeHtml(message)}</div>`;
}

function yesNo(value) {
  return value ? "Sí" : "No";
}

function clean(value) {
  return String(value || "").trim();
}

function normalize(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function phoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function whatsAppNumber(value) {
  const digits = phoneDigits(value);
  if (digits.length === 10) return `52${digits}`;
  return digits;
}

function appointmentWhatsAppUrl(appointment, patient = {}) {
  const number = whatsAppNumber(patient.phone || "");
  const date = formatDate(appointment.startsAt);
  const time = formatTime(appointment.startsAt);
  const message = `Hola ${patient.name || appointment.patientName || ""}, te recordamos tu cita en ${appointment.branch || "la óptica"} el ${date} a las ${time}.`;
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

function patientAge(birthDate) {
  if (!birthDate) return "";
  const birth = new Date(`${birthDate}T12:00:00`);
  if (Number.isNaN(birth.getTime())) return "";
  const today = new Date();
  let years = today.getFullYear() - birth.getFullYear();
  const beforeBirthday = today.getMonth() < birth.getMonth() || (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate());
  if (beforeBirthday) years -= 1;
  return years >= 0 ? `${years} años` : "";
}

function healthRiskLabels(patient = {}) {
  const medical = patient.medical || {};
  return [
    medical.diabetes ? "diabetes" : "",
    medical.hypertension ? "hipertensión" : "",
    medical.surgery ? "cirugía ocular" : "",
    medical.eyeDisease ? "enfermedad ocular" : "",
    medical.familyHistory ? "antecedentes familiares" : "",
    medical.medications ? "medicación activa" : ""
  ].filter(Boolean);
}

function firstName(name) {
  return String(name || "").split(" ")[0] || "equipo";
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Buenos días";
  if (hour < 19) return "Buenas tardes";
  return "Buenas noches";
}

function dateValue(value) {
  if (!value) return new Date(0);
  if (value.toDate) return value.toDate();
  if (typeof value === "object" && Number.isFinite(value.seconds)) return new Date(value.seconds * 1000);
  return new Date(value);
}

function daysBetween(a, b) {
  return Math.abs(a.getTime() - dateValue(b).getTime()) / 86400000;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toDateInput(date) {
  const value = new Date(date);
  const offset = value.getTimezoneOffset() * 60000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 10);
}

function toDateTimeInput(date) {
  const value = new Date(date);
  const offset = value.getTimezoneOffset() * 60000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function defaultDateTimeLocal() {
  const value = new Date();
  value.setMinutes(value.getMinutes() + 60);
  value.setMinutes(Math.ceil(value.getMinutes() / 15) * 15);
  const offset = value.getTimezoneOffset() * 60000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function formatLongDate(value) {
  return new Intl.DateTimeFormat("es-MX", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(value);
}

function formatDate(value) {
  const date = dateValue(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("es-MX", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("es-MX", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function currency(value) {
  return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(Number(value || 0));
}

function moneyValue(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function orderBalance(order) {
  if (Number.isFinite(Number(order.balance))) return Math.max(0, Number(order.balance));
  return Math.max(0, Number(order.total || 0) - Number(order.deposit || 0));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function readableError(error) {
  const code = error?.code || "";
  const map = {
    "auth/invalid-credential": "Correo o contraseña incorrectos.",
    "auth/email-already-in-use": "Ese correo ya está registrado.",
    "auth/weak-password": "La contraseña debe tener al menos 6 caracteres.",
    "auth/requires-recent-login": "Vuelve a iniciar sesión para cambiar la contraseña.",
    "permission-denied": "Permiso denegado. Revisa que tu usuario tenga rol Administrador y que las reglas de Firestore estén publicadas."
  };
  return map[code] || error?.message || "Ocurrió un error.";
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    })
  ]);
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.dataset.originalText ||= button.innerHTML;
  button.innerHTML = busy ? `<i data-lucide="loader-2"></i> Guardando` : button.dataset.originalText;
  renderIcons();
}

function showToast(message, type = "") {
  if (!toastHost) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`.trim();
  toast.textContent = message;
  toastHost.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 4200);
}

function renderIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}
