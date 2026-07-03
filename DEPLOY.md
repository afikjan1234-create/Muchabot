# פריסה לענן — Render (חינם, בלי כרטיס אשראי)

הבוט רץ כ-Web Service חינמי ב-Render מתוך ה-`Dockerfile`.
בעיית ההרדמות של ה-tier החינומי (15 דקות חוסר פעילות) מטופלת בשתי שכבות:

1. **Self-ping מובנה** — הבוט מפנג את הכתובת הציבורית של עצמו כל 5 דקות
   (אוטומטי דרך `RENDER_EXTERNAL_URL`, לא דורש הגדרה).
2. **גיבוי ב-GitHub Actions** — ‏`.github/workflows/keepalive.yml` מפנג כל 14
   דקות (מכסה restart-ים). דורש הגדרת repo variable בשם `PING_URL`.

## מה כבר מוכן בקוד

- `Dockerfile` + `.dockerignore` — אריזת הבוט (Render בונה אוטומטית)
- `render.yaml` — הגדרת השירות (free, Frankfurt, health check על `/health`)
- הבוט קורא `PORT` מהסביבה — תואם ל-Render אוטומטית

## שלבי פריסה

1. **חשבון GitHub + העלאת הקוד** (בלי סודות — ‏`.env` ב-gitignore):
   ```powershell
   gh auth login          # התחברות חד-פעמית בדפדפן
   gh repo create restaurant-feedback-bot --private --source . --push
   ```

2. **חשבון Render**: הרשמה ב-render.com עם GitHub (ללא כרטיס אשראי).
   בזמן ההרשמה/יצירת שירות — לאשר ל-Render גישה ל-repo.

3. **יצירת השירות**: New + → Web Service → בחר את ה-repo →
   Render מזהה את ה-Dockerfile לבד → Plan: **Free** → Create.
   (או דרך Blueprint עם `render.yaml`.)

4. **משתני סביבה** (Environment בדשבורד של Render, או דרך ה-API):
   `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WEBHOOK_VERIFY_TOKEN`,
   `SUPABASE_URL`, `SUPABASE_KEY`, `ADMIN_KEY`, `GEMINI_API_KEY`
   (הערכים — מקובץ `.env` המקומי).

5. **עדכון ה-webhook ב-Meta** לכתובת החדשה:
   Callback URL: `https://<service>.onrender.com/webhook`,
   Verify token: כמו `WEBHOOK_VERIFY_TOKEN`.

6. **הפעלת פינגר הגיבוי**: ב-GitHub repo → Settings → Secrets and variables →
   Actions → Variables → New: `PING_URL` = `https://<service>.onrender.com/health`.

## מגבלות ה-tier החינמי שכדאי להכיר

- ~750 שעות מופע בחודש — מספיק לשירות אחד 24/7.
- restart-ים מדי פעם מצד הפלטפורמה — לא מזיק: התזמונים נשמרים
  ב-Supabase והמתזמן משלים שליחות שפוספסו ברגע שהוא עולה.
- בעתיד, בקנה מידה של כמה מסעדות: שדרוג ל-Starter‏ (7$/חודש) מבטל
  לגמרי את נושא ההרדמות.

## מעקב

לוגים: דשבורד Render → Service → Logs. דף ניהול: `https://<service>.onrender.com/admin`.
