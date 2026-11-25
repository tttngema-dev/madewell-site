# Made Well sign-up / sign-in emails (do this once in the Supabase dashboard)

The website now asks people for a 6-digit code instead of a link. Two dashboard settings
make the email itself say "Made Well" and actually contain the code.

## 1. Email templates  (Authentication → Emails → Templates)
- "Confirm sign up": paste supabase-email/confirm-signup.html and use the subject written at the top of that file.
- "Magic Link":      paste supabase-email/sign-in-code.html  and use the subject written at the top of that file.
- "Reset Password":  paste supabase-email/reset-password.html and use the subject written at the top of that file. (Forgot password. Added in v15.)
All three show {{ .Token }} (the code). Do not put {{ .ConfirmationURL }} back in or people get a link again.
IMPORTANT: update these templates BEFORE deploying the new frontend, otherwise people get the old link email.

## 2. Sender name  (Authentication → Emails → SMTP Settings → enable Custom SMTP)
Until you do this the email always comes from "Supabase Auth". You already use Resend, so:
- Sender email : an address on your Resend-verified domain, e.g. no-reply@yourdomain.co.za
- Sender name  : Made Well
- Host         : smtp.resend.com     Port: 465
- Username     : resend              Password: your Resend API key
Save, then sign up with a test email to check it.

## 3. Optional (Authentication → Sign In / Providers → Email)
Email OTP expiration: 3600 seconds (1 hour) is the default; 600 (10 minutes) is tighter.
Code length is 6 by default; the website accepts 6 to 12 digits, so either setting works.
