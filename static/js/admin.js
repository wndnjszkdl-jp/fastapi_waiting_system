const ROOMS = ["A", "B", "C"];

const connectionStatus = document.getElementById("connectionStatus");
const toastContainer = document.getElementById("toastContainer");
const ticketModal = document.getElementById("ticketModal");
const closeTicketModal = document.getElementById("closeTicketModal");

let socket = null;

function setConnectionStatus(status) {
  connectionStatus.classList.remove("connected", "disconnected");

  if (status === "connected") {
    connectionStatus.classList.add("connected");
    connectionStatus.querySelector("span:last-child").textContent = "실시간 연결됨";
  } else if (status === "disconnected") {
    connectionStatus.classList.add("disconnected");
    connectionStatus.querySelector("span:last-child").textContent = "재연결 중";
  } else {
    connectionStatus.querySelector("span:last-child").textContent = "연결 중";
  }
}

function renderState(state) {
  ROOMS.forEach((room) => {
    const data = state.rooms[room];

    document.getElementById(`adminCurrent${room}`).textContent = data.current || "-";
    document.getElementById(`adminIssued${room}`).textContent = data.issued;
    document.getElementById(`adminWaiting${room}`).textContent = `${data.waiting}명`;

    document.getElementById(`manualCurrent${room}`).value = data.current;
    document.getElementById(`manualIssued${room}`).value = data.issued;
  });
}

function connectWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

  socket.addEventListener("open", () => {
    setConnectionStatus("connected");
    socket.send("admin-connected");
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.state) {
      renderState(message.state);
    }
  });

  socket.addEventListener("close", () => {
    setConnectionStatus("disconnected");
    window.setTimeout(connectWebSocket, 1500);
  });

  socket.addEventListener("error", () => {
    socket.close();
  });
}

function showToast(message, isError = false) {
  const toast = document.createElement("div");
  toast.className = `toast${isError ? " error" : ""}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 3000);
}

async function apiRequest(path, payload = null) {
  const options = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  };

  if (payload !== null) {
    options.body = JSON.stringify(payload);
  }

  const response = await fetch(path, options);
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.detail || "요청 처리 중 오류가 발생했습니다.");
  }

  return result;
}

function showTicket(room, number) {
  document.getElementById("ticketRoom").textContent = `${room}방`;
  document.getElementById("ticketNumber").textContent = number;
  ticketModal.classList.add("show");
  ticketModal.setAttribute("aria-hidden", "false");
}

async function handleAction(button) {
  const action = button.dataset.action;
  const room = button.dataset.room;

  button.disabled = true;

  try {
    let result;

    if (action === "ticket") {
      result = await apiRequest("/api/ticket", { room });
      showTicket(room, result.ticket.number);
      showToast(`${room}방 ${result.ticket.number}번 번호표를 발급했습니다.`);
    }

    if (action === "call") {
      result = await apiRequest("/api/call-next", { room });
      showToast(`${room}방 ${result.call.number}번을 호출했습니다.`);
    }

    if (action === "recall") {
      result = await apiRequest("/api/recall", { room });
      showToast(`${room}방 ${result.call.number}번을 재호출했습니다.`);
    }

    if (action === "undo") {
      result = await apiRequest("/api/undo", { room });
      showToast(`${room}방 호출 번호를 한 단계 되돌렸습니다.`);
    }

    if (action === "manual") {
      const current = Number(document.getElementById(`manualCurrent${room}`).value);
      const issued = Number(document.getElementById(`manualIssued${room}`).value);

      result = await apiRequest("/api/set-room", { room, current, issued });
      showToast(`${room}방 번호를 수정했습니다.`);
    }

    if (result?.state) {
      renderState(result.state);
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => handleAction(button));
});

document.getElementById("resetButton").addEventListener("click", async () => {
  const confirmed = window.confirm(
    "A·B·C방의 현재 번호와 발급 번호를 모두 0으로 초기화할까요?"
  );

  if (!confirmed) {
    return;
  }

  try {
    const result = await apiRequest("/api/reset");
    renderState(result.state);
    showToast("모든 번호를 초기화했습니다.");
  } catch (error) {
    showToast(error.message, true);
  }
});

document.getElementById("testCallButton").addEventListener("click", () => {
  showToast("대기 화면의 소리 테스트는 대기 화면에서 진행해 주세요.");
  window.open("/display", "_blank");
});

closeTicketModal.addEventListener("click", () => {
  ticketModal.classList.remove("show");
  ticketModal.setAttribute("aria-hidden", "true");
});

ticketModal.addEventListener("click", (event) => {
  if (event.target === ticketModal) {
    closeTicketModal.click();
  }
});

setConnectionStatus("connecting");
connectWebSocket();

fetch("/api/state")
  .then((response) => response.json())
  .then(renderState)
  .catch((error) => showToast(error.message, true));
