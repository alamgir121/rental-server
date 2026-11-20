import jwt from "jsonwebtoken";
import { col } from "./db.js";


export async function verifyToken(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!token) return res.status(401).json({ message: "Unauthorized: token missing" });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await (await col("users")).findOne({ email: decoded.email });
    if (!user) return res.status(401).json({ message: "Unauthorized: user not found" });
    req.user = { email: user.email, role: user.role, id: user._id.toString(), name: user.name };
    next();
  } catch {
    res.status(401).json({ message: "Unauthorized: invalid or expired token" });
  }
}
const roleGuard = (role) => (req, res, next) =>
  req.user?.role === role ? next() : res.status(403).json({ message: `Forbidden: ${role} only` });

export const verifyRenter = roleGuard("customer"); 
export const verifyCustomer = verifyRenter;
export const verifyOwner = roleGuard("owner");
export const verifyAdmin = roleGuard("admin");
export const verifyOwnerOrAdmin = (req, res, next) =>
  ["owner", "admin"].includes(req.user?.role) ? next() : res.status(403).json({ message: "Forbidden" });
