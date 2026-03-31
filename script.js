const API_BASE_URL = "http://localhost:5000";
let selectedConsole = "";
let slotPolling = null;
let activeOtpToken = "";
const BASE_PRICE_PER_HOUR = 100;
const EXTRA_CONTROLLER_PRICE_PER_HOUR = 40;

function normalizeTimeValue(value) {
  if (!value) return "";
  const parts = String(value).split(":");
  if (parts.length < 2) return "";
  return `${parts[0].padStart(2, "0")}:${parts[1].padStart(2, "0")}`;
}

function getDateTime(date, time) {
  return new Date(`${date}T${normalizeTimeValue(time)}:00`);
}

function getEndDateTime(date, time, hours) {
  return new Date(getDateTime(date, time).getTime() + Number(hours || 1) * 3600000);
}

function bookingsOverlap(a, b) {
  if (a.console !== b.console || a.date !== b.date) return false;

  const aStart = getDateTime(a.date, a.time).getTime();
  const aEnd = getEndDateTime(a.date, a.time, a.hours).getTime();
  const bStart = getDateTime(b.date, b.time).getTime();
  const bEnd = getEndDateTime(b.date, b.time, b.hours).getTime();

  return aStart < bEnd && bStart < aEnd;
}

function getBookingDraftKey() {
  return selectedConsole ? `bookingDraft:${selectedConsole}` : "bookingDraft";
}

function normalizeCurrentTime(date) {
  const normalized = new Date(date);
  normalized.setSeconds(0, 0);
  return normalized;
}

function formatDateValue(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatTimeValue(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function applyDateConstraints() {
  const dateInput = document.getElementById("date");
  if (!dateInput) return;

  dateInput.min = formatDateValue(new Date());
  if (dateInput.value && dateInput.value < dateInput.min) {
    dateInput.value = dateInput.min;
  }
}

function getActiveBookingDateTime() {
  const mode = document.getElementById("bookingMode")?.value || "now";

  if (mode === "later") {
    return {
      date: document.getElementById("date")?.value || "",
      time: normalizeTimeValue(document.getElementById("time")?.value || "")
    };
  }

  const now = normalizeCurrentTime(new Date());
  return {
    date: formatDateValue(now),
    time: formatTimeValue(now)
  };
}

function getBookingTypeLabel() {
  const mode = document.getElementById("bookingMode")?.value || "now";
  return mode === "now" ? "play_now" : "book_for_later";
}

function saveBookingDraft() {
  const bookingMode = document.getElementById("bookingMode")?.value || "now";
  const date = document.getElementById("date")?.value || "";
  const time = normalizeTimeValue(document.getElementById("time")?.value || "");
  const name = document.getElementById("name")?.value || "";
  const phone = document.getElementById("phone")?.value || "";
  const players = document.getElementById("players")?.value || "1";
  const controllers = document.getElementById("controllers")?.value || "1";
  const hours = document.getElementById("hours")?.value || "1";

  localStorage.setItem(
    getBookingDraftKey(),
    JSON.stringify({ bookingMode, date, time, name, phone, players, controllers, hours })
  );
}

function restoreBookingDraft() {
  const raw = localStorage.getItem(getBookingDraftKey());
  if (!raw) return;

  try {
    const draft = JSON.parse(raw);

    if (document.getElementById("bookingMode")) document.getElementById("bookingMode").value = draft.bookingMode || "now";
    if (document.getElementById("date")) document.getElementById("date").value = draft.date || "";
    if (document.getElementById("time")) document.getElementById("time").value = draft.time || "";
    if (document.getElementById("name")) document.getElementById("name").value = draft.name || "";
    if (document.getElementById("phone")) document.getElementById("phone").value = draft.phone || "";
    if (document.getElementById("players")) document.getElementById("players").value = draft.players || "1";
    if (document.getElementById("controllers")) document.getElementById("controllers").value = draft.controllers || "1";
    if (document.getElementById("hours")) document.getElementById("hours").value = draft.hours || "1";
  } catch (error) {
    console.error("Failed to restore booking draft", error);
  }
}

function clearBookingDraft() {
  localStorage.removeItem(getBookingDraftKey());
}

function attachDraftListeners() {
  ["bookingMode", "date", "time", "name", "phone", "players", "controllers", "hours"].forEach((id) => {
    const element = document.getElementById(id);
    if (!element) return;
    element.addEventListener("input", saveBookingDraft);
    element.addEventListener("change", saveBookingDraft);
  });
}

function syncControllersToPlayers() {
  const players = Number(document.getElementById("players")?.value || 1);
  const controllersSelect = document.getElementById("controllers");
  if (!controllersSelect) return;

  Array.from(controllersSelect.options).forEach((option) => {
    option.disabled = Number(option.value) < players;
  });

  if (Number(controllersSelect.value) < players) {
    controllersSelect.value = String(players);
  }
}

function handlePlayersChange() {
  syncControllersToPlayers();
  updatePriceDisplay();
  saveBookingDraft();
}

function handleBookingModeChange() {
  const mode = document.getElementById("bookingMode")?.value || "now";
  const scheduleFields = document.getElementById("scheduleFields");
  const playNowInfo = document.getElementById("playNowInfo");

  if (scheduleFields) scheduleFields.style.display = mode === "later" ? "block" : "none";

  if (playNowInfo) {
    if (mode === "now") {
      const slot = getActiveBookingDateTime();
      playNowInfo.innerText = `Current slot: ${slot.date} ${slot.time}`;
      playNowInfo.style.display = "block";
    } else {
      playNowInfo.style.display = "none";
    }
  }

  saveBookingDraft();
  checkSlots();
}

function updateConsoleHeading() {
  const title = document.getElementById("consoleName");
  if (title && selectedConsole) title.innerText = selectedConsole.toUpperCase();
}

function updateOtpPanel({ visible, demoOtp = "", message = "" }) {
  const panel = document.getElementById("otpPanel");
  const demoOtpText = document.getElementById("demoOtpText");
  const otpMessage = document.getElementById("otpMessage");
  if (!panel || !demoOtpText || !otpMessage) return;

  panel.style.display = visible ? "block" : "none";
  demoOtpText.innerText = demoOtp ? `Demo OTP: ${demoOtp}` : "";
  otpMessage.innerText = message;
}

function updatePriceDisplay() {
  const hours = Number(document.getElementById("hours")?.value || 1);
  const controllers = Number(document.getElementById("controllers")?.value || 1);
  const priceInfo = document.getElementById("priceInfo");
  if (!priceInfo) return;

  const totalPrice =
    (BASE_PRICE_PER_HOUR * hours) +
    (Math.max(0, controllers - 1) * EXTRA_CONTROLLER_PRICE_PER_HOUR * hours);

  priceInfo.innerText = `Price: Rs. ${totalPrice}`;
}

function setBookingActionState({ full, pendingOtp = false, remainingCount = 5 }) {
  const sendOtpButton = document.getElementById("sendOtpButton");
  const verifyOtpButton = document.getElementById("verifyOtpButton");

  if (sendOtpButton) {
    sendOtpButton.disabled = full;
    sendOtpButton.innerText = full ? "Slot Full" : "Send OTP";
  }

  if (verifyOtpButton && full && !pendingOtp) verifyOtpButton.disabled = true;
  else if (verifyOtpButton) verifyOtpButton.disabled = false;

  const slotMeta = document.getElementById("slotMeta");
  if (slotMeta) {
    slotMeta.innerText = full
      ? "All 5 PS systems are booked for this slot."
      : `${remainingCount} slot(s) remaining for this time.`;
  }
}

function showReceipt(booking) {
  const receiptCard = document.getElementById("receiptCard");
  const receiptDetails = document.getElementById("receiptDetails");
  if (!receiptCard || !receiptDetails) return;

  receiptDetails.innerHTML = `
    <strong>Receipt Code:</strong> ${booking.receiptCode}<br>
    <strong>Name:</strong> ${booking.name}<br>
    <strong>Console:</strong> ${booking.console.toUpperCase()}<br>
    <strong>PS Number:</strong> ${booking.psNumber}<br>
    <strong>Booking Type:</strong> ${booking.bookingType === "play_now" ? "Play Now" : "Book For Later"}<br>
    <strong>Players:</strong> ${booking.players}<br>
    <strong>Controllers:</strong> ${booking.controllers}<br>
    <strong>Date:</strong> ${booking.date}<br>
    <strong>Time:</strong> ${booking.time}<br>
    <strong>Hours:</strong> ${booking.hours}<br>
    <strong>Price:</strong> Rs. ${booking.price}
  `;
  receiptCard.style.display = "block";
}

async function getBookings() {
  const response = await fetch(`${API_BASE_URL}/bookings`);
  if (!response.ok) throw new Error("Failed to load bookings");
  return response.json();
}

async function getSlotStatus(date, time) {
  const hours = Number(document.getElementById("hours")?.value || 1);
  const query = new URLSearchParams({ console: selectedConsole, date, time, hours: String(hours) });
  const response = await fetch(`${API_BASE_URL}/slot-status?${query.toString()}`);

  if (response.ok) return response.json();

  const bookings = await getBookings();
  const payload = { console: selectedConsole, date, time, hours };
  const confirmedCount = bookings.filter((booking) => bookingsOverlap(booking, payload)).length;

  return {
    success: true,
    confirmedCount,
    pendingCount: 0,
    totalCount: confirmedCount,
    remainingCount: Math.max(0, 5 - confirmedCount),
    full: confirmedCount >= 5
  };
}

async function checkSlots() {
  const slotInfo = document.getElementById("slotInfo");
  const bookingMode = document.getElementById("bookingMode");
  if (!slotInfo || !selectedConsole || !bookingMode) return false;

  const { date, time } = getActiveBookingDateTime();

  if (!date || !time) {
    slotInfo.innerText = bookingMode.value === "later" ? "Slots: 0 / 5" : "Select booking details";
    return false;
  }

  try {
    const status = await getSlotStatus(date, time);
    const pendingText = status.pendingCount ? ` (${status.pendingCount} pending OTP)` : "";
    slotInfo.innerText = `Slots: ${status.totalCount} / 5${pendingText}${status.full ? " FULL" : ""}`;
    setBookingActionState({
      full: status.full,
      pendingOtp: Boolean(activeOtpToken),
      remainingCount: status.remainingCount
    });
    return status.full;
  } catch (error) {
    slotInfo.innerText = "Unable to check slots right now";
    setBookingActionState({ full: false, pendingOtp: Boolean(activeOtpToken), remainingCount: 5 });
    console.error(error);
    return false;
  }
}

async function requestOtp() {
  const isFull = await checkSlots();
  if (isFull) {
    alert("Slot already full");
    return;
  }

  const name = document.getElementById("name")?.value.trim();
  const phone = document.getElementById("phone")?.value.trim();
  const hours = Number(document.getElementById("hours")?.value || 1);
  const players = Number(document.getElementById("players")?.value || 1);
  const controllers = Number(document.getElementById("controllers")?.value || 1);
  const { date, time } = getActiveBookingDateTime();

  if (!name || !phone || !date || !time) {
    alert("Fill all details");
    return;
  }

  const response = await fetch(`${API_BASE_URL}/request-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      phone,
      hours,
      players,
      controllers,
      bookingType: getBookingTypeLabel(),
      console: selectedConsole,
      date,
      time
    })
  });

  const result = await response.json();

  if (!response.ok || !result.success) {
    alert(result.message || "Could not send OTP");
    return;
  }

  activeOtpToken = result.otpToken;
  updateOtpPanel({
    visible: true,
    demoOtp: result.demoOtp,
    message: `Demo OTP generated. It expires at ${new Date(result.expiresAt).toLocaleTimeString()}.`
  });
  updatePriceDisplay();
  await checkSlots();
  alert("OTP sent successfully (demo)");
}

async function verifyOtp() {
  const otp = document.getElementById("otp")?.value.trim();

  if (!activeOtpToken) {
    alert("Please request OTP first");
    return;
  }

  if (!otp) {
    alert("Enter OTP");
    return;
  }

  const response = await fetch(`${API_BASE_URL}/verify-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ otpToken: activeOtpToken, otp })
  });

  const result = await response.json();

  if (!response.ok || !result.success) {
    alert(result.message || "OTP verification failed");
    return;
  }

  activeOtpToken = "";
  clearBookingDraft();
  document.getElementById("otp").value = "";
  updateOtpPanel({ visible: false });
  showReceipt(result.booking);
  updatePriceDisplay();
  await checkSlots();
  alert(`Booking verified! Receipt: ${result.booking.receiptCode}`);
}

function goBack() {
  window.location.href = "index.html";
}

function goToBooking(type) {
  localStorage.removeItem(`bookingDraft:${type}`);
  localStorage.setItem("console", type);
  window.location.href = "booking.html";
}

function openAdmin() {
  const pass = prompt("Enter Admin Password");
  if (pass === "1234") window.location.href = "admin.html";
  else if (pass !== null) alert("Wrong password");
}

let clicks = 0;

function secretAdmin() {
  clicks += 1;
  if (clicks >= 5) {
    openAdmin();
    clicks = 0;
  }
}

window.addEventListener("load", () => {
  selectedConsole = localStorage.getItem("console") || "";
  updateConsoleHeading();

  const isBookingPage = Boolean(document.getElementById("date"));
  if (!isBookingPage) return;

  if (!selectedConsole) {
    alert("No console selected");
    window.location.href = "index.html";
    return;
  }

  restoreBookingDraft();
  applyDateConstraints();
  attachDraftListeners();
  syncControllersToPlayers();
  handleBookingModeChange();
  updatePriceDisplay();
  checkSlots();

  if (slotPolling) clearInterval(slotPolling);
  slotPolling = setInterval(checkSlots, 3000);
});
