import { MongoClient, ServerApiVersion } from "mongodb";

const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: { version: ServerApiVersion.v1, strict: false, deprecationErrors: true },
});
let db;
export async function getDB() {
  if (!db) {
    await client.connect();
    db = client.db(process.env.DB_NAME || "equipment_rental");
    await db.collection("users").createIndex({ email: 1 }, { unique: true });
    await db.collection("payments").createIndex({ sessionId: 1 }, { unique: true });
    await db.collection("favorites").createIndex({ userEmail: 1, equipmentId: 1 }, { unique: true });
  }
  return db;
}
export const col = async (name) => (await getDB()).collection(name);
