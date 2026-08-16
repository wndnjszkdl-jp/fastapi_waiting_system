const ROOMS = ["A", "B", "C"];

const connectionStatus = document.getElementById("connectionStatus");
const announcementMain = document.getElementById("announcementMain");
const announcementSub = document.getElementById("announcementSub");
const enableSoundButton = document.getElementById("enableSoundButton");
const fullscreenButton = document.getElementById("fullscreenButton");
const callOverlay = document.getElementById("callOverlay");

let socket = null;
let soundEnabled = localStorage.getItem("waitingSoundEnabled") === "true";
let audioContext = null;
let overlayTimer = null;

function updateSoundButton() {
  enableSoundButton.classList.toggle("enabled", soundEnabled);
  enableSoundButton.textContent = soundEnabled ? "🔊 소리 사용 중" : "🔇 소리 사용하기";
}

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
    document.getElementById(`current${room}`).textContent = data.current || "-";
    document.getElementById(`waiting${room}`).textContent = `대기 ${data.waiting}명`;
  });
}

function connectWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

  socket.addEventListener("open", () => {
    setConnectionStatus("connected");
    socket.send("display-connected");
  });

  socket.addEventListener("message", async (event) => {
    const message = JSON.parse(event.data);

    if (message.state) {
      renderState(message.state);
    }

    if (message.type === "call") {
      await handleCall(message.room, message.number);
    }

    if (message.type === "reset") {
      announcementMain.textContent = "호출을 기다리고 있습니다.";
      announcementSub.textContent = "번호가 호출되면 띵동 소리와 음성 안내가 재생됩니다.";
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

async function enableSound() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = audioContext || new AudioContextClass();

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    soundEnabled = true;
    localStorage.setItem("waitingSoundEnabled", "true");
    updateSoundButton();
    await playChime();
    speak("소리 안내가 켜졌습니다.");
  } catch (error) {
    console.error(error);
    alert("브라우저에서 소리를 사용할 수 없습니다. Chrome 또는 Edge를 사용해 주세요.");
  }
}

function playChime() {
  return new Promise((resolve) => {
    if (!soundEnabled) {
      resolve();
      return;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = audioContext || new AudioContextClass();

    const now = audioContext.currentTime;
    const master = audioContext.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.24, now + 0.02);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 1.08);
    master.connect(audioContext.destination);

    [
      [659.25, 0],
      [783.99, 0.25],
    ].forEach(([frequency, delay]) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();

      oscillator.type = "sine";
      oscillator.frequency.value = frequency;

      gain.gain.setValueAtTime(0.0001, now + delay);
      gain.gain.exponentialRampToValueAtTime(0.8, now + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.62);

      oscillator.connect(gain);
      gain.connect(master);
      oscillator.start(now + delay);
      oscillator.stop(now + delay + 0.66);
    });

    window.setTimeout(resolve, 1100);
  });
}

function speak(text) {
  if (!soundEnabled || !("speechSynthesis" in window)) {
    return;
  }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ko-KR";
  utterance.rate = 1.15;
  utterance.pitch = 1.35;
  utterance.volume = 1;

  const voices = window.speechSynthesis.getVoices();
  const koreanVoice = voices.find((voice) =>
    voice.lang && voice.lang.toLowerCase().startsWith("ko")
  );

  if (koreanVoice) {
    utterance.voice = koreanVoice;
  }

  window.speechSynthesis.speak(utterance);
}

function showOverlay(room, number) {
  document.getElementById("overlayRoom").textContent = `${room}방`;
  document.getElementById("overlayNumber").textContent = number;

  callOverlay.classList.add("show");
  callOverlay.setAttribute("aria-hidden", "false");

  window.clearTimeout(overlayTimer);
  overlayTimer = window.setTimeout(() => {
    callOverlay.classList.remove("show");
    callOverlay.setAttribute("aria-hidden", "true");
  }, 3500);
}

function numberToKorean(number) {
  const digits = ["", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];
  const units = ["", "십", "백", "천"];

  const value = Number(number);

  if (value === 0) {
    return "영";
  }

  let result = "";
  let remaining = value;
  let position = 0;

  while (remaining > 0) {
    const digit = remaining % 10;

    if (digit !== 0) {
      const digitText =
        digit === 1 && position > 0
          ? ""
          : digits[digit];

      result = digitText + units[position] + result;
    }

    remaining = Math.floor(remaining / 10);
    position++;
  }

  return result;
}

async function handleCall(room, number) {
  announcementMain.textContent = `${room}방 ${number}번 입장해 주세요`;
  announcementSub.textContent = `현재 ${room}방에서 ${number}번 대기자를 호출했습니다.`;

  const card = document.getElementById(`roomCard${room}`);
  card.classList.remove("calling");
  void card.offsetWidth;
  card.classList.add("calling");

  showOverlay(room, number);
  await playChime();
  window.setTimeout(() => {
   speak(`${room}방 ${numberToKorean(number)} 번, 들어오세요.`);
  }, 180);
}

enableSoundButton.addEventListener("click", enableSound);

fullscreenButton.addEventListener("click", async () => {
  if (!document.fullscreenElement) {
    await document.documentElement.requestFullscreen?.();
  } else {
    await document.exitFullscreen?.();
  }
});

updateSoundButton();
setConnectionStatus("connecting");
connectWebSocket();

fetch("/api/state")
  .then((response) => response.json())
  .then(renderState)
  .catch(console.error);
