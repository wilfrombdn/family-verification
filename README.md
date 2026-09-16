# Family Verify

Real-time mutual call verification for families. Defeats caller-ID spoofing and
voice-clone scams by proving that **two specific registered devices** are
live-participating in the same verification session — not just "someone
tapped a button somewhere."

## How it works

1. Someone creates a **Family Circle** and shares the 6-character code with
   relatives, who join with that code. Each device gets a private device ID
   stored in its browser (`localStorage`) — this is the thing that's
   actually being verified, not a phone number.
2. **Verify This Call**: during a phone call, either person opens the app
   and taps "Verify This Call." The server generates a random challenge
   (e.g. `BLUE TIGER 47`) and pushes it live to every device in the circle.
   Both people read it aloud and tap Confirm. If two different devices
   confirm within 10 seconds of each other, both screens turn green:
   "Verified: Wil & Dad actively confirmed this call." If not, it's red.
3. **They're Requesting Money**: if a call is asking for money, the
   recipient taps this, picks who the caller claims to be, and that
   person's phone instantly gets a full-screen prompt: "Are you currently
   asking [them] for money? YES / NO." A "NO" answer immediately turns the
   requester's screen red: "IDENTITY NOT VERIFIED — DO NOT SEND MONEY."

No design polish here on purpose — big buttons, big text, red/green/amber
states, nothing to misread under pressure.

## Run it locally right now (fastest way to test with two phones today)

You don't need to deploy anything to try this with your dad on the same
WiFi network:

```
npm install
npm start
```

Then find your computer's local IP address:

```
ipconfig          # look for "IPv4 Address", e.g. 192.168.1.42
```

On both phones (connected to the same WiFi), open a browser to:

```
http://192.168.1.42:3000
```

Add it to the home screen (Share → Add to Home Screen on iOS, or the
browser menu → Add to Home Screen on Android) so it behaves like an app
icon. This works great for testing, but only while your computer is on
and both phones are on the same network.

## Deploy it for real (permanent URL, works anywhere)

The easiest free option is **Render**:

1. Push this folder to a new GitHub repo (private is fine).
2. Go to [render.com](https://render.com), sign up free, click
   **New +** → **Web Service**, connect the repo.
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - Instance type: **Free**
4. Deploy. Render gives you a URL like
   `https://family-verify-xyz.onrender.com` — that's your permanent link.
   Open it on both phones and add to home screen.

Note: Render's free tier spins the server down after 15 minutes of
inactivity and takes ~30-60 seconds to wake back up on the next request —
fine for occasional use, just tap the app a few seconds before you
actually need it, or upgrade to a paid instance ($7/mo) for instant
wake if this becomes something you rely on regularly.

(Railway, Fly.io, and a $5/mo VPS all work the same way if you'd rather
use one of those instead.)

## Current limits of this prototype

- **Storage is a flat JSON file on the server**, not a real database —
  fine for one family, would need a real DB (Postgres/SQLite) to scale to
  many circles.
- **No login/password** — anyone with your circle code can join it.
  Treat the code like a house key: share it only with actual family,
  over a channel you trust (in person, or a call you already trust).
- **No fingerprint/Face ID gating yet** — the browser session itself is
  the "device," which is weaker than requiring a biometric per
  confirmation. Worth adding via `navigator.credentials` (WebAuthn) if
  this becomes something the family actually relies on.
- Two different people testing in the **same browser** will share
  `localStorage` and collide — test with two different browsers,
  incognito windows, or (ideally) two actual phones.
