require("dotenv").config();

const path = require("path");
const express = require("express");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const { Client } = require("@notionhq/client");

const app = express();
app.disable("x-powered-by");

const PORT = parseInt(process.env.PORT || "3000", 10);
const TIME_ZONE = process.env.TIME_ZONE || "Asia/Seoul";
const CACHE_SECONDS = Math.max(5, parseInt(process.env.CACHE_SECONDS || "30", 10));
const OPEN_HOUR = parseInt(process.env.OPEN_HOUR || "0", 10);
const CLOSE_HOUR = parseInt(process.env.CLOSE_HOUR || "24", 10);
const SLOT_MINUTES = parseInt(process.env.SLOT_MINUTES || "60", 10);
const MOCK_DATA = String(process.env.MOCK_DATA || "false").toLowerCase() === "true";
const KIOSK_PASSWORD = String(process.env.KIOSK_PASSWORD || "1234");

const ROOMS = (process.env.ROOMS || "A룸,B룸,세미나룸")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

// Notion room names can be grouped under one public room name.
// Format: "Notion name:Public name,Notion name:Public name"
const ROOM_ALIASES = new Map(
  (process.env.ROOM_ALIASES || "15인이하-세미나룸:세미나룸,6인이하-세미나룸:세미나룸")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separator = item.indexOf(":");
      if (separator === -1) return [item, item];
      return [item.slice(0, separator).trim(), item.slice(separator + 1).trim()];
    })
    .filter(([from, to]) => from && to)
);

const PROP_NAME = process.env.PROP_NAME || "업체명";
const PROP_ROOM = process.env.PROP_ROOM || "예약룸";
const PROP_DATE = process.env.PROP_DATE || "예약시간";

const notion = MOCK_DATA
  ? null
  : new Client({ auth: process.env.NOTION_TOKEN, notionVersion: "2026-03-11" });

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],

        // 사내 LAN에서는 HTTP를 사용하므로
        // CSS/JS를 HTTPS로 강제 변환하지 않도록 설정
        "upgrade-insecure-requests": null,
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

const kioskUnlockLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api", apiLimiter);
app.use(express.json({ limit: "20kb" }));

const cache = new Map();

function pad2(value) {
  return String(value).padStart(2, "0");
}

function getTodayParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const obj = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    year: Number(obj.year),
    month: Number(obj.month),
    day: Number(obj.day),
  };
}

function toDateKey(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function addDays(dateKey, amount) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + amount));
  return toDateKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function getTodayKey() {
  const today = getTodayParts();
  return toDateKey(today.year, today.month, today.day);
}

function isAllowedDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && date === getTodayKey();
}

function maskName(input) {
  const name = String(input || "").trim();
  const chars = Array.from(name);

  if (chars.length === 0) return "예약";
  if (chars.length === 1) return "*";
  if (chars.length === 2) return `${chars[0]}*`;

  return `${chars[0]}${"*".repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

function propertyText(prop) {
  if (!prop) return "";

  if (prop.type === "title") {
    return (prop.title || []).map((x) => x.plain_text || "").join("").trim();
  }
  if (prop.type === "rich_text") {
    return (prop.rich_text || []).map((x) => x.plain_text || "").join("").trim();
  }
  if (prop.type === "select") return prop.select?.name || "";
  if (prop.type === "status") return prop.status?.name || "";
  if (prop.type === "multi_select") return (prop.multi_select || []).map((x) => x.name).join(", ");
  if (prop.type === "number") return prop.number == null ? "" : String(prop.number);
  if (prop.type === "email") return prop.email || "";
  if (prop.type === "phone_number") return prop.phone_number || "";
  if (prop.type === "url") return prop.url || "";

  return "";
}

function parseNotionRow(row) {
  if (!row || row.object !== "page" || !row.properties) return null;

  const dateProp = row.properties[PROP_DATE];
  const date = dateProp?.type === "date" ? dateProp.date : null;
  if (!date?.start) return null;

  const notionRoom = propertyText(row.properties[PROP_ROOM]);
  const room = ROOM_ALIASES.get(notionRoom) || notionRoom;
  if (!ROOMS.includes(room)) return null;

  const maskedName = maskName(propertyText(row.properties[PROP_NAME]));

  return {
    room,
    start: date.start,
    end: date.end || date.start,
    customer: maskedName,
  };
}

function mockReservations(date) {
  if (date !== getTodayKey()) return [];

  return [
    { room: "A룸", start: `${date}T09:00:00+09:00`, end: `${date}T11:00:00+09:00`, customer: "김*수" },
    { room: "A룸", start: `${date}T12:00:00+09:00`, end: `${date}T14:00:00+09:00`, customer: "엔*****터" },
    { room: "A룸", start: `${date}T16:00:00+09:00`, end: `${date}T18:00:00+09:00`, customer: "박*현" },
    { room: "B룸", start: `${date}T10:00:00+09:00`, end: `${date}T12:00:00+09:00`, customer: "이*진" },
    { room: "B룸", start: `${date}T15:00:00+09:00`, end: `${date}T17:00:00+09:00`, customer: "그***그" },
    { room: "세미나룸", start: `${date}T11:00:00+09:00`, end: `${date}T13:00:00+09:00`, customer: "최*호" },
    { room: "세미나룸", start: `${date}T18:00:00+09:00`, end: `${date}T20:00:00+09:00`, customer: "정*아" },
  ].filter((item) => ROOMS.includes(item.room));
}

async function fetchAllForDate(date, { forceRefresh = false } = {}) {
  const key = `date:${date}`;
  const cached = cache.get(key);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.value;

  let sanitized;

  if (MOCK_DATA) {
    sanitized = mockReservations(date);
  } else {
    if (!process.env.NOTION_TOKEN || !process.env.NOTION_DATA_SOURCE_ID) {
      throw new Error("NOTION_TOKEN 또는 NOTION_DATA_SOURCE_ID가 설정되지 않았습니다.");
    }

    const nextDate = addDays(date, 1);
    const startBoundary = `${date}T00:00:00+09:00`;
    const endBoundary = `${nextDate}T00:00:00+09:00`;

    const rows = [];
    let cursor;

    do {
      const response = await notion.dataSources.query({
        data_source_id: process.env.NOTION_DATA_SOURCE_ID,
        page_size: 100,
        start_cursor: cursor,
        filter: {
          and: [
            {
              property: PROP_DATE,
              date: { on_or_after: startBoundary },
            },
            {
              property: PROP_DATE,
              date: { before: endBoundary },
            },
          ],
        },
        sorts: [
          {
            property: PROP_DATE,
            direction: "ascending",
          },
        ],
      });

      rows.push(...response.results);
      cursor = response.has_more ? response.next_cursor : undefined;
    } while (cursor);

    sanitized = rows.map(parseNotionRow).filter(Boolean);
  }

  cache.set(key, {
    expiresAt: Date.now() + CACHE_SECONDS * 1000,
    value: sanitized,
  });

  return sanitized;
}

function localDateTimeFromIso(iso) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));

  const obj = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    dateKey: `${obj.year}-${obj.month}-${obj.day}`,
    minutes: Number(obj.hour) * 60 + Number(obj.minute),
  };
}

function reservationMinuteOffset(iso, baseDate) {
  const local = localDateTimeFromIso(iso);
  if (local.dateKey === baseDate) return local.minutes;
  if (local.dateKey === addDays(baseDate, 1)) return 1440 + local.minutes;
  if (local.dateKey === addDays(baseDate, -1)) return local.minutes - 1440;
  return local.minutes;
}

function minutesFromHHMM(value) {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

function minutesToHHMM(total) {
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

function buildSlots(reservations, room, date) {
  const roomReservations = reservations.filter((r) => r.room === room);
  const slots = [];

  for (let cursor = OPEN_HOUR * 60; cursor < CLOSE_HOUR * 60; cursor += SLOT_MINUTES) {
    const slotEnd = Math.min(cursor + SLOT_MINUTES, CLOSE_HOUR * 60);
    const match = roomReservations.find((r) => {
      const start = reservationMinuteOffset(r.start, date);
      const end = reservationMinuteOffset(r.end, date);
      return start < slotEnd && end > cursor;
    });

    slots.push({
      start: minutesToHHMM(cursor),
      end: minutesToHHMM(slotEnd),
      available: !match,
      customer: match ? match.customer : null,
    });
  }

  return slots;
}

app.get("/api/config", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    today: getTodayKey(),
    rooms: ROOMS,
    slotMinutes: SLOT_MINUTES,
    openHour: OPEN_HOUR,
    closeHour: CLOSE_HOUR,
    mockMode: MOCK_DATA,
  });
});

app.get("/api/schedule-all", async (req, res) => {
  res.set("Cache-Control", "no-store");

  const date = String(req.query.date || "");

  if (!isAllowedDate(date)) {
    return res.status(400).json({ error: "조회 가능한 날짜가 아닙니다." });
  }

  try {
    const forceRefresh = String(req.query.refresh || "") === "1";
    const reservations = await fetchAllForDate(date, { forceRefresh });
    const schedules = Object.fromEntries(
      ROOMS.map((room) => [room, buildSlots(reservations, room, date)])
    );

    return res.json({
      date,
      rooms: ROOMS,
      schedules,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Schedule all API error:", error?.message || "unknown error");
    return res.status(500).json({ error: "예약 정보를 불러오지 못했습니다." });
  }
});

app.get("/api/schedule", async (req, res) => {
  res.set("Cache-Control", "no-store");

  const date = String(req.query.date || "");
  const room = String(req.query.room || "");

  if (!isAllowedDate(date)) {
    return res.status(400).json({ error: "조회 가능한 날짜가 아닙니다." });
  }

  if (!ROOMS.includes(room)) {
    return res.status(400).json({ error: "등록되지 않은 룸입니다." });
  }

  try {
    const forceRefresh = String(req.query.refresh || "") === "1";
    const reservations = await fetchAllForDate(date, { forceRefresh });
    const slots = buildSlots(reservations, room, date);

    return res.json({
      date,
      room,
      slots,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Schedule API error:", error?.message || "unknown error");
    return res.status(500).json({ error: "예약 정보를 불러오지 못했습니다." });
  }
});

app.post("/api/kiosk/unlock", kioskUnlockLimiter, (req, res) => {
  res.set("Cache-Control", "no-store");

  const password = String(req.body?.password || "");
  if (!password || password !== KIOSK_PASSWORD) {
    return res.status(401).json({ error: "비밀번호가 올바르지 않습니다." });
  }

  return res.json({ ok: true });
});

app.use(
  express.static(path.join(__dirname, "public"), {
    etag: true,
    maxAge: "10m",
  })
);

app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Reservation board: http://localhost:${PORT}`);
  console.log(`Mode: ${MOCK_DATA ? "MOCK" : "NOTION"}`);
  if (!process.env.KIOSK_PASSWORD) console.warn("KIOSK_PASSWORD가 없어 기본 비밀번호 1234를 사용 중입니다. 배포 전 반드시 변경하세요.");
});
