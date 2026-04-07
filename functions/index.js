// =========================================================
// 📱 IDBot – Chatbot de WhatsApp con flujo conversacional
// Node.js 22 con ESM y Firebase Functions
// =========================================================

import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";
import axios from "axios";
import mysql from "mysql2/promise";

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

  // ── works: asegurar columna pdf_url ──
  const [wCols] = await db.execute(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'works'"
  );
  const wSet = new Set(wCols.map((r) => r.COLUMN_NAME));
  if (!wSet.has("pdf_url"))
    await db.execute("ALTER TABLE works ADD COLUMN pdf_url VARCHAR(500) DEFAULT NULL");
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
  return ["hola", "hi", "hello", "buenas", "hey"].includes(text.toLowerCase().trim());
}

async function sendMainOptions(wa, greeting) {
  await sendButtons(wa, greeting, [
    { id: "opt_contacto", title: "📞 Contacto de Andy" },
    { id: "opt_portafolio", title: "📂 Portafolio" },
  ]);
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
// SEGUNDO FLUJO (usuario recurrente dice "hola"):
//   → directo a WAITING_OPTION (ya tiene nombre/email/empresa)
//
// Opción A (contacto): WAITING_OPTION → envía contacto → DONE
// Opción B (portafolio): WAITING_OPTION → WAITING_WORK → envía PDF → WAITING_MORE → ...
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

  const lower = text.toLowerCase();

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
  if (isGreeting(lower) && msgType === "text") {
    if (user.name && user.email && user.company) {
      // Usuario completo → directo a opciones
      await db.execute("UPDATE users SET state = 'WAITING_OPTION', chosen_option = NULL WHERE phone = ?", [from]);
      await sendMainOptions(
        wa,
        `¡Hola de nuevo *${user.name}*! 👋 Qué gusto verte por aquí otra vez.\n\n¿Qué te gustaría hacer?`
      );
    } else {
      // Datos incompletos → reiniciar registro
      await db.execute(
        "UPDATE users SET state='WAITING_NAME', chosen_option=NULL WHERE phone = ?",
        [from]
      );
      await sendText(wa, GREETING_MSG);
    }
    return;
  }

  // ── Si ya terminó, recordar ──
  if (user.state === "DONE") {
    await sendText(wa, "Para activarme solo envía un *hola* y con gusto te atenderé 🤖");
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
        await db.execute("UPDATE users SET chosen_option = 'a', state = 'DONE' WHERE phone = ?", [from]);
        await sendText(
          wa,
          `Te comparto el contacto de Andy Raso 📱\n\nEnvíale un mensaje para que te guarde en su agenda VIP.`
        );
        await sendContact(wa);
        await sendText(wa, farewellMsg(user.name));
      } else if (buttonId === "opt_portafolio") {
        // ── Opción B: Portafolio ──
        await db.execute("UPDATE users SET chosen_option = 'b', state = 'WAITING_WORK' WHERE phone = ?", [from]);
        await sendWorksList(db, wa);
      } else {
        await sendMainOptions(wa, "Por favor selecciona una de las opciones:");
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
        await db.execute("UPDATE users SET state = 'WAITING_MORE' WHERE phone = ?", [from]);
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
        await sendButtons(wa, "¿Te gustaría ver algún otro portafolio?", [
          { id: "more_yes", title: "✅ Sí" },
          { id: "more_no", title: "❌ No, gracias" },
        ]);
      }
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