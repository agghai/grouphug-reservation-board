// ✏️ Cloudflare Worker 주소 (대시보드에서 Worker 만든 뒤 나온 주소로 변경, 끝에 / 없이)
const API_BASE = "https://grouphug-reservation-api.aggh21-ai.workers.dev";
/**
 * Cloudflare API 호출 공통 함수
 * - API_BASE + path 로 요청
 * - JSON 파싱, 오류 메시지 통일, 15초 타임아웃
 */
async function callApi(path, { method = "GET", body, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: controller.signal,
    });

    let data = {};
    try {
      data = await response.json();
    } catch {
      // JSON이 아닌 응답
    }

    if (!response.ok) {
      const error = new Error(data.error || `요청에 실패했습니다. (${response.status})`);
      error.status = response.status;
      throw error;
    }

    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("서버 응답이 지연되고 있습니다. 잠시 후 다시 시도해주세요.");
    }
    if (error instanceof TypeError) {
      throw new Error("예약 서버에 연결할 수 없습니다. 네트워크를 확인해주세요.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const state = {
  rooms: [],
  selectedDate: null,
  mockMode: false,
};

const scheduleHead = document.querySelector("#scheduleHead");
const scheduleBody = document.querySelector("#scheduleBody");
const tableWrap = document.querySelector(".table-wrap");
const notice = document.querySelector("#notice");
const refreshButton = document.querySelector("#refreshButton");
const refreshStatus = document.querySelector("#refreshStatus");
const fullscreenButton = document.querySelector("#fullscreenButton");
const queryDate = document.querySelector("#queryDate");

let refreshTimer = null;

function formatDisplayDate(dateKey) {
  if (!dateKey) return "";

  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) return dateKey;

  const date = new Date(year, month - 1, day);

  const weekday = new Intl.DateTimeFormat("ko-KR", {
    weekday: "long",
  }).format(date);

  return `${year}년 ${month}월 ${day}일 ${weekday}`;
}

function renderQueryDate() {
  queryDate.textContent = formatDisplayDate(state.selectedDate);
}

function getKoreaNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    dateKey: `${values.year}-${values.month}-${values.day}`,
    minutes: Number(values.hour) * 60 + Number(values.minute),
  };
}

function minutesFromHHMM(value) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function renderHeader() {
  scheduleHead.innerHTML = '<th scope="col" class="time-heading">시간</th>';

  state.rooms.forEach((room) => {
    const th = document.createElement("th");
    th.scope = "col";
    th.className = "room-heading";
    th.textContent = room;
    scheduleHead.appendChild(th);
  });
}

function renderLoading() {
  const roomCount = Math.max(state.rooms.length, 1);

  scheduleBody.innerHTML = Array.from({ length: 24 })
    .map((_, index) => {
      const start = String(index).padStart(2, "0");
      const end = String(index + 1).padStart(2, "0");
      const cells = Array.from({ length: roomCount })
        .map(() => '<td class="status-cell"><span class="skeleton"></span></td>')
        .join("");

      return `
        <tr class="loading-row">
          <td class="time-cell">
            <span class="time-start">${start}:00</span>
            <span class="time-separator">–</span>
            <span class="time-end">${end}:00</span>
          </td>
          ${cells}
        </tr>`;
    })
    .join("");
}

function showNotice(message) {
  notice.textContent = message;
  notice.hidden = false;
}

function hideNotice() {
  notice.hidden = true;
  notice.textContent = "";
}

function setRefreshStatus(message) {
  refreshStatus.textContent = message;

  if (refreshTimer) clearTimeout(refreshTimer);

  if (message) {
    refreshTimer = setTimeout(() => {
      refreshStatus.textContent = "";
    }, 3000);
  }
}

function renderSchedule(schedules) {
  scheduleBody.innerHTML = "";

  const firstRoom = state.rooms[0];
  const baseSlots = schedules[firstRoom] || [];
  const now = getKoreaNow();
  const isToday = state.selectedDate === now.dateKey;

  baseSlots.forEach((baseSlot, index) => {
    const tr = document.createElement("tr");
    const endMinutes = minutesFromHHMM(baseSlot.end);
    const isPastSlot = isToday && endMinutes <= now.minutes;

    if (isPastSlot) tr.classList.add("past-slot");

    const timeTd = document.createElement("td");
    timeTd.className = "time-cell";

    const timeStart = document.createElement("span");
    timeStart.className = "time-start";
    timeStart.textContent = baseSlot.start;

    const separator = document.createElement("span");
    separator.className = "time-separator";
    separator.textContent = "–";

    const timeEnd = document.createElement("span");
    timeEnd.className = "time-end";
    timeEnd.textContent = baseSlot.end;

    timeTd.append(timeStart, separator, timeEnd);
    tr.appendChild(timeTd);

    state.rooms.forEach((room) => {
      const slot = schedules[room]?.[index];
      const td = document.createElement("td");
      td.className = "status-cell";

      if (!slot) {
        td.textContent = "—";
        td.classList.add("empty-cell");
      } else if (slot.available) {
        td.classList.add("available-cell");
        const status = document.createElement("span");
        status.className = "status-text available";
        status.textContent = "예약 가능";
        td.appendChild(status);
      } else {
        td.classList.add("reserved-cell");
        const customer = document.createElement("span");
        customer.className = "status-text customer";
        customer.textContent = slot.customer || "예약";
        td.appendChild(customer);
      }

      tr.appendChild(td);
    });

    scheduleBody.appendChild(tr);
  });
}

function scrollToCurrentTime() {
  const now = getKoreaNow();
  if (state.selectedDate !== now.dateKey) return;

  const rows = Array.from(scheduleBody.querySelectorAll("tr"));
  if (!rows.length) return;

  const currentHour = Math.floor(now.minutes / 60);
  const targetIndex = Math.max(0, Math.min(rows.length - 1, currentHour));
  const targetRow = rows[targetIndex];

  // 현재 행은 강조하지 않고, 화면 중간보다 약간 위에 오도록 표 영역만 이동한다.
  const top = Math.max(0, targetRow.offsetTop - tableWrap.clientHeight * 0.28);
  tableWrap.scrollTo({ top, behavior: "auto" });
}

async function loadSchedule({ forceRefresh = false } = {}) {
  if (!state.selectedDate) return;

  hideNotice();
  renderLoading();

  if (forceRefresh) {
    refreshButton.disabled = true;
    refreshButton.classList.add("is-loading");
    setRefreshStatus("예약 정보를 다시 불러오는 중...");
  }

  try {
    const params = new URLSearchParams({
      date: state.selectedDate,
    });

    if (forceRefresh) params.set("refresh", "1");

    const data = await callApi(`/api/schedule-all?${params.toString()}`);

    renderSchedule(data.schedules || {});
    requestAnimationFrame(scrollToCurrentTime);

    if (forceRefresh) {
      const now = new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date());
      setRefreshStatus(`${now} 갱신 완료`);
    }
  } catch (error) {
    scheduleBody.innerHTML = "";
    showNotice(error.message || "예약 정보를 불러오지 못했습니다.");
    if (forceRefresh) setRefreshStatus("갱신 실패");
  } finally {
    refreshButton.disabled = false;
    refreshButton.classList.remove("is-loading");
  }
}

function setFullscreenButtonState() {
  const text = fullscreenButton.querySelector(".control-text");
  const icon = fullscreenButton.querySelector(".control-icon");
  const isFullscreen = Boolean(document.fullscreenElement);

  text.textContent = isFullscreen ? "전체화면 종료" : "전체화면";
  icon.textContent = isFullscreen ? "↙" : "⛶";
  fullscreenButton.setAttribute("aria-label", isFullscreen ? "전체화면 종료" : "전체화면");
  fullscreenButton.setAttribute("title", isFullscreen ? "전체화면 종료" : "전체화면");
}

async function enterFullscreen() {
  try {
    await document.documentElement.requestFullscreen();
  } catch (error) {
    showNotice("이 브라우저에서는 전체화면을 시작할 수 없습니다.");
  }
}

function handleFullscreenButton() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    enterFullscreen();
  }
}

refreshButton.addEventListener("click", () => {
  loadSchedule({ forceRefresh: true });
});

fullscreenButton.addEventListener("click", handleFullscreenButton);

document.addEventListener("fullscreenchange", setFullscreenButtonState);

async function init() {
  try {
    const config = await callApi("/api/config");

    state.rooms = config.rooms || [];
    state.selectedDate = config.today || null;
    state.mockMode = Boolean(config.mockMode);

    renderHeader();
renderQueryDate();
    setFullscreenButtonState();

    await loadSchedule();
  } catch (error) {
    showNotice(error.message || "페이지를 초기화하지 못했습니다.");
  }
}

init();