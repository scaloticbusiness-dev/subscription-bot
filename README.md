# Subscription Bot — Stripe → Discord → Google Sheets

Αυτόματο σύστημα που:
1. Δίνει τον ρόλο "winner" στο Discord όταν κάποιος πληρώνει μέσω Stripe
2. Καταγράφει/ενημερώνει τη γραμμή του στο Google Sheet (με σωστή Renewal Date: +30 ή +365 μέρες ανάλογα με το plan)
3. Κάθε μέρα ελέγχει ποιες συνδρομές έληξαν και αφαιρεί αυτόματα τον ρόλο

---

## 1. Πριν το deployment — ρύθμιση στο Stripe

Το πρόγραμμα διαβάζει το **Discord Username** του πελάτη από ένα custom field στο Checkout/Payment Link σου. Πρέπει να το προσθέσεις:

1. Stripe Dashboard → **Payment Links** → άνοιξε το κάθε link σου (Monthly & Yearly) → **Edit**
2. Στην ενότητα **"Collect additional information"**, πρόσθεσε ένα **custom field**:
   - Label: `Discord Username`
   - **Key: `discord_username`** (πρέπει να είναι ακριβώς αυτό, μικρά γράμματα, με κάτω παύλα)
   - Type: Text
   - Required: Yes
3. Αποθήκευσε και επανάλαβε για το δεύτερο Payment Link

Χωρίς αυτό, το πρόγραμμα δεν θα ξέρει σε ποιον να δώσει τον ρόλο στο Discord.

---

## 2. Deployment (Railway παράδειγμα)

1. Δημιούργησε λογαριασμό στο [railway.app](https://railway.app) (δωρεάν, μπορείς με GitHub/Google)
2. **New Project → Deploy from GitHub repo** (ή "Empty Project" και ανέβασε τα αρχεία χειροκίνητα αν δεν έχεις GitHub)
3. Στο **Variables** tab, πρόσθεσε όλα τα environment variables (δες `.env.example` παρακάτω για τη λίστα)
4. Το Railway θα κάνει αυτόματα `npm install` και `npm start`
5. Μόλις γίνει deploy, θα σου δώσει ένα δημόσιο URL (π.χ. `https://subscription-bot-production.up.railway.app`)

---

## 3. Environment Variables

Αντέγραψε το `.env.example` και συμπλήρωσε πραγματικές τιμές (στο Railway/Render αυτό γίνεται στο tab "Variables", όχι σε αρχείο):

| Μεταβλητή | Πού τη βρίσκεις |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe Dashboard → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | Θα το πάρεις στο Βήμα 4 παρακάτω |
| `DISCORD_BOT_TOKEN` | Discord Developer Portal → η εφαρμογή σου → Bot |
| `DISCORD_SERVER_ID` | Δεξί κλικ στο server όνομα → Copy Server ID |
| `DISCORD_ROLE_ID` | Δεξί κλικ στον ρόλο "winner" → Copy Role ID |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Όλο το περιεχόμενο του .json αρχείου που κατέβασες, σε μία γραμμή |
| `GOOGLE_SHEET_ID` | Από το URL του Sheet: `docs.google.com/spreadsheets/d/ΑΥΤΟ-ΕΔΩ/edit` |
| `GOOGLE_SHEET_NAME` | Όνομα του tab (π.χ. `Sheet1`) |
| `DAILY_CHECK_HOUR` | Ώρα (0-23, UTC) που τρέχει ο καθημερινός έλεγχος. Default: 9 |

---

## 4. Σύνδεση Webhook στο Stripe (κρίσιμο βήμα)

Το Stripe πρέπει να ξέρει να "χτυπάει" τον κώδικά σου όταν γίνεται πληρωμή:

1. Stripe Dashboard → **Developers → Webhooks → Add endpoint**
2. **Endpoint URL:** `https://ΤΟ-URL-ΣΟΥ-ΑΠΟ-RAILWAY/webhook/stripe`
3. **Events to send:** επίλεξε `checkout.session.completed`
4. Πάτα **Add endpoint**
5. Θα σου δείξει ένα **"Signing secret"** (ξεκινά με `whsec_...`) — αντέγραψέ το
6. Βάλε αυτό το secret ως `STRIPE_WEBHOOK_SECRET` στο Railway/Render και κάνε redeploy

---

## 5. Δοκιμή

- Άνοιξε `https://ΤΟ-URL-ΣΟΥ/health` στον browser — πρέπει να δεις `{"status":"ok",...}`
- Κάνε μια δοκιμαστική πληρωμή μέσω του Payment Link σου (ή χρησιμοποίησε Stripe test mode)
- Έλεγξε τα logs στο Railway/Render dashboard για να δεις αν όλα έτρεξαν σωστά
- Για να δοκιμάσεις το daily check χωρίς να περιμένεις: άνοιξε `https://ΤΟ-URL-ΣΟΥ/run-expiration-check`

---

## Δομή του project

```
subscription-bot/
├── index.js                          # Entry point: server + cron scheduler
├── routes/
│   └── stripeWebhook.js              # Δέχεται events από Stripe
├── jobs/
│   └── checkExpiredSubscriptions.js  # Καθημερινός έλεγχος ακυρώσεων
├── lib/
│   ├── discord.js                    # Discord REST API calls
│   ├── sheets.js                     # Google Sheets read/write
│   └── renewal.js                    # Υπολογισμός Renewal Date (30/365 μέρες)
├── package.json
└── .env.example
```

## Αν κάτι χαλάσει

Στείλε στο Claude:
- Το ακριβές μήνυμα σφάλματος από τα logs (Railway/Render dashboard → Logs tab)
- Τι έκανες όταν εμφανίστηκε το πρόβλημα

Το Claude θα διορθώσει τον κώδικα και θα σου δώσει το ενημερωμένο αρχείο για re-deploy.
