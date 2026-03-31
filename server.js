const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const razorpay = new Razorpay({
  key_id: "YOUR_KEY_ID",
  key_secret: "YOUR_SECRET"
});

const BOOKINGS_FILE = path.join(__dirname, "bookings.json");
const OTP_REQUESTS_FILE = path.join(__dirname, "pending-otps.json");
const PORT = Number(process.env.PORT) || 5000;
const OTP_TTL_MS = 5 * 60 * 1000;
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

function readJsonArray(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, "[]", "utf8");
      return [];
    }

    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error(`Failed to read ${path.basename(filePath)}:`, error);
    return [];
  }
}

function writeJsonArray(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function loadBookingsFromFile() {
  return readJsonArray(BOOKINGS_FILE);
}

function saveBookingsToFile(bookings) {
  writeJsonArray(BOOKINGS_FILE, bookings);
}

function loadOtpRequestsFromFile() {
  const now = Date.now();
  const requests = readJsonArray(OTP_REQUESTS_FILE).filter((request) =>
    new Date(request.expiresAt).getTime() > now
  );
  writeJsonArray(OTP_REQUESTS_FILE, requests);
  return requests;
}

function saveOtpRequestsToFile(requests) {
  writeJsonArray(OTP_REQUESTS_FILE, requests);
}

function buildBookingPayload(data) {
  return {
    console: String(data.console || "").toLowerCase(),
    date: String(data.date || ""),
    time: normalizeTimeValue(data.time),
    bookingType: String(data.bookingType || "book_for_later"),
    name: String(data.name || "").trim(),
    phone: String(data.phone || "").trim(),
    players: Number(data.players) || 1,
    controllers: Number(data.controllers) || 1,
    hours: Number(data.hours) || 1
  };
}

function getBookingPrice(hours, controllers) {
  return (
    Number(hours) * BASE_PRICE_PER_HOUR +
    Math.max(0, Number(controllers) - 1) * EXTRA_CONTROLLER_PRICE_PER_HOUR * Number(hours)
  );
}

function isBookingPayloadValid(payload) {
  return Boolean(
    payload.console &&
    payload.date &&
    payload.time &&
    payload.bookingType &&
    payload.name &&
    payload.phone &&
    payload.players > 0 &&
    payload.controllers >= payload.players &&
    payload.hours > 0
  );
}

function getOverlappingBookings(bookings, payload) {
  return bookings.filter((booking) => isBookingBlockingSlot(booking) && bookingsOverlap(booking, payload));
}

function getOverlappingOtpRequests(requests, payload) {
  return requests.filter((request) => bookingsOverlap(request, payload));
}

function getBookingEndTimestamp(booking) {
  if (booking.startedAt) {
    return new Date(booking.startedAt).getTime() + Number(booking.hours || 1) * 3600000;
  }

  return getEndDateTime(booking.date, booking.time, booking.hours).getTime();
}

function isBookingBlockingSlot(booking) {
  if (booking.vacatedAt) {
    return false;
  }

  return getBookingEndTimestamp(booking) > Date.now();
}

function getAvailablePsNumber(bookings, payload) {
  const usedPsNumbers = getOverlappingBookings(bookings, payload)
    .map((booking) => booking.psNumber)
    .filter(Boolean);

  return [1, 2, 3, 4, 5].find((number) => !usedPsNumbers.includes(number));
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function generateReceiptCode() {
  return `NSN-${crypto.randomInt(100000, 999999)}`;
}

function getCurrentBookingStart() {
  const now = new Date();
  now.setSeconds(0, 0);

  return {
    date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
    time: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`
  };
}

app.post("/request-otp", (req, res) => {
  const payload = buildBookingPayload(req.body);

  if (!isBookingPayloadValid(payload)) {
    return res.json({ success: false, message: "Invalid data" });
  }

  const bookings = loadBookingsFromFile();
  const overlappingBookings = getOverlappingBookings(bookings, payload);
  const otpRequests = loadOtpRequestsFromFile();
  const overlappingOtpRequests = getOverlappingOtpRequests(otpRequests, payload);

  if (overlappingBookings.length + overlappingOtpRequests.length >= 5) {
    return res.json({ success: false, message: "Slot Full" });
  }

  const filteredRequests = otpRequests.filter((request) => request.phone !== payload.phone);

  const otpRequest = {
    id: crypto.randomUUID(),
    otp: generateOtp(),
    expiresAt: new Date(Date.now() + OTP_TTL_MS).toISOString(),
    createdAt: new Date().toISOString(),
    price: getBookingPrice(payload.hours, payload.controllers),
    ...payload
  };

  filteredRequests.push(otpRequest);
  saveOtpRequestsToFile(filteredRequests);

  return res.json({
    success: true,
    otpToken: otpRequest.id,
    demoOtp: otpRequest.otp,
    expiresAt: otpRequest.expiresAt,
    message: "OTP generated"
  });
});

app.post("/verify-otp", (req, res) => {
  const otpToken = String(req.body.otpToken || "");
  const otp = String(req.body.otp || "").trim();
  const requests = loadOtpRequestsFromFile();
  const requestIndex = requests.findIndex((request) => request.id === otpToken);

  if (requestIndex === -1) {
    return res.json({ success: false, message: "OTP request expired or not found" });
  }

  const otpRequest = requests[requestIndex];
  const effectiveBooking =
    otpRequest.bookingType === "play_now"
      ? { ...otpRequest, ...getCurrentBookingStart() }
      : otpRequest;

  if (otpRequest.otp !== otp) {
    return res.json({ success: false, message: "Invalid OTP" });
  }

  const bookings = loadBookingsFromFile();
  const overlappingBookings = getOverlappingBookings(bookings, effectiveBooking);

  if (overlappingBookings.length >= 5) {
    const remainingRequests = requests.filter((request) => request.id !== otpToken);
    saveOtpRequestsToFile(remainingRequests);
    return res.json({ success: false, message: "Slot Full" });
  }

  const psNumber = getAvailablePsNumber(bookings, effectiveBooking);

  if (!psNumber) {
    const remainingRequests = requests.filter((request) => request.id !== otpToken);
    saveOtpRequestsToFile(remainingRequests);
    return res.json({ success: false, message: "No PS available for this overlapping time" });
  }

  const booking = {
    id: crypto.randomUUID(),
    name: effectiveBooking.name,
    phone: effectiveBooking.phone,
    console: effectiveBooking.console,
    date: effectiveBooking.date,
    time: effectiveBooking.time,
    bookingType: effectiveBooking.bookingType,
    players: effectiveBooking.players,
    controllers: effectiveBooking.controllers,
    hours: effectiveBooking.hours,
    price: getBookingPrice(effectiveBooking.hours, effectiveBooking.controllers),
    psNumber,
    receiptCode: generateReceiptCode(),
    checkedIn: false,
    startedAt: null,
    createdAt: new Date().toISOString()
  };

  bookings.push(booking);
  saveBookingsToFile(bookings);

  const remainingRequests = requests.filter((request) => request.id !== otpToken);
  saveOtpRequestsToFile(remainingRequests);

  console.log("Verified Booking:", booking);
  return res.json({ success: true, booking });
});

app.get("/bookings", (req, res) => {
  res.json(loadBookingsFromFile());
});

app.get("/slot-status", (req, res) => {
  const payload = buildBookingPayload(req.query);

  if (!payload.console || !payload.date || !payload.time) {
    return res.json({ success: false, message: "Missing slot details" });
  }

  const bookings = loadBookingsFromFile();
  const otpRequests = loadOtpRequestsFromFile();
  const confirmedCount = getOverlappingBookings(bookings, payload).length;
  const pendingCount = getOverlappingOtpRequests(otpRequests, payload).length;
  const totalCount = confirmedCount + pendingCount;

  return res.json({
    success: true,
    confirmedCount,
    pendingCount,
    totalCount,
    remainingCount: Math.max(0, 5 - totalCount),
    full: totalCount >= 5
  });
});

app.post("/verify-receipt", (req, res) => {
  const receiptCode = String(req.body.receiptCode || "").trim().toUpperCase();
  const bookings = loadBookingsFromFile();
  const bookingIndex = bookings.findIndex((booking) => booking.receiptCode === receiptCode);

  if (bookingIndex === -1) {
    return res.json({ success: false, message: "Receipt not found" });
  }

  bookings[bookingIndex].checkedIn = true;
  if (!bookings[bookingIndex].startedAt) {
    bookings[bookingIndex].startedAt = new Date().toISOString();
  }
  saveBookingsToFile(bookings);

  return res.json({ success: true, booking: bookings[bookingIndex] });
});

app.post("/vacate-booking", (req, res) => {
  const bookingId = String(req.body.bookingId || "");
  const bookings = loadBookingsFromFile();
  const bookingIndex = bookings.findIndex((booking) => booking.id === bookingId);

  if (bookingIndex === -1) {
    return res.json({ success: false, message: "Booking not found" });
  }

  bookings[bookingIndex].vacatedAt = new Date().toISOString();
  saveBookingsToFile(bookings);

  return res.json({ success: true, booking: bookings[bookingIndex] });
});

app.delete("/delete/:id", (req, res) => {
  const bookingId = req.params.id;
  const bookings = loadBookingsFromFile();
  const index = bookings.findIndex((booking) => booking.id === bookingId);

  if (index >= 0) {
    bookings.splice(index, 1);
    saveBookingsToFile(bookings);
    return res.json({ success: true });
  }

  return res.json({ success: false, message: "Invalid booking id" });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/booking", (req, res) => {
  res.sendFile(path.join(__dirname, "booking.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
