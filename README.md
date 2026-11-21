

## Purpose
REST API for the RentEase equipment rental marketplace. It handles authentication, role-based access, equipment management, bookings, Stripe payments and dashboard analytics for owners, customers and admins.

## Live URL
https://rental-client-omega.vercel.app

## Key Features
- JWT authentication with custom middlewares: `verifyToken`, `verifyRenter`, `verifyOwner`, `verifyAdmin`
- Equipment CRUD with admin approval workflow (pending / approved / rejected)
- Server-side search, filtering (category, rental type, price, availability), sorting and pagination
- Favorites and customer reviews
- Booking with availability check across overlapping dates and total amount calculation
- Stripe Checkout integration; booking and payment records are created only after verified payment
- Admin analytics (users, equipment, bookings, pending approvals, completed rentals, revenue, monthly stats)
- Owner analytics (listed equipment, completed rentals, total and monthly earnings)
- Scheduled job (node-cron) that marks bookings as completed after the rental end date, with email notifications
- MongoDB credentials and all secrets are stored in environment variables

## npm Packages Used
- express
- cors
- dotenv
- mongodb
- jsonwebtoken
- stripe
- node-cron
- nodemailer

## Run Locally

npm install
npm run dev
