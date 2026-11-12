# FixMitra

**Reliable Home Services. Simplified.** A complete customer booking and operations platform with a premium responsive website, secure customer/admin authentication, persistent booking workflows, technician assignments, quotations, reviews and analytics.

## What is included

- Public homepage, services directory, service details, multi-step booking, booking success, secure tracking, About, Contact, Privacy and Terms.
- Customer registration/login, dashboard, owned-booking details, timeline, profile, password change and moderated feedback.
- Protected `/admin` console with overview analytics, paginated bookings, assignment/status history, technician management, service/category/image management, pricing, quotations, customers, reviews, reports/CSV and settings.
- Persistent SQLite database with relationships, indexes, unique booking references, idempotent submissions and persistent server-side sessions.
- 8 categories, 12 services, 10 fictional customers, 6 fictional technicians, 20 demo bookings, quotations, histories and labelled demonstration reviews.
- Local WebP images, responsive design, reduced-motion support, CSRF protection, rate limiting, CSP/security headers and scrypt password hashing.
- Dependency-free Node.js runtime (Node 24 built-ins), Dockerfile and Render Blueprint.

## Local setup

Requirements: **Node.js 24.x** and npm.

```bash
cp .env.example .env
# Export the values from .env in your shell, or set them in your hosting dashboard.
npm install
npm run build
ADMIN_EMAIL="admin@example.com" \
ADMIN_PASSWORD="use-a-strong-password-at-least-12-characters" \
SESSION_SECRET="use-at-least-32-random-characters" \
npm start
```

Open `http://localhost:3000`. There are **no default administrator credentials** in the source.

To create or rotate an admin without starting the server:

```bash
ADMIN_EMAIL="admin@example.com" \
ADMIN_PASSWORD="use-a-strong-password-at-least-12-characters" \
npm run setup-admin
```

## Render deployment

1. Create a new Git repository and push this project.
2. In Render, choose **New → Blueprint** and select the repository. Render reads `render.yaml`.
3. Enter `ADMIN_EMAIL` and a strong `ADMIN_PASSWORD` when Render requests the unsynced secrets. `SESSION_SECRET` is generated automatically.
4. Deploy. The Blueprint uses the Dockerfile, Node 24, a Starter web service and a **1 GB persistent disk** at `/var/data`.
5. After the first successful start, sign in at `/admin/login`. For tighter secret hygiene, you may remove `ADMIN_PASSWORD` from the service environment after the account has been created; the account remains on the persistent disk.
6. Configure a custom domain and TLS in Render if desired. The app uses secure cookies automatically in production.

### Persistence and backups

- Database: `/var/data/fixmitra.db`
- Uploaded service images: `/var/data/uploads`
- Do **not** deploy without the persistent disk; Render’s normal container filesystem is ephemeral.
- Back up the database file and uploads through Render’s disk/SSH tools before upgrades. SQLite WAL mode is enabled; use a SQLite-safe backup procedure or stop writes while copying.

## Business configuration

The seeded settings use:

- Business email: `Business@Supportfix.com`
- Service area: `Around Turkey`
- Currency: INR (₹), as required by the original product specification
- Mobile validation: 10-digit Indian format
- PIN validation: 6 digits

Sign in as an administrator and open **Settings** to add a verified phone, adjust hours or change the service area. The application deliberately shows unavailable states for maps, email delivery, WhatsApp and online payments until real provider credentials and integrations are added.

## Demo data

Seed data is fictional and labelled. Reset it from **Admin → Settings → Demo data** by typing `RESET DEMO`, or from the command line:

```bash
CONFIRM_RESET="RESET DEMO" npm run reset-demo
```

Real customer records are preserved by the reset. Demo customer passwords are randomized and never exposed. Create a real customer through `/register` for the customer journey.

## Useful routes

| Area | Route |
|---|---|
| Homepage | `/` |
| Services | `/services` |
| Booking | `/book` |
| Public tracking | `/track` |
| Customer login/dashboard | `/login`, `/dashboard` |
| Admin login/dashboard | `/admin/login`, `/admin` |

## Verification

```bash
npm run build
npm test
```

`npm run build` checks JavaScript syntax, required files, template includes and seed completeness. `npm test` executes public routes, protected-route redirects, customer registration, booking persistence, tracking privacy, admin login, quotation/assignment/status updates and CSRF rejection against a temporary database.

## Security notes

- Passwords use Node.js `scrypt` with unique random salts.
- Sessions are server-side and persisted in SQLite; cookies are HttpOnly, SameSite=Lax and Secure in production.
- Every mutation requires a per-session CSRF token.
- Admin and customer roles are checked server-side; booking details enforce customer ownership.
- SQL parameters are bound through Node’s SQLite prepared statements.
- Image uploads accept JPG, PNG or WebP up to 2 MB and use randomized file names.
- No public admin registration or frontend credential is present.

## Current integration limits

Email/WhatsApp delivery, payment processing and Google Maps are intentionally not active because no provider credentials were supplied. Contact forms, in-app notifications, quotations and tracking work without them. A real production launch should also add a privacy-retention policy, monitored backups, transactional-email provider, observability and user-acceptance testing with the final operating team.

## Visual assets

The included hero and service photographs were generated with Microsoft Copilot for this FixMitra build, then resized and compressed locally to WebP. Technician avatars are fictional local SVG assets.
