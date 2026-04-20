// =========================================================
// 📱 IDBot – Chatbot de WhatsApp con flujo conversacional
// Node.js 22 con ESM y Firebase Functions
// =========================================================

import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";
import axios from "axios";
import mysql from "mysql2/promise";
import nodemailer from "nodemailer";

// =========================================================
// 🔐 SECRETS
// =========================================================

const VERIFY_TOKEN = defineSecret("VERIFY_TOKEN_IDBOT");
const WHATSAPP_TOKEN = defineSecret("WHATSAPP_TOKEN_IDBOT");
const WHATSAPP_PHONE_NUMBER_ID = defineSecret("WHATSAPP_PHONE_NUMBER_ID_IDBOT");

const DB_HOST = defineSecret("DB_HOST_IDBOT");
const DB_USER = defineSecret("DB_USER_IDBOT");
const DB_PASSWORD = defineSecret("DB_PASSWORD_IDBOT");
const DB_NAME = defineSecret("DB_NAME_IDBOT");

// =========================================================
// 🗄️ CONEXIÓN A MYSQL (Pool Lazy)
// =========================================================

let pool = null;
function getPool(cfg) {
  if (!pool) {
    pool = mysql.createPool({
      host: cfg.DB_HOST,
      user: cfg.DB_USER,
      password: cfg.DB_PASSWORD,
      database: cfg.DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      timezone: "Z",
    });
  }
  return pool;
}

// =========================================================
// 📋 MIGRACIÓN AUTOMÁTICA
// =========================================================

async function ensureColumns(db) {
  // ── users ──
  const [uCols] = await db.execute(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'"
  );
  const uSet = new Set(uCols.map((r) => r.COLUMN_NAME));
  if (!uSet.has("phone"))
    await db.execute("ALTER TABLE users ADD COLUMN phone VARCHAR(20) UNIQUE AFTER id");
  if (!uSet.has("state"))
    await db.execute("ALTER TABLE users ADD COLUMN state VARCHAR(50) NOT NULL DEFAULT 'WAITING_NAME'");
  if (!uSet.has("chosen_option"))
    await db.execute("ALTER TABLE users ADD COLUMN chosen_option VARCHAR(10) DEFAULT NULL");
  if (!uSet.has("event_name"))
    await db.execute("ALTER TABLE users ADD COLUMN event_name VARCHAR(255) DEFAULT NULL");
  if (!uSet.has("appointment_interest"))
    await db.execute("ALTER TABLE users ADD COLUMN appointment_interest VARCHAR(255) DEFAULT NULL");
  if (!uSet.has("appointment_mode"))
    await db.execute("ALTER TABLE users ADD COLUMN appointment_mode VARCHAR(20) DEFAULT NULL");
  if (!uSet.has("appointment_date"))
    await db.execute("ALTER TABLE users ADD COLUMN appointment_date DATE DEFAULT NULL");
  if (!uSet.has("appointment_time"))
    await db.execute("ALTER TABLE users ADD COLUMN appointment_time TIME DEFAULT NULL");

  // ── works: asegurar columna pdf_url ──
  const [wCols] = await db.execute(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'works'"
  );
  const wSet = new Set(wCols.map((r) => r.COLUMN_NAME));
  if (!wSet.has("pdf_url"))
    await db.execute("ALTER TABLE works ADD COLUMN pdf_url VARCHAR(500) DEFAULT NULL");

  // ── appointments ──
  await db.execute(
    "CREATE TABLE IF NOT EXISTS appointments (" +
      "id INT(11) NOT NULL AUTO_INCREMENT," +
      "user_id INT(11) NOT NULL," +
      "phone VARCHAR(20) NOT NULL," +
      "name VARCHAR(255) DEFAULT NULL," +
      "email VARCHAR(255) DEFAULT NULL," +
      "company VARCHAR(255) DEFAULT NULL," +
      "event_name VARCHAR(255) DEFAULT NULL," +
      "interest VARCHAR(255) NOT NULL," +
      "mode VARCHAR(20) NOT NULL DEFAULT 'PRESENCIAL'," +
      "appointment_at DATETIME NOT NULL," +
      "meeting_link VARCHAR(500) DEFAULT NULL," +
      "status VARCHAR(50) NOT NULL DEFAULT 'SCHEDULED'," +
      "created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP," +
      "PRIMARY KEY (id)," +
      "KEY user_id (user_id)," +
      "CONSTRAINT appointments_ibfk_1 FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci"
  );

  const [aCols] = await db.execute(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'appointments'"
  );
  const aSet = new Set(aCols.map((r) => r.COLUMN_NAME));
  if (!aSet.has("mode")) {
    await db.execute("ALTER TABLE appointments ADD COLUMN mode VARCHAR(20) NOT NULL DEFAULT 'PRESENCIAL' AFTER interest");
  }
  if (!aSet.has("meeting_link")) {
    await db.execute("ALTER TABLE appointments ADD COLUMN meeting_link VARCHAR(500) DEFAULT NULL AFTER appointment_at");
  }
}

// =========================================================
// 💬 FUNCIONES DE ENVÍO – WHATSAPP GRAPH API v20.0
// =========================================================

const graphUrl = (phoneNumberId) =>
  `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

// Texto simple
async function sendText(wa, text) {
  await axios.post(
    graphUrl(wa.phoneNumberId),
    { messaging_product: "whatsapp", to: wa.to, type: "text", text: { body: text } },
    { headers: headers(wa.token), timeout: 15000 }
  );
}

// Botones interactivos (máx. 3 botones)
async function sendButtons(wa, bodyText, buttons) {
  await axios.post(
    graphUrl(wa.phoneNumberId),
    {
      messaging_product: "whatsapp",
      to: wa.to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: buttons.map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    },
    { headers: headers(wa.token), timeout: 15000 }
  );
}

// Lista interactiva (para seleccionar works)
async function sendList(wa, bodyText, buttonLabel, sections) {
  await axios.post(
    graphUrl(wa.phoneNumberId),
    {
      messaging_product: "whatsapp",
      to: wa.to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: bodyText },
        action: {
          button: buttonLabel,
          sections,
        },
      },
    },
    { headers: headers(wa.token), timeout: 15000 }
  );
}

// Tarjeta de contacto
async function sendContact(wa) {
  await axios.post(
    graphUrl(wa.phoneNumberId),
    {
      messaging_product: "whatsapp",
      to: wa.to,
      type: "contacts",
      contacts: [
        {
          name: {
            formatted_name: "Andy Raso",
            first_name: "Andy",
            last_name: "Raso",
          },
          phones: [
            {
              phone: "+5214422198567",
              wa_id: "5214422198567",
              type: "CELL",
            },
          ],
        },
      ],
    },
    { headers: headers(wa.token), timeout: 15000 }
  );
}

// Documento (PDF por URL)
async function sendDocument(wa, url, filename, caption) {
  await axios.post(
    graphUrl(wa.phoneNumberId),
    {
      messaging_product: "whatsapp",
      to: wa.to,
      type: "document",
      document: { link: url, filename, caption },
    },
    { headers: headers(wa.token), timeout: 15000 }
  );
}

function getEmailTransporter() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;

  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

async function sendAppointmentConfirmationEmail({
  to,
  name,
  interest,
  mode,
  displayDate,
  displayTime,
  eventName,
}) {
  if (!to) return false;

  const transporter = getEmailTransporter();
  if (!transporter) return false;

  const fromAddress = process.env.SMTP_FROM || process.env.SMTP_USER;
  const modeLabel = mode === "MEET" ? "Google Meet" : "Presencial";
  const meetLine =
    mode === "MEET"
      ? "Modalidad Meet: el enlace se compartirá por este mismo correo previo a la reunión."
      : "Modalidad presencial: nuestro equipo te compartirá la ubicación y recomendaciones previas.";

  const subject = `Confirmación de cita - ${displayDate} ${displayTime}`;
  const textBody =
    `Hola ${name || ""},\n\n` +
    "Tu cita ha sido registrada correctamente con estos datos:\n" +
    `Interés: ${interest}\n` +
    `Modalidad: ${modeLabel}\n` +
    `Fecha: ${displayDate}\n` +
    `Hora: ${displayTime}\n` +
    `${eventName ? `Evento: ${eventName}\n` : ""}` +
    `${meetLine}\n\n` +
    "Gracias por tu interés. Te esperamos.\nIDBot";

  await transporter.sendMail({
    from: fromAddress,
    to,
    subject,
    text: textBody,
  });

  return true;
}

// =========================================================
// 🤖 MENSAJES DEL BOT
// =========================================================

const GREETING_MSG =
  "¡Hola! 👋 ¡Yo soy IDbot! y seguramente estás con mi sensei y amigo " +
  "Andrés Raso (le gusta que le digan Andy, el nickname que le puso su papá " +
  "desde que tiene memoria).\n\n" +
  "Te voy a compartir el portafolio de nuestra marca por este medio o si " +
  "gustas su número de celular directo.\n\n" +
  "¿Con quién tengo el gusto? (Nombre y Apellido)";

const OFFICE_ADDRESS =
  "Av. Paseo de la Constitución 100-int 3, Villas del Parque, 76140 Santiago de Querétaro, Qro.";

const OFFICE_MAPS_URL =
  "https://www.google.com/maps/search/?api=1&query=Av.+Paseo+de+la+Constitucion+100-int+3,+Villas+del+Parque,+76140+Santiago+de+Queretaro,+Qro";

function farewellMsg(name) {
  return (
    `Quedo a tus órdenes *${name}*, cuando necesites alguna de las soluciones ` +
    "que manejamos, para activarme solo envía un *hola* y yo con gusto te atenderé.\n\n" +
    "Mi nombre es *IDbot* 🤖"
  );
}

// =========================================================
// 🔄 HELPERS
// =========================================================

function isGreeting(text) {
  const normalized = normalizeText(text);
  const greetings = ["hola", "hi", "hello", "buenas", "hey"];
  return greetings.some((greeting) => normalized === greeting || normalized.startsWith(`${greeting} `));
}

function normalizeText(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasIdInterest(text) {
  const normalized = normalizeText(text);
  const directKeywords = [
    "id human",
    "id residencial",
    "id financiero",
    "ejercito digital",
  ];

  if (directKeywords.some((keyword) => normalized.includes(keyword))) {
    return true;
  }

  // Detecta frases del tipo "... ID <algo>" para no depender de una lista fija.
  return /\bid\s+[a-z0-9]+(?:\s+[a-z0-9]+){0,2}\b/.test(normalized);
}

function shouldRestartFlow(text) {
  return isGreeting(text) || hasIdInterest(text);
}

async function sendMainOptions(wa, greeting) {
  await sendButtons(wa, greeting, [
    { id: "opt_contacto", title: "📞 Contacto de Andy" },
    { id: "opt_portafolio", title: "📂 Portafolio" },
    { id: "opt_cita", title: "📅 Asignar una cita" },
  ]);
}

async function sendAppointmentModeOptions(wa) {
  await sendButtons(
    wa,
    "Perfecto. ¿Cómo prefieres tu cita?",
    [
      { id: "appt_mode_presencial", title: "🏢 Presencial" },
      { id: "appt_mode_meet", title: "💻 Google Meet" },
    ]
  );
}

function parseDateInput(text) {
  const raw = text.trim();

  let year;
  let month;
  let day;

  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    year = Number(isoMatch[1]);
    month = Number(isoMatch[2]);
    day = Number(isoMatch[3]);
  } else {
    const latamMatch = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!latamMatch) return null;
    day = Number(latamMatch[1]);
    month = Number(latamMatch[2]);
    year = Number(latamMatch[3]);
  }

  const date = new Date(year, month - 1, day);
  const isValid =
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day;

  if (!isValid) return null;

  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return {
    date,
    sqlDate: `${year}-${mm}-${dd}`,
    displayDate: `${dd}/${mm}/${year}`,
  };
}

function parseTimeInput(text) {
  const raw = text.trim();
  const match = raw.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const isBusinessHour = hour >= 9 && (hour < 19 || (hour === 19 && minute === 0));
  if (!isBusinessHour) return null;

  return {
    hour,
    minute,
    displayTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

function validateAppointmentSlot(date, hour, minute) {
  const weekday = date.getDay();
  const isWeekday = weekday >= 1 && weekday <= 5;
  if (!isWeekday) {
    return { valid: false, reason: "WEEKEND" };
  }

  const isBusinessHour = hour >= 9 && (hour < 19 || (hour === 19 && minute === 0));
  if (!isBusinessHour) {
    return { valid: false, reason: "OUT_OF_HOURS" };
  }

  const slotDateTime = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    hour,
    minute,
    0,
    0
  );
  if (slotDateTime.getTime() <= Date.now()) {
    return { valid: false, reason: "PAST" };
  }

  return { valid: true };
}

function parseSqlTimeParts(value) {
  if (!value) return null;
  const normalized = String(value).slice(0, 8);
  const match = normalized.match(/^(\d{2}):(\d{2})(?::\d{2})?$/);
  if (!match) return null;

  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
}

function parseAppointmentMode(buttonId, text) {
  if (buttonId === "appt_mode_presencial") return "PRESENCIAL";
  if (buttonId === "appt_mode_meet") return "MEET";

  const normalized = normalizeText(text || "");
  if (normalized.includes("presencial")) return "PRESENCIAL";
  if (normalized.includes("meet") || normalized.includes("google meet") || normalized.includes("virtual")) {
    return "MEET";
  }
  return null;
}

function toSqlTimeString(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 8);
  if (value instanceof Date) {
    const hh = String(value.getHours()).padStart(2, "0");
    const mm = String(value.getMinutes()).padStart(2, "0");
    const ss = String(value.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }
  return null;
}

function toSqlDateString(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date) {
    const yyyy = value.getFullYear();
    const mm = String(value.getMonth() + 1).padStart(2, "0");
    const dd = String(value.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}

async function startAppointmentFlow(db, wa, from, defaultInterest = "") {
  if (defaultInterest) {
    await db.execute(
      "UPDATE users SET state = 'WAITING_APPOINTMENT_MODE', appointment_interest = ?, appointment_mode = NULL, appointment_date = NULL, appointment_time = NULL WHERE phone = ?",
      [defaultInterest, from]
    );
    await sendText(
      wa,
      `Excelente, te ayudo a agendar una cita para *${defaultInterest}* ✅\n\n` +
        "Horario disponible: *lunes a viernes de 9:00 a 19:00 hrs*."
    );
    await sendAppointmentModeOptions(wa);
    return;
  }

  await db.execute(
    "UPDATE users SET state = 'WAITING_APPOINTMENT_INTEREST', appointment_interest = NULL, appointment_mode = NULL, appointment_date = NULL, appointment_time = NULL WHERE phone = ?",
    [from]
  );
  await sendText(
    wa,
    "¡Claro! Podemos asignar una cita para mostrarte un proyecto en específico ✅\n\n" +
      "Horario disponible: *lunes a viernes de 9:00 a 19:00 hrs*.\n\n" +
      "¿Qué proyecto o solución te interesa conocer?"
  );
}

async function sendWorksList(db, wa) {
  const [works] = await db.execute("SELECT id, name, description FROM works ORDER BY id");

  if (works.length === 0) {
    await sendText(wa, "Por el momento no tenemos portafolios disponibles. ¡Pronto los tendremos!");
    return;
  }

  const rows = works.map((w) => ({
    id: `work_${w.id}`,
    title: w.name.substring(0, 24),
    description: (w.description || "").substring(0, 72),
  }));

  await sendList(
    wa,
    "Estos son los portafolios que tenemos disponibles.\n\nSelecciona el que te gustaría conocer:",
    "📂 Ver portafolios",
    [{ title: "Portafolios", rows }]
  );
}

// =========================================================
// 🧠 MÁQUINA DE ESTADOS – FLUJO CONVERSACIONAL
// =========================================================
//
// PRIMER FLUJO (usuario nuevo):
//   WAITING_NAME → WAITING_EMAIL → WAITING_EVENT → WAITING_COMPANY → WAITING_OPTION → ...
//
// SEGUNDO FLUJO (usuario recurrente dice "hola" o escribe interés como "ID Human"):
//   → directo a WAITING_OPTION (ya tiene nombre/email/empresa)
//
// Opción A (contacto): WAITING_OPTION → envía contacto → DONE
// Opción B (portafolio): WAITING_OPTION → WAITING_WORK → envía PDF → WAITING_MORE → ...
// Opción C (cita): WAITING_OPTION/WAITING_MORE → flujo de cita → DONE
//

async function processMessage(db, from, msgType, payload, wa) {
  await ensureColumns(db);

  // Extraer texto o ID de botón/lista según tipo
  let text = "";
  let buttonId = "";

  if (msgType === "text") {
    text = payload.body.trim();
  } else if (msgType === "interactive") {
    if (payload.type === "button_reply") {
      buttonId = payload.button_reply.id;
      text = payload.button_reply.title;
    }
    if (payload.type === "list_reply") {
      buttonId = payload.list_reply.id;
      text = payload.list_reply.title;
    }
  }

  // ── Obtener usuario existente ──
  const [rows] = await db.execute("SELECT * FROM users WHERE phone = ?", [from]);

  // ── Usuario nuevo → crear + saludo ──
  if (rows.length === 0) {
    await db.execute("INSERT INTO users (phone, state) VALUES (?, 'WAITING_NAME')", [from]);
    await sendText(wa, GREETING_MSG);
    return;
  }

  const user = rows[0];

  // ── "Hola" → usuario recurrente directo a opciones / nuevo pide nombre ──
  if (msgType === "text" && shouldRestartFlow(text)) {
    if (user.name && user.email && user.company) {
      // Usuario completo → directo a opciones
      await db.execute(
        "UPDATE users SET state = 'WAITING_OPTION', chosen_option = NULL, appointment_interest = NULL, appointment_mode = NULL, appointment_date = NULL, appointment_time = NULL WHERE phone = ?",
        [from]
      );
      await sendMainOptions(
        wa,
        `¡Hola de nuevo *${user.name}*! 👋 Qué gusto verte por aquí otra vez.\n\n¿Qué te gustaría hacer?`
      );
    } else {
      // Datos incompletos → reiniciar registro
      await db.execute(
        "UPDATE users SET state='WAITING_NAME', chosen_option=NULL, appointment_interest = NULL, appointment_mode = NULL, appointment_date = NULL, appointment_time = NULL WHERE phone = ?",
        [from]
      );
      await sendText(wa, GREETING_MSG);
    }
    return;
  }

  // ── Si ya terminó, recordar ──
  if (user.state === "DONE") {
    await sendText(wa, "Para activarme envía un *hola* o escribe la solución que te interesa (por ejemplo: *ID Human*) 🤖");
    return;
  }

  // ── Procesar según estado ──
  switch (user.state) {
    // ───────────────────────────────────────────
    // 1. Esperando nombre
    // ───────────────────────────────────────────
    case "WAITING_NAME": {
      if (msgType !== "text") {
        await sendText(wa, "Por favor escríbeme tu nombre y apellido 😊");
        return;
      }
      await db.execute("UPDATE users SET name = ?, state = 'WAITING_EMAIL' WHERE phone = ?", [text, from]);
      await sendText(wa, `Mucho gusto *${text}* 😊\n\n¿Cuál es tu correo electrónico? 📧`);
      break;
    }

    // ───────────────────────────────────────────
    // 2. Esperando email
    // ───────────────────────────────────────────
    case "WAITING_EMAIL": {
      if (msgType !== "text") {
        await sendText(wa, "Por favor escríbeme tu correo electrónico 📧");
        return;
      }
      await db.execute("UPDATE users SET email = ?, state = 'WAITING_EVENT' WHERE phone = ?", [text, from]);
      await sendText(wa, "¡Gracias! ¿En qué evento se encuentran en este momento? 📍");
      break;
    }

    // ───────────────────────────────────────────
    // 3. Esperando evento
    // ───────────────────────────────────────────
    case "WAITING_EVENT": {
      if (msgType !== "text") {
        await sendText(wa, "Por favor escríbeme el nombre del evento 📝");
        return;
      }
      await db.execute("UPDATE users SET event_name = ?, state = 'WAITING_COMPANY' WHERE phone = ?", [text, from]);
      await sendText(wa, "¿A qué se dedica tu empresa?");
      break;
    }

    // ───────────────────────────────────────────
    // 4. Esperando empresa → mostrar opciones
    // ───────────────────────────────────────────
    case "WAITING_COMPANY": {
      if (msgType !== "text") {
        await sendText(wa, "Por favor escríbeme a qué se dedica tu empresa 📝");
        return;
      }
      await db.execute("UPDATE users SET company = ?, state = 'WAITING_OPTION' WHERE phone = ?", [text, from]);
      await sendMainOptions(
        wa,
        `¡Perfecto *${user.name}*! 🙌\n\n¿Qué te gustaría hacer?`
      );
      break;
    }

    // ───────────────────────────────────────────
    // 5. Esperando opción (botón contacto/portafolio)
    // ───────────────────────────────────────────
    case "WAITING_OPTION": {
      if (buttonId === "opt_contacto") {
        // ── Opción A: Contacto de Andy ──
        await db.execute("UPDATE users SET chosen_option = 'a', state = 'WAITING_AFTER_CONTACT' WHERE phone = ?", [from]);
        await sendText(
          wa,
          `Te comparto el contacto de Andy Raso 📱\n\nEnvíale un mensaje para que te guarde en su agenda VIP.`
        );
        await sendContact(wa);
        await sendButtons(wa, "¿Qué quieres hacer ahora?", [
          { id: "after_contact_portafolio", title: "📂 Ver portafolio" },
          { id: "after_contact_cita", title: "📅 Agendar cita" },
        ]);
      } else if (buttonId === "opt_portafolio") {
        // ── Opción B: Portafolio ──
        await db.execute("UPDATE users SET chosen_option = 'b', state = 'WAITING_WORK' WHERE phone = ?", [from]);
        await sendWorksList(db, wa);
      } else if (buttonId === "opt_cita") {
        // ── Opción C: Asignar cita ──
        await db.execute("UPDATE users SET chosen_option = 'c' WHERE phone = ?", [from]);
        await startAppointmentFlow(db, wa, from);
      } else if (msgType === "text" && hasIdInterest(text)) {
        // Si el usuario escribe "ID Human/Residencial/Financiero", llevarlo directo a portafolios.
        await db.execute("UPDATE users SET chosen_option = 'b', state = 'WAITING_WORK' WHERE phone = ?", [from]);
        await sendWorksList(db, wa);
      } else {
        await sendMainOptions(wa, "Por favor selecciona una de las opciones:");
      }
      break;
    }

    // ───────────────────────────────────────────
    // 5.1 Después de compartir contacto
    // ───────────────────────────────────────────
    case "WAITING_AFTER_CONTACT": {
      if (buttonId === "after_contact_portafolio") {
        await db.execute("UPDATE users SET chosen_option = 'b', state = 'WAITING_WORK' WHERE phone = ?", [from]);
        await sendWorksList(db, wa);
      } else if (buttonId === "after_contact_cita") {
        await db.execute("UPDATE users SET chosen_option = 'c' WHERE phone = ?", [from]);
        await startAppointmentFlow(db, wa, from);
      } else {
        await sendButtons(wa, "¿Qué quieres hacer ahora?", [
          { id: "after_contact_portafolio", title: "📂 Ver portafolio" },
          { id: "after_contact_cita", title: "📅 Agendar cita" },
        ]);
      }
      break;
    }

    // ───────────────────────────────────────────
    // 6. Esperando selección de work (portafolio)
    // ───────────────────────────────────────────
    case "WAITING_WORK": {
      if (buttonId && buttonId.startsWith("work_")) {
        const workId = parseInt(buttonId.replace("work_", ""), 10);
        const [works] = await db.execute("SELECT * FROM works WHERE id = ?", [workId]);

        if (works.length === 0) {
          await sendText(wa, "No encontré ese portafolio. Intenta de nuevo.");
          await sendWorksList(db, wa);
          return;
        }

        const work = works[0];

        // Primero enviar el PDF
        if (work.pdf_url) {
          await sendDocument(wa, work.pdf_url, `${work.name}.pdf`, `📄 ${work.name}\n\nCuando lo hayas revisado, envía cualquier mensaje para continuar.`);
        } else {
          await sendText(wa, `📄 *${work.name}*\n\n${work.description || "Sin descripción"}\n\n_(El PDF estará disponible pronto)_`);
        }

        // Cambiar estado pero NO enviar botones aún (evita que lleguen antes del PDF)
        await db.execute(
          "UPDATE users SET state = 'WAITING_MORE', appointment_interest = ? WHERE phone = ?",
          [work.name, from]
        );
      } else {
        await sendWorksList(db, wa);
      }
      break;
    }

    // ───────────────────────────────────────────
    // 7. ¿Quiere ver otro portafolio?
    // ───────────────────────────────────────────
    case "WAITING_MORE": {
      if (buttonId === "more_yes") {
        // Mostrar lista de works otra vez
        await db.execute("UPDATE users SET state = 'WAITING_WORK' WHERE phone = ?", [from]);
        await sendWorksList(db, wa);
      } else if (buttonId === "more_appointment") {
        await startAppointmentFlow(db, wa, from, user.appointment_interest || "");
      } else if (buttonId === "more_no") {
        // Despedida
        await db.execute("UPDATE users SET state = 'DONE' WHERE phone = ?", [from]);
        await sendText(
          wa,
          `Quedo a tus órdenes *${user.name}*, cuando necesites alguna de las soluciones ` +
            "que manejamos, para activarme solo envía un *hola* y yo con gusto te atenderé.\n\n" +
            "Mi nombre es *IDbot* 🤖\n\n" +
            "Puedes escribir *hola* cuando quieras volver a iniciar la conversación."
        );
      } else {
        // Usuario envió un mensaje después del PDF → ahora sí mostrar botones
        await sendButtons(wa, "¿Te gustaría ver algún otro portafolio o agendar una cita?", [
          { id: "more_yes", title: "✅ Sí" },
          { id: "more_appointment", title: "📅 Agendar cita" },
          { id: "more_no", title: "❌ No, gracias" },
        ]);
      }
      break;
    }

    // ───────────────────────────────────────────
    // 8. Esperando interés para la cita
    // ───────────────────────────────────────────
    case "WAITING_APPOINTMENT_INTEREST": {
      if (msgType !== "text" || !text) {
        await sendText(wa, "Por favor escríbeme qué proyecto o solución te interesa 😊");
        return;
      }

      await db.execute(
        "UPDATE users SET appointment_interest = ?, state = 'WAITING_APPOINTMENT_MODE' WHERE phone = ?",
        [text, from]
      );

      await sendText(
        wa,
        "Perfecto ✅ Ahora elige la modalidad de tu cita."
      );
      await sendAppointmentModeOptions(wa);
      break;
    }

    // ───────────────────────────────────────────
    // 9. Esperando modalidad para la cita
    // ───────────────────────────────────────────
    case "WAITING_APPOINTMENT_MODE": {
      const mode = parseAppointmentMode(buttonId, text);
      if (!mode) {
        await sendText(wa, "Por favor elige una modalidad: *Presencial* o *Google Meet*.");
        await sendAppointmentModeOptions(wa);
        return;
      }

      await db.execute(
        "UPDATE users SET appointment_mode = ?, state = 'WAITING_APPOINTMENT_DATE' WHERE phone = ?",
        [mode, from]
      );

      if (mode === "PRESENCIAL") {
        await sendText(
          wa,
          "Excelente, será una cita *presencial* 🙌\n\n" +
            `📍 Dirección: ${OFFICE_ADDRESS}\n` +
            `🗺️ Ubicación: ${OFFICE_MAPS_URL}\n\n` +
            "¡Te esperamos!"
        );
      }

      await sendText(
        wa,
        "Excelente. Ahora compárteme la fecha de tu cita en formato *DD/MM/AAAA* o *AAAA-MM-DD*."
      );
      break;
    }

    // ───────────────────────────────────────────
    // 10. Esperando fecha para la cita
    // ───────────────────────────────────────────
    case "WAITING_APPOINTMENT_DATE": {
      if (msgType !== "text") {
        await sendText(wa, "Por favor envíame la fecha en formato *DD/MM/AAAA* o *AAAA-MM-DD* 📅");
        return;
      }

      const parsedDate = parseDateInput(text);
      if (!parsedDate) {
        await sendText(wa, "No pude entender la fecha. Usa formato *DD/MM/AAAA* o *AAAA-MM-DD*.");
        return;
      }

      const today = new Date();
      const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const selectedOnly = new Date(
        parsedDate.date.getFullYear(),
        parsedDate.date.getMonth(),
        parsedDate.date.getDate()
      );
      if (selectedOnly < todayOnly) {
        await sendText(
          wa,
          "La fecha no puede ser en el pasado. Compárteme una fecha válida a partir de hoy."
        );
        return;
      }

      const weekday = parsedDate.date.getDay();
      const isWeekday = weekday >= 1 && weekday <= 5;
      if (!isWeekday) {
        await sendText(
          wa,
          "Esa fecha cae en fin de semana. Las citas son de *lunes a viernes* 🗓️\n\nCompárteme otra fecha."
        );
        return;
      }

      await db.execute(
        "UPDATE users SET appointment_date = ?, state = 'WAITING_APPOINTMENT_TIME' WHERE phone = ?",
        [parsedDate.sqlDate, from]
      );

      await sendText(
        wa,
        `¡Excelente! Para el *${parsedDate.displayDate}* ¿qué hora prefieres?\n\n` +
          "Envíala en formato *HH:MM* (24 horas).\n" +
          "Horario disponible: *09:00 a 19:00*"
      );
      break;
    }

    // ───────────────────────────────────────────
    // 11. Esperando hora para la cita
    // ───────────────────────────────────────────
    case "WAITING_APPOINTMENT_TIME": {
      if (msgType !== "text") {
        await sendText(wa, "Por favor escríbeme la hora en formato *HH:MM* (24 horas) ⏰");
        return;
      }

      const parsedTime = parseTimeInput(text);
      if (!parsedTime) {
        await sendText(
          wa,
          "La hora no es válida para agenda. Usa formato *HH:MM* entre *09:00 y 19:00* de lunes a viernes."
        );
        return;
      }

      if (!user.appointment_date) {
        await db.execute("UPDATE users SET state = 'WAITING_APPOINTMENT_DATE' WHERE phone = ?", [from]);
        await sendText(wa, "Necesito confirmar primero la fecha. Compártemela en formato *DD/MM/AAAA* o *AAAA-MM-DD*.");
        return;
      }

      const appointmentDate = toSqlDateString(user.appointment_date);
      if (!appointmentDate) {
        await db.execute("UPDATE users SET state = 'WAITING_APPOINTMENT_DATE' WHERE phone = ?", [from]);
        await sendText(wa, "No pude leer la fecha de la cita. Por favor compártemela de nuevo.");
        return;
      }

      const parsedDateFromDb = parseDateInput(appointmentDate);
      if (!parsedDateFromDb) {
        await db.execute("UPDATE users SET state = 'WAITING_APPOINTMENT_DATE', appointment_date = NULL WHERE phone = ?", [from]);
        await sendText(wa, "La fecha guardada no es válida. Por favor vuelve a compartirla.");
        return;
      }

      const slotValidation = validateAppointmentSlot(
        parsedDateFromDb.date,
        parsedTime.hour,
        parsedTime.minute
      );
      if (!slotValidation.valid) {
        if (slotValidation.reason === "WEEKEND") {
          await db.execute("UPDATE users SET state = 'WAITING_APPOINTMENT_DATE', appointment_date = NULL WHERE phone = ?", [from]);
          await sendText(wa, "La fecha de la cita cayó en fin de semana. Compárteme una nueva fecha de *lunes a viernes*.");
          return;
        }
        if (slotValidation.reason === "OUT_OF_HOURS") {
          await sendText(wa, "La hora está fuera del horario permitido. Usa *HH:MM* entre *09:00 y 19:00*.");
          return;
        }
        if (slotValidation.reason === "PAST") {
          await sendText(wa, "Esa hora ya pasó. Compárteme una hora futura en formato *HH:MM*.");
          return;
        }
      }

      const mode = user.appointment_mode || "PRESENCIAL";
      const interest = user.appointment_interest || "Proyecto por definir";

      await db.execute(
        "UPDATE users SET appointment_time = ?, state = 'WAITING_APPOINTMENT_CONFIRM' WHERE phone = ?",
        [`${parsedTime.displayTime}:00`, from]
      );

      const modeLabel = mode === "MEET" ? "Google Meet" : "Presencial";
      const [yyyy, mm, dd] = appointmentDate.split("-");
      await sendButtons(
        wa,
        "Por favor confirma tu cita:\n\n" +
          `Interés: *${interest}*\n` +
          `Modalidad: *${modeLabel}*\n` +
          `Fecha: *${dd}/${mm}/${yyyy}*\n` +
          `Hora: *${parsedTime.displayTime}*`,
        [
          { id: "appt_confirm_yes", title: "✅ Confirmar" },
          { id: "appt_confirm_no", title: "✏️ Editar" },
        ]
      );
      break;
    }

    // ───────────────────────────────────────────
    // 12. Confirmación final de cita
    // ───────────────────────────────────────────
    case "WAITING_APPOINTMENT_CONFIRM": {
      if (buttonId === "appt_confirm_no") {
        await db.execute("UPDATE users SET state = 'WAITING_APPOINTMENT_DATE', appointment_date = NULL, appointment_time = NULL WHERE phone = ?", [from]);
        await sendText(wa, "Perfecto, actualicemos la agenda. Compárteme de nuevo la fecha en formato *DD/MM/AAAA* o *AAAA-MM-DD*.");
        return;
      }

      if (buttonId !== "appt_confirm_yes") {
        await sendButtons(wa, "Para continuar, confirma si deseas guardar esta cita.", [
          { id: "appt_confirm_yes", title: "✅ Confirmar" },
          { id: "appt_confirm_no", title: "✏️ Editar" },
        ]);
        return;
      }

      const appointmentDate = toSqlDateString(user.appointment_date);
      const appointmentTime = toSqlTimeString(user.appointment_time);
      if (!appointmentDate || !appointmentTime) {
        await db.execute("UPDATE users SET state = 'WAITING_APPOINTMENT_DATE' WHERE phone = ?", [from]);
        await sendText(wa, "Necesito reconfirmar la fecha y hora de la cita. Empecemos por la fecha.");
        return;
      }

      const parsedDateFromDb = parseDateInput(appointmentDate);
      const parsedTimeFromDb = parseSqlTimeParts(appointmentTime);
      if (!parsedDateFromDb || !parsedTimeFromDb) {
        await db.execute("UPDATE users SET state = 'WAITING_APPOINTMENT_DATE', appointment_date = NULL, appointment_time = NULL WHERE phone = ?", [from]);
        await sendText(wa, "No pude validar la fecha y hora guardadas. Volvamos a agendar desde la fecha.");
        return;
      }

      const finalValidation = validateAppointmentSlot(
        parsedDateFromDb.date,
        parsedTimeFromDb.hour,
        parsedTimeFromDb.minute
      );
      if (!finalValidation.valid) {
        await db.execute("UPDATE users SET state = 'WAITING_APPOINTMENT_DATE', appointment_date = NULL, appointment_time = NULL WHERE phone = ?", [from]);

        if (finalValidation.reason === "WEEKEND") {
          await sendText(wa, "La fecha de la cita no puede ser fin de semana. Elige una fecha de *lunes a viernes*.");
          return;
        }
        if (finalValidation.reason === "OUT_OF_HOURS") {
          await sendText(wa, "La hora está fuera de horario. Agenda entre *09:00 y 19:00*.");
          return;
        }
        if (finalValidation.reason === "PAST") {
          await sendText(wa, "La cita quedó en el pasado. Vamos a reagendar con una fecha y hora futuras.");
          return;
        }
      }

      const appointmentAt = `${appointmentDate} ${appointmentTime}`;
      const interest = user.appointment_interest || "Proyecto por definir";
      const mode = user.appointment_mode || "PRESENCIAL";
      const meetingLink = mode === "MEET" ? null : null;

      await db.execute(
        "INSERT INTO appointments (user_id, phone, name, email, company, event_name, interest, mode, appointment_at, meeting_link) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          user.id,
          from,
          user.name,
          user.email,
          user.company,
          user.event_name,
          interest,
          mode,
          appointmentAt,
          meetingLink,
        ]
      );

      await db.execute(
        "UPDATE users SET state = 'DONE', appointment_interest = NULL, appointment_mode = NULL, appointment_date = NULL, appointment_time = NULL WHERE phone = ?",
        [from]
      );

      const [yyyy, mm, dd] = appointmentDate.split("-");
      const [hh, min] = appointmentTime.split(":");
      const modeLabel = mode === "MEET" ? "Google Meet" : "Presencial";

      let emailSent = false;
      try {
        emailSent = await sendAppointmentConfirmationEmail({
          to: user.email,
          name: user.name,
          interest,
          mode,
          displayDate: `${dd}/${mm}/${yyyy}`,
          displayTime: `${hh}:${min}`,
          eventName: user.event_name,
        });
      } catch (emailErr) {
        logger.error("Error enviando correo de cita:", emailErr?.message || emailErr);
      }

      await sendText(
        wa,
        "✅ *¡Cita agendada con éxito!*\n\n" +
          `Interés: *${interest}*\n` +
          `Modalidad: *${modeLabel}*\n` +
          `Fecha: *${dd}/${mm}/${yyyy}*\n` +
          `Hora: *${hh}:${min}*\n` +
          `${mode === "MEET" ? "Enlace Meet: *se enviará por correo previo a la cita*\n" : ""}\n` +
          `${emailSent ? "Te envié la confirmación a tu correo 📩\n\n" : ""}` +
          "Si deseas otro portafolio o agendar otra cita, envía *hola* o escribe la solución que te interesa."
      );
      break;
    }

    // ───────────────────────────────────────────
    // Estado desconocido → reiniciar con opciones
    // ───────────────────────────────────────────
    default: {
      if (user.name) {
        await db.execute("UPDATE users SET state = 'WAITING_OPTION' WHERE phone = ?", [from]);
        await sendMainOptions(wa, `*${user.name}*, ¿en qué te puedo ayudar?`);
      } else {
        await db.execute("UPDATE users SET state = 'WAITING_NAME' WHERE phone = ?", [from]);
        await sendText(wa, GREETING_MSG);
      }
      break;
    }
  }
}

// =========================================================
// 🚀 WEBHOOK PRINCIPAL
// =========================================================

export const whatsappWebhookIdBot = onRequest(
  {
    cors: true,
    region: "us-central1",
    secrets: [
      VERIFY_TOKEN, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
      DB_HOST, DB_USER, DB_PASSWORD, DB_NAME,
    ],
  },
  async (req, res) => {
    const cfg = {
      VERIFY_TOKEN: VERIFY_TOKEN.value(),
      WHATSAPP_TOKEN: WHATSAPP_TOKEN.value(),
      WHATSAPP_PHONE_NUMBER_ID: WHATSAPP_PHONE_NUMBER_ID.value(),
      DB_HOST: DB_HOST.value(),
      DB_USER: DB_USER.value(),
      DB_PASSWORD: DB_PASSWORD.value(),
      DB_NAME: DB_NAME.value(),
    };

    // === Verificación de Meta (GET) ===
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];
      return mode === "subscribe" && token === cfg.VERIFY_TOKEN
        ? res.status(200).send(challenge)
        : res.sendStatus(403);
    }

    // === Procesamiento de mensajes (POST) ===
    try {
      const body = req.body;
      logger.info("Webhook body", JSON.stringify(body));

      const statuses = body?.entry?.[0]?.changes?.[0]?.value?.statuses;
      if (Array.isArray(statuses) && statuses.length) return res.sendStatus(200);

      const messages = body?.entry?.[0]?.changes?.[0]?.value?.messages;
      const from = messages?.[0]?.from;
      if (!messages || !from) return res.sendStatus(200);

      const msg = messages[0];
      if (!msg) return res.sendStatus(200);

      const db = getPool(cfg);
      const wa = {
        to: from,
        token: cfg.WHATSAPP_TOKEN,
        phoneNumberId: cfg.WHATSAPP_PHONE_NUMBER_ID,
      };

      // Determinar tipo de mensaje y payload
      let msgType = msg.type;
      let payload;

      if (msgType === "text") {
        payload = msg.text;
      } else if (msgType === "interactive") {
        payload = msg.interactive;
      } else {
        // Tipo no soportado (imagen, audio, etc.)
        return res.sendStatus(200);
      }

      await processMessage(db, from, msgType, payload, wa);

      return res.sendStatus(200);
    } catch (err) {
      logger.error("Error webhook:", err?.response?.data || err);
      return res.sendStatus(200);
    }
  }
);