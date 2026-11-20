# Equipment Rental Platform — Server

**Purpose:** REST API for the Equipment Rental marketplace (owners list equipment, customers book & pay, admins moderate).
**Live URL:** _add after deploy_ · **Client repo:** _add_

## Key features
- JWT auth (`/api/auth/jwt`) + role middlewares: `verifyToken`, `verifyRenter`, `verifyOwner`, `verifyAdmin`
- Equipment CRUD with admin approval (pending / approved / rejected)
- Server-side search, filter (category, rental type, price, availability), sort, pagination
- Favorites, reviews, categories
- Booking with quantity-availability check across overlapping dates, total calculation
- Stripe Checkout → booking + payment record created after verified payment (idempotent)
- Admin & Owner analytics (aggregation pipelines)
- `node-cron` auto-completes expired bookings + email notifications (nodemailer)

## npm packages
express, cors, dotenv, mongodb, jsonwebtoken, stripe, node-cron, nodemailer

## Run
```
cp .env.example .env   # fill values
npm install
npm run dev
```
Admin: set `ADMIN_EMAIL` in `.env` — that email gets the admin role when it first logs in.
