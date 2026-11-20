import "dotenv/config";
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import Stripe from "stripe";
import cron from "node-cron";
import { ObjectId } from "mongodb";
import { col } from "./db.js";
import { verifyToken, verifyRenter, verifyOwner, verifyAdmin, verifyOwnerOrAdmin } from "./middleware.js";
import { esc, calcTotal, sendMail } from "./utils.js";

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_missing");

const normalizeOrigin = (value) => (value || "").trim().replace(/\/+$/, "").toLowerCase();
const origins = (process.env.CLIENT_URL || "")
  .split(",")
  .map(normalizeOrigin)
  .filter(Boolean);

const isAllowedOrigin = (origin) => {
  const value = normalizeOrigin(origin);
  if (!value) return true; // same-origin, curl, server-to-server requests
  if (!origins.length) return true; // nothing configured: allow any client
  if (origins.includes(value)) return true;
  try {
    const { hostname, protocol } = new URL(value);
    if (protocol !== "https:" && protocol !== "http:") return false;
    // Allow local development and any Vercel deployment (production + previews)
    if (hostname === "localhost" || hostname === "127.0.0.1") return true;
    if (hostname === "vercel.app" || hostname.endsWith(".vercel.app")) return true;
  } catch {
    return false;
  }
  return false;
};

app.use(cors({
  origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204,
  maxAge: 86400,
}));
// Always answer preflight requests, even for disallowed origins (no CORS headers are added then).
app.options("*", (req, res) => res.sendStatus(204));
app.use(express.json());

const oid = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ message: e.message }); });
const DAY = 86400000;

app.get("/", (_, res) => res.send("Equipment Rental Server is running"));


app.post("/api/auth/jwt", wrap(async (req, res) => {
  const { email, name, photo } = req.body;
  if (!email) return res.status(400).json({ message: "email required" });
  const users = await col("users");
  const isAdmin = process.env.ADMIN_EMAIL && email === process.env.ADMIN_EMAIL;
  await users.updateOne(
    { email },
    {
      $setOnInsert: { email, role: isAdmin ? "admin" : "customer", phone: "", address: "", createdAt: new Date() },
      $set: { ...(name && { name }), ...(photo && { photo }) },
    },
    { upsert: true }
  );
  const user = await users.findOne({ email });
  if (isAdmin && user.role !== "admin") await users.updateOne({ email }, { $set: { role: "admin" } });
  const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { ...user, role: isAdmin ? "admin" : user.role } });
}));


app.get("/api/users/me", verifyToken, wrap(async (req, res) => {
  res.json(await (await col("users")).findOne({ email: req.user.email }));
}));
app.patch("/api/users/me", verifyToken, wrap(async (req, res) => {
  const { name, photo, phone, address } = req.body;
  await (await col("users")).updateOne({ email: req.user.email }, { $set: { name, photo, phone, address } });
  res.json({ success: true });
}));


app.get("/api/admin/users", verifyToken, verifyAdmin, wrap(async (_, res) => {
  res.json(await (await col("users")).find().sort({ createdAt: -1 }).toArray());
}));
app.patch("/api/admin/users/:id/role", verifyToken, verifyAdmin, wrap(async (req, res) => {
  const { role } = req.body;
  if (!["customer", "owner", "admin"].includes(role)) return res.status(400).json({ message: "Invalid role" });
  await (await col("users")).updateOne({ _id: oid(req.params.id) }, { $set: { role } });
  res.json({ success: true });
}));
app.delete("/api/admin/users/:id", verifyToken, verifyAdmin, wrap(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ message: "Cannot delete yourself" });
  await (await col("users")).deleteOne({ _id: oid(req.params.id) });
  res.json({ success: true });
}));


app.get("/api/equipment", wrap(async (req, res) => {
  const { q, category, rentalType, minPrice, maxPrice, availability, sort = "newest" } = req.query;
  const page = Math.max(1, +req.query.page || 1);
  const limit = Math.min(50, +req.query.limit || 9);
  const filter = { status: "approved" };
  if (q) { const r = new RegExp(esc(q), "i"); filter.$or = [{ name: r }, { location: r }, { category: r }]; }
  if (category && category !== "all") filter.category = category;
  if (rentalType && rentalType !== "all") filter.rentalType = rentalType;
  if (minPrice || maxPrice) filter.price = { ...(minPrice && { $gte: +minPrice }), ...(maxPrice && { $lte: +maxPrice }) };
  if (availability === "available") filter.quantity = { $gt: 0 };
  if (availability === "unavailable") filter.quantity = { $lte: 0 };
  const sortMap = { price_asc: { price: 1 }, price_desc: { price: -1 }, newest: { createdAt: -1 } };
  const eq = await col("equipment");
  const [items, total] = await Promise.all([
    eq.find(filter).sort(sortMap[sort] || sortMap.newest).skip((page - 1) * limit).limit(limit).toArray(),
    eq.countDocuments(filter),
  ]);
  res.json({ items, total, page, pages: Math.ceil(total / limit) });
}));
app.get("/api/equipment/featured", wrap(async (_, res) => {
  res.json(await (await col("equipment")).find({ status: "approved" }).sort({ createdAt: -1 }).limit(6).toArray());
}));
app.get("/api/categories", wrap(async (_, res) => {
  const base = ["Construction Equipment", "Photography Equipment", "Vehicles & Transportation", "Agriculture Equipment", "Electronics", "Event Equipment"];
  const agg = await (await col("equipment")).aggregate([{ $match: { status: "approved" } }, { $group: { _id: "$category", count: { $sum: 1 } } }]).toArray();
  const m = Object.fromEntries(agg.map((a) => [a._id, a.count]));
  res.json(base.map((name) => ({ name, count: m[name] || 0 })));
}));
app.get("/api/reviews", wrap(async (_, res) => {
  res.json(await (await col("reviews")).find().sort({ createdAt: -1 }).limit(12).toArray());
}));
app.post("/api/reviews", verifyToken, verifyRenter, wrap(async (req, res) => {
  const { rating, comment } = req.body;
  const r = { name: req.user.name, email: req.user.email, rating: Math.min(5, Math.max(1, +rating)), comment, createdAt: new Date() };
  await (await col("reviews")).insertOne(r);
  res.json(r);
}));


app.get("/api/equipment/:id", verifyToken, wrap(async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).json({ message: "Invalid id" });
  const item = await (await col("equipment")).findOne({ _id });
  if (!item) return res.status(404).json({ message: "Not found" });
  res.json(item);
}));


const pickEquipment = (b) => ({
  name: b.name, description: b.description, category: b.category, location: b.location,
  price: +b.price, rentalType: b.rentalType, quantity: +b.quantity, condition: b.condition,
  brand: b.brand, model: b.model, image: b.image, terms: b.terms,
});
app.post("/api/owner/equipment", verifyToken, verifyOwner, wrap(async (req, res) => {
  const u = await (await col("users")).findOne({ email: req.user.email });
  const doc = {
    ...pickEquipment(req.body), status: "pending", createdAt: new Date(),
    owner: { name: u.name, email: u.email, photo: u.photo || "", phone: u.phone || "" },
  };
  const r = await (await col("equipment")).insertOne(doc);
  res.json({ insertedId: r.insertedId });
}));
app.get("/api/owner/equipment", verifyToken, verifyOwner, wrap(async (req, res) => {
  res.json(await (await col("equipment")).find({ "owner.email": req.user.email }).sort({ createdAt: -1 }).toArray());
}));
app.put("/api/equipment/:id", verifyToken, verifyOwnerOrAdmin, wrap(async (req, res) => {
  const f = { _id: oid(req.params.id) };
  if (req.user.role === "owner") f["owner.email"] = req.user.email;
  const set = pickEquipment(req.body);
  if (req.user.role === "owner") set.status = "pending"; // re-review after edit
  const r = await (await col("equipment")).updateOne(f, { $set: set });
  r.matchedCount ? res.json({ success: true }) : res.status(404).json({ message: "Not found or not yours" });
}));
app.delete("/api/equipment/:id", verifyToken, verifyOwnerOrAdmin, wrap(async (req, res) => {
  const f = { _id: oid(req.params.id) };
  if (req.user.role === "owner") f["owner.email"] = req.user.email;
  const r = await (await col("equipment")).deleteOne(f);
  r.deletedCount ? res.json({ success: true }) : res.status(404).json({ message: "Not found or not yours" });
}));


app.get("/api/admin/equipment", verifyToken, verifyAdmin, wrap(async (_, res) => {
  res.json(await (await col("equipment")).find().sort({ createdAt: -1 }).toArray());
}));
app.patch("/api/admin/equipment/:id/status", verifyToken, verifyAdmin, wrap(async (req, res) => {
  const { status } = req.body;
  if (!["pending", "approved", "rejected"].includes(status)) return res.status(400).json({ message: "Invalid status" });
  await (await col("equipment")).updateOne({ _id: oid(req.params.id) }, { $set: { status } });
  res.json({ success: true });
}));


app.get("/api/favorites", verifyToken, verifyRenter, wrap(async (req, res) => {
  const favs = await (await col("favorites")).find({ userEmail: req.user.email }).toArray();
  const ids = favs.map((f) => oid(f.equipmentId)).filter(Boolean);
  const items = await (await col("equipment")).find({ _id: { $in: ids } }).toArray();
  res.json(items);
}));
app.get("/api/favorites/:equipmentId", verifyToken, verifyRenter, wrap(async (req, res) => {
  const f = await (await col("favorites")).findOne({ userEmail: req.user.email, equipmentId: req.params.equipmentId });
  res.json({ isFavorite: !!f });
}));
app.post("/api/favorites/:equipmentId", verifyToken, verifyRenter, wrap(async (req, res) => {
  await (await col("favorites")).updateOne(
    { userEmail: req.user.email, equipmentId: req.params.equipmentId },
    { $setOnInsert: { createdAt: new Date() } }, { upsert: true });
  res.json({ success: true });
}));
app.delete("/api/favorites/:equipmentId", verifyToken, verifyRenter, wrap(async (req, res) => {
  await (await col("favorites")).deleteOne({ userEmail: req.user.email, equipmentId: req.params.equipmentId });
  res.json({ success: true });
}));


async function availableQty(equipment, start, end) {
  const overlap = await (await col("bookings")).aggregate([
    { $match: { equipmentId: equipment._id.toString(), bookingStatus: "confirmed",
        startDate: { $lte: new Date(end) }, endDate: { $gte: new Date(start) } } },
    { $group: { _id: null, qty: { $sum: "$quantity" } } },
  ]).toArray();
  return equipment.quantity - (overlap[0]?.qty || 0);
}

app.post("/api/bookings/checkout", verifyToken, verifyRenter, wrap(async (req, res) => {
  const { equipmentId, startDate, endDate, quantity, phone, address, notes } = req.body;
  const eq = await (await col("equipment")).findOne({ _id: oid(equipmentId), status: "approved" });
  if (!eq) return res.status(404).json({ message: "Equipment not found" });
  const s = new Date(startDate), e = new Date(endDate), today = new Date(new Date().toDateString());
  if (isNaN(s) || isNaN(e) || s < today || e < s) return res.status(400).json({ message: "Invalid rental dates" });
  if (!(+quantity > 0)) return res.status(400).json({ message: "Invalid quantity" });
  const free = await availableQty(eq, startDate, endDate);
  if (+quantity > free) return res.status(409).json({ message: `Only ${Math.max(free, 0)} unit(s) available for these dates` });

  const total = calcTotal(eq, startDate, endDate, quantity);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: req.user.email,
    line_items: [{
      quantity: 1,
      price_data: { currency: "usd", unit_amount: Math.round(total * 100),
        product_data: { name: `${eq.name} (${quantity} × ${startDate} → ${endDate})`, ...(eq.image && { images: [eq.image] }) } },
    }],
    metadata: { equipmentId, startDate, endDate, quantity: String(quantity), phone: phone || "", address: address || "", notes: (notes || "").slice(0, 400), customerEmail: req.user.email, total: String(total) },
    success_url: `${origins[0] || "http://localhost:3000"}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origins[0] || "http://localhost:3000"}/equipment/${equipmentId}`,
  });
  res.json({ url: session.url, total });
}));

app.post("/api/payments/confirm", verifyToken, verifyRenter, wrap(async (req, res) => {
  const { sessionId } = req.body;
  const payments = await col("payments");
  const existing = await payments.findOne({ sessionId });
  if (existing) return res.json({ success: true, bookingId: existing.bookingId, alreadyProcessed: true });

  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.payment_status !== "paid") return res.status(402).json({ message: "Payment not completed" });
  const m = session.metadata;
  if (m.customerEmail !== req.user.email) return res.status(403).json({ message: "Session belongs to another user" });

  const eq = await (await col("equipment")).findOne({ _id: oid(m.equipmentId) });
  const u = await (await col("users")).findOne({ email: req.user.email });
  const booking = {
    equipmentId: m.equipmentId, equipmentName: eq.name, equipmentImage: eq.image,
    customer: { name: u.name, email: u.email, phone: m.phone, address: m.address },
    owner: eq.owner, startDate: new Date(m.startDate), endDate: new Date(m.endDate),
    quantity: +m.quantity, notes: m.notes, totalAmount: +m.total,
    paymentStatus: "paid", bookingStatus: "confirmed", createdAt: new Date(),
  };
  const b = await (await col("bookings")).insertOne(booking);
  try {
    await payments.insertOne({
      sessionId, bookingId: b.insertedId.toString(), transactionId: session.payment_intent,
      customerEmail: u.email, ownerEmail: eq.owner.email, amount: +m.total, currency: "usd",
      status: "paid", createdAt: new Date(),
    });
  } catch (err) { 
    if (err.code === 11000) { await (await col("bookings")).deleteOne({ _id: b.insertedId }); const p = await payments.findOne({ sessionId }); return res.json({ success: true, bookingId: p.bookingId }); }
    throw err;
  }
  res.json({ success: true, bookingId: b.insertedId });
}));


const paged = async (name, filter, req, res) => {
  const page = Math.max(1, +req.query.page || 1), limit = Math.min(50, +req.query.limit || 10);
  const c = await col(name);
  const [items, total] = await Promise.all([
    c.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
    c.countDocuments(filter),
  ]);
  res.json({ items, total, page, pages: Math.ceil(total / limit) });
};
app.get("/api/bookings/my", verifyToken, verifyRenter, wrap((req, res) => paged("bookings", { "customer.email": req.user.email }, req, res)));
app.get("/api/bookings/owner", verifyToken, verifyOwner, wrap((req, res) => paged("bookings", { "owner.email": req.user.email }, req, res)));
app.get("/api/admin/bookings", verifyToken, verifyAdmin, wrap((req, res) => paged("bookings", {}, req, res)));


const monthly = (field, extra = {}) => [
  { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } }, ...extra } },
  { $sort: { _id: 1 } }, { $project: { _id: 0, month: "$_id", ...Object.fromEntries(Object.keys(extra).map((k) => [k, 1])) } },
];
app.get("/api/analytics/admin", verifyToken, verifyAdmin, wrap(async (_, res) => {
  const [users, equipment, bookings, payments] = await Promise.all(["users", "equipment", "bookings", "payments"].map(col));
  const [totalUsers, totalEquipment, totalBookings, pendingApprovals, completedRentals, rev, monthlyBookings] = await Promise.all([
    users.countDocuments(), equipment.countDocuments(), bookings.countDocuments(),
    equipment.countDocuments({ status: "pending" }), bookings.countDocuments({ bookingStatus: "completed" }),
    payments.aggregate([{ $match: { status: "paid" } }, { $group: { _id: null, t: { $sum: "$amount" } } }]).toArray(),
    bookings.aggregate(monthly("createdAt", { bookings: { $sum: 1 }, revenue: { $sum: "$totalAmount" } })).toArray(),
  ]);
  res.json({ totalUsers, totalEquipment, totalBookings, pendingApprovals, completedRentals, totalRevenue: rev[0]?.t || 0, monthlyBookings });
}));
app.get("/api/analytics/owner", verifyToken, verifyOwner, wrap(async (req, res) => {
  const [equipment, bookings, payments] = await Promise.all(["equipment", "bookings", "payments"].map(col));
  const email = req.user.email;
  const [totalListed, completedRentals, totalRentals, earn, monthlyEarnings] = await Promise.all([
    equipment.countDocuments({ "owner.email": email }),
    bookings.countDocuments({ "owner.email": email, bookingStatus: "completed" }),
    bookings.countDocuments({ "owner.email": email }),
    payments.aggregate([{ $match: { ownerEmail: email, status: "paid" } }, { $group: { _id: null, t: { $sum: "$amount" } } }]).toArray(),
    payments.aggregate([{ $match: { ownerEmail: email, status: "paid" } }, ...monthly("createdAt", { earnings: { $sum: "$amount" }, rentals: { $sum: 1 } })]).toArray(),
  ]);
  res.json({ totalListed, completedRentals, totalRentals, totalEarnings: earn[0]?.t || 0, monthlyEarnings });
}));


export async function completeExpiredBookings() {
  const bookings = await col("bookings");
  const today = new Date(new Date().toDateString());
  const due = await bookings.find({ bookingStatus: "confirmed", endDate: { $lt: today } }).toArray();
  for (const b of due) {
    await bookings.updateOne({ _id: b._id }, { $set: { bookingStatus: "completed", completedAt: new Date() } });
    const html = (who) => `<h3>Rental completed</h3><p>Hi ${who}, the rental of <b>${b.equipmentName}</b> (${b.startDate.toDateString()} – ${b.endDate.toDateString()}) is now complete. Total: $${b.totalAmount}.</p>`;
    await sendMail(b.customer.email, "Your rental is completed", html(b.customer.name));
    await sendMail(b.owner.email, "A rental of your equipment is completed", html(b.owner.name));
  }
  return due.length;
}
cron.schedule("5 0 * * *", () => completeExpiredBookings().catch(console.error));

app.get("/api/cron/complete-bookings", wrap(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.JWT_SECRET}`) return res.status(401).end();
  res.json({ updated: await completeExpiredBookings() });
}));


app.use((req, res) => res.status(404).json({ message: "Route not found" }));
const port = process.env.PORT || 5000;
if (!process.env.VERCEL) app.listen(port, () => console.log(`Server on :${port}`));
export default app;
