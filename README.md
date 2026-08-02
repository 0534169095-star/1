# גלריית שמחת התורה

אתר גלריה פרטי המבוסס על GitHub Pages ו־Cloudflare בלבד. Firebase אינו נדרש להפעלת האתר.

## רכיבי המערכת

- `index.html` — ממשק הגלריה, המשתמשים והניהול.
- `cloudflare-client.js` — התחברות Google ישירה ושכבת הנתונים של D1.
- `cloudflare-worker.js` — API מאובטח, אימות Google, D1, R2, Drive, דוא״ל וחיפוש AI.
- `cloudflare-d1-schema.sql` — מבנה מסד הנתונים.
- `sw.js` ו־`manifest.webmanifest` — התקנה כאפליקציה ומטמון בסיסי.

## חיבור Cloudflare D1

1. ב־Cloudflare פתח **Storage & databases → D1 SQL database** וצור מסד בשם `simchas-gallery-db`.
2. פתח את המסד, עבור ל־**Console**, הדבק את תוכן `cloudflare-d1-schema.sql` והפעל אותו.
3. פתח את ה־Worker הקיים `simchas-gallery-api`.
4. תחת **Settings → Bindings** הוסף **D1 database binding** בשם המדויק `GALLERY_DB` ובחר את המסד שיצרת.
5. החלף את קוד ה־Worker בתוכן `cloudflare-worker.js` ופרוס.

יש להשאיר את חיבור R2 הקיים בשם `GALLERY_BUCKET`.

## משתנים וסודות ב־Worker

| שם | סוג | שימוש |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Text | מזהה לקוח Google; אם חסר, קיימת ברירת המחדל של האתר |
| `OPENAI_API_KEY` | Secret | חיפוש תמונות לפי תיאור |
| `RESEND_API_KEY` | Secret | שליחת דוא״ל מתוך הניהול |
| `EMAIL_FROM` | Text | כתובת שולח מאומתת |
| `GOOGLE_DRIVE_CLIENT_ID` | Text | חיבור Google Drive קבוע |
| `GOOGLE_DRIVE_CLIENT_SECRET` | Secret | סוד OAuth של Google Drive |
| `GOOGLE_DRIVE_REDIRECT_URI` | Text | כתובת החזרה של ה־Worker |
| `DRIVE_SITE_URL` | Text | כתובת אתר הגלריה |

המשתנים הישנים `FIREBASE_API_KEY`, `FIREBASE_PROJECT_ID` ו־`FIREBASE_APP_ID` אינם בשימוש וניתן למחוק אותם רק לאחר שהמעבר נבדק.

## פריסה

האתר מתפרסם אוטומטית מ־GitHub Pages לאחר עדכון ענף `main`. את ה־Worker יש לפרוס בנפרד מתוך Cloudflare.

לפני מעבר סופי מומלץ להוריד גיבוי JSON מממשק הניהול הישן, ולאחר חיבור D1 לשחזר אותו דרך מסך הגיבוי באתר. קובצי המדיה עצמם נשארים ב־R2.

## אבטחה והרשאות

- Google ID Token נבדק בשרת וגם מול מזהה הלקוח הנכון.
- משתמש חדש נוצר תמיד בדרגת `viewer` ובמצב `pending`; הוא אינו יכול לאשר את עצמו.
- מנהל־על בלבד יכול לשנות דרגות, לחסום משתמשים ולנהל את סל המחזור.
- סודות נשמרים רק במשתני Cloudflare ואינם נכנסים ל־GitHub.
